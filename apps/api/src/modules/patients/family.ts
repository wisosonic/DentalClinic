import { Router } from 'express';
import { z } from 'zod';
import { STAFF_ROLES, familyLinkSchema, inverseRole, spouseRole, type FamilyMemberDto, type FamilyRelation, type FamilyRole } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { isUniqueError } from '../../lib/dbErrors';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { doctorScope, ownsPatient, type DoctorScope } from '../../lib/scope';
import { clinicNow } from '../../lib/time';
import { requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

/** How many relatives of a patient the person may see (the same people as the family list). */
export async function familyCount(ctx: AppContext, scope: DoctorScope, id: number): Promise<number> {
  const links: Row[] = await ctx.db('patient_relatives').where((q) => q.where('patient_id', id).orWhere('relative_id', id));
  const ids = links.map((l) => (l.patient_id === id ? l.relative_id : l.patient_id));
  if (!ids.length) return 0;
  const people: Row[] = await ctx.db('patients').whereIn('id', ids).whereNull('deleted_at').select('id', 'doctor_id');
  return people.filter((p) => ownsPatient(scope, p.doctor_id)).length;
}

/**
 * Family links, mounted at `/patients/:id/family`. Clinic staff only (a patient never sees them). Seeing the list needs
 * `patients:read`, linking and unlinking `patients:update`. A link never widens what someone may see: an external
 * specialist reaches only his own patients, so a relative who is not his is left out of his list, and he cannot link
 * to one (that patient answers 404, like the profile).
 */
export function familyRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router({ mergeParams: true });
  router.use(requireRole(...STAFF_ROLES));

  const visible = (scope: DoctorScope, row: Row | undefined) => !!row && !row.deleted_at && ownsPatient(scope, row.doctor_id);

  async function patientFor(scope: DoctorScope, id: number): Promise<Row> {
    const row = await db('patients').where({ id }).first();
    if (!visible(scope, row)) throw notFound('Patient not found');
    return row!;
  }

  /** The links of one patient from his side, with the people he may see. */
  async function membersOf(scope: DoctorScope, id: number, only?: number): Promise<FamilyMemberDto[]> {
    const links: Row[] = await db('patient_relatives').where((q) => q.where('patient_id', id).orWhere('relative_id', id)).orderBy('id');
    const otherOf = (l: Row) => (l.patient_id === id ? l.relative_id : l.patient_id);
    const wanted = links.filter((l) => only === undefined || l.id === only);
    const ids = wanted.map(otherOf);
    if (!ids.length) return [];
    const people = new Map<number, Row>((await db('patients').whereIn('id', ids).whereNull('deleted_at')).map((p: Row) => [p.id, p]));

    const today = clinicNow(env, ctx.clock()).date;
    const next = new Map<number, Row>();
    const upcoming: Row[] = await db('appointments').whereIn('patient_id', ids).whereNull('deleted_at').whereIn('status', ['pending', 'confirmed'])
      .where('date', '>=', today).orderBy([{ column: 'date' }, { column: 'time' }, { column: 'id' }]).select('id', 'patient_id', 'date', 'time');
    for (const a of upcoming) if (!next.has(a.patient_id)) next.set(a.patient_id, a);

    const out: FamilyMemberDto[] = [];
    for (const l of wanted) {
      const p = people.get(otherOf(l));
      if (!visible(scope, p)) continue;
      // Made as "relative is the patient's <relation>": from the relative's side the word turns round.
      const gender = p!.gender ? String(p!.gender).toLowerCase() : null;
      const relation: FamilyRole = l.patient_id === id ? (l.relation === 'spouse' ? spouseRole(gender) : (l.relation as FamilyRelation)) : inverseRole(l.relation as FamilyRelation, gender);
      const a = next.get(p!.id);
      out.push({
        linkId: l.id, patientId: p!.id, patientIdentifier: p!.patient_identifier, fname: p!.fname, lname: p!.lname, phone: p!.phone,
        dateOfBirth: p!.date_of_birth ?? null, gender, relation,
        lastVisit: p!.last_visit ?? null, nextAppointment: a ? { id: a.id, date: a.date, time: a.time } : null,
      });
    }
    return out;
  }

  router.get('/', requirePermission('patients:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const scope = await doctorScope(db, user);
    await patientFor(scope, id);
    await auditView(ctx, req, { user, action: 'patient.family.view', patientId: id });
    res.json({ data: await membersOf(scope, id) });
  });

  router.post('/', requirePermission('patients:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = familyLinkSchema.parse(req.body);
    const scope = await doctorScope(db, user);
    await patientFor(scope, id);
    if (input.relativeId === id) throw badRequest('SELF_LINK', 'A patient cannot be linked to themselves');
    await patientFor(scope, input.relativeId);
    // One link for a pair, whichever way round it was made.
    const existing = await db('patient_relatives')
      .where((q) => q.where({ patient_id: id, relative_id: input.relativeId }).orWhere({ patient_id: input.relativeId, relative_id: id })).first('id');
    if (existing) throw new HttpError(409, 'ALREADY_LINKED', 'These two patients are already linked. Remove the link first to change it.');
    const now = sqlNow();
    let linkId: number;
    try {
      linkId = (await db('patient_relatives').insert({ patient_id: id, relative_id: input.relativeId, relation: input.relation, created_by: user.id, created_at: now, updated_at: now }))[0]!;
    } catch (err) {
      if (isUniqueError(err)) throw new HttpError(409, 'ALREADY_LINKED', 'These two patients are already linked. Remove the link first to change it.');
      throw err;
    }
    await audit(ctx, req, { userId: user.id, action: 'patient.family.link', entity: 'patient', entityId: id, diff: { relativeId: input.relativeId, relation: input.relation } });
    res.status(201).json({ member: (await membersOf(scope, id, linkId))[0] });
  });

  router.delete('/:linkId', requirePermission('patients:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const linkId = idParam.parse(req.params.linkId);
    const scope = await doctorScope(db, user);
    await patientFor(scope, id);
    const link: Row | undefined = await db('patient_relatives').where({ id: linkId }).where((q) => q.where('patient_id', id).orWhere('relative_id', id)).first();
    if (!link) throw notFound('Family link not found');
    await patientFor(scope, link.patient_id === id ? link.relative_id : link.patient_id);
    await db('patient_relatives').where({ id: linkId }).del();
    await audit(ctx, req, { userId: user.id, action: 'patient.family.unlink', entity: 'patient', entityId: id, diff: { relativeId: link.patient_id === id ? link.relative_id : link.patient_id, relation: link.relation } });
    res.status(204).end();
  });

  return router;
}
