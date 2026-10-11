import { Router } from 'express';
import { z } from 'zod';
import {
  MAX_MEDICAL_ITEMS, MEDICAL_ITEM_KINDS, STAFF_ROLES, medicalItemSchema, medicalItemUpdateSchema, medicalProfileSchema,
  type AllergySeverity, type MedicalAlertsDto, type MedicalHistoryDto, type MedicalItemDto, type MedicalItemKind, type MedicalProfileDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { doctorScope, ownsPatient } from '../../lib/scope';
import { clinicNow } from '../../lib/time';
import { requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

/**
 * A patient's medical history, mounted at `/patients/:id/medical`: a profile (blood type, pregnancy, smoking, notes) and a
 * list of allergies, medical conditions, medications and past surgeries. Clinic staff only; patients never see it. A doctor
 * reaches it only for patients he may see in full (an external specialist treating another doctor's patient gets a 404,
 * like the profile). The activity log gets ids, kinds and field names only, never what the history says.
 */
export function medicalRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router({ mergeParams: true });
  router.use(requireRole(...STAFF_ROLES));

  async function visiblePatient(user: AuthUser, id: number): Promise<Row> {
    const row = await db('patients').where({ id }).whereNull('deleted_at').first('id', 'doctor_id');
    if (!row || !ownsPatient(await doctorScope(db, user), row.doctor_id)) throw notFound('Patient not found');
    return row;
  }

  const person = (id: number | null, name: string | null) => (id ? { id, name: name ?? '' } : null);

  const profileDto = (r: Row | undefined): MedicalProfileDto => ({
    bloodType: r?.blood_type ?? null, pregnancy: r?.pregnancy ?? null, smoking: r?.smoking ?? null, notes: r?.notes ?? null,
    reviewedAt: r?.reviewed_at ?? null, reviewedBy: person(r?.reviewed_by ?? null, r?.reviewer_name ?? null),
    updatedAt: r?.updated_at ?? null, updatedBy: person(r?.updated_by ?? null, r?.updater_name ?? null),
  });
  const profileRow = (patientId: number): Promise<Row | undefined> =>
    db('patient_medical as m').leftJoin('users as r', 'r.id', 'm.reviewed_by').leftJoin('users as u', 'u.id', 'm.updated_by')
      .where('m.patient_id', patientId).first('m.*', 'r.name as reviewer_name', 'u.name as updater_name');

  const itemDto = (r: Row): MedicalItemDto => ({
    id: r.id, kind: r.kind, name: r.name, severity: r.severity ?? null, note: r.note ?? null, since: r.since ?? null, active: !!r.active,
    updatedBy: person(r.updated_by ?? null, r.u_name ?? null), updatedAt: r.updated_at ?? null,
  });
  const itemRows = (patientId: number): Promise<Row[]> =>
    db('patient_medical_items as i').leftJoin('users as u', 'u.id', 'i.updated_by').where('i.patient_id', patientId).select('i.*', 'u.name as u_name');

  const SEVERITY_RANK: Record<string, number> = { severe: 0, moderate: 1, mild: 2 };
  /** Allergies first, then conditions, medications, surgeries; current before past; the severe first; then by name. */
  const ordered = (rows: Row[]) => [...rows].sort((a, b) =>
    MEDICAL_ITEM_KINDS.indexOf(a.kind as MedicalItemKind) - MEDICAL_ITEM_KINDS.indexOf(b.kind as MedicalItemKind)
    || Number(!!b.active) - Number(!!a.active)
    || (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
    || String(a.name).localeCompare(String(b.name)) || a.id - b.id);

  /** "Since" cannot be in the future: compared as far as the person wrote it (a year, a month or a day). */
  function checkSince(since: string | null | undefined) {
    if (!since) return;
    const today = clinicNow(env, ctx.clock()).date;
    if (since > today.slice(0, since.length)) throw badRequest('INVALID_SINCE', 'That date is in the future');
  }

  router.get('/', requirePermission('medical:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await visiblePatient(user, id);
    await auditView(ctx, req, { user, action: 'patient.medical.view', patientId: id });
    const body: MedicalHistoryDto = { profile: profileDto(await profileRow(id)), items: ordered(await itemRows(id)).map(itemDto) };
    res.json(body);
  });

  // The short version for the warning on other screens: current allergies (the severe first), current conditions, pregnancy.
  router.get('/alerts', requirePermission('medical:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await visiblePatient(user, id);
    await auditView(ctx, req, { user, action: 'patient.medical.view', patientId: id });
    const profile = await db('patient_medical').where({ patient_id: id }).first('pregnancy');
    const items = ordered(await itemRows(id));
    const body: MedicalAlertsDto = {
      recorded: !!profile || items.length > 0,
      allergies: items.filter((i) => i.kind === 'allergy' && i.active).map((i) => ({ name: i.name, severity: (i.severity as AllergySeverity | null) ?? null })),
      conditions: items.filter((i) => i.kind === 'condition' && i.active).map((i) => i.name),
      pregnant: profile?.pregnancy === 'yes',
    };
    res.json(body);
  });

  router.patch('/profile', requirePermission('medical:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = medicalProfileSchema.parse(req.body);
    await visiblePatient(user, id);
    const now = sqlNow();
    const values = {
      ...(input.bloodType !== undefined && { blood_type: input.bloodType }), ...(input.pregnancy !== undefined && { pregnancy: input.pregnancy }),
      ...(input.smoking !== undefined && { smoking: input.smoking }), ...(input.notes !== undefined && { notes: input.notes }),
      updated_by: user.id, updated_at: now,
    };
    const changed = await db('patient_medical').where({ patient_id: id }).update(values);
    if (!changed) await db('patient_medical').insert({ patient_id: id, ...values, created_at: now });
    await audit(ctx, req, { userId: user.id, action: 'patient.medical.profile', entity: 'patient', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ profile: profileDto(await profileRow(id)) });
  });

  // "I went through the history with the patient today": a date and a name, so staff can see how fresh it is.
  router.post('/review', requirePermission('medical:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await visiblePatient(user, id);
    const now = sqlNow();
    const changed = await db('patient_medical').where({ patient_id: id }).update({ reviewed_at: now, reviewed_by: user.id, updated_at: now });
    if (!changed) await db('patient_medical').insert({ patient_id: id, reviewed_at: now, reviewed_by: user.id, created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'patient.medical.review', entity: 'patient', entityId: id });
    res.json({ profile: profileDto(await profileRow(id)) });
  });

  router.post('/items', requirePermission('medical:create'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = medicalItemSchema.parse(req.body);
    await visiblePatient(user, id);
    checkSince(input.since);
    const count = Number((await db('patient_medical_items').where({ patient_id: id }).count({ n: '*' }).first())?.n ?? 0);
    if (count >= MAX_MEDICAL_ITEMS) throw new HttpError(409, 'TOO_MANY_MEDICAL_ITEMS', 'This history has as many entries as it can hold', { max: MAX_MEDICAL_ITEMS });
    const now = sqlNow();
    const [itemId] = await db('patient_medical_items').insert({
      patient_id: id, kind: input.kind, name: input.name, severity: input.severity ?? null, note: input.note ?? null, since: input.since ?? null,
      active: input.active ?? true, created_by: user.id, updated_by: user.id, created_at: now, updated_at: now,
    });
    await audit(ctx, req, { userId: user.id, action: 'patient.medical.item.add', entity: 'patient', entityId: id, diff: { itemId, kind: input.kind } });
    res.status(201).json({ item: itemDto(await itemRows(id).then((rows) => rows.find((r) => r.id === itemId)!)) });
  });

  async function itemOf(user: AuthUser, patientId: number, itemId: number): Promise<Row> {
    await visiblePatient(user, patientId);
    const row: Row | undefined = await db('patient_medical_items').where({ id: itemId, patient_id: patientId }).first();
    if (!row) throw notFound('Medical history entry not found');
    return row;
  }

  router.patch('/items/:itemId', requirePermission('medical:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const itemId = idParam.parse(req.params.itemId);
    const input = medicalItemUpdateSchema.parse(req.body);
    const row = await itemOf(user, id, itemId);
    if (input.severity && row.kind !== 'allergy') throw badRequest('INVALID_SEVERITY', 'Severity is for allergies only');
    checkSince(input.since);
    await db('patient_medical_items').where({ id: itemId }).update({
      ...(input.name !== undefined && { name: input.name }), ...(input.severity !== undefined && { severity: input.severity }),
      ...(input.note !== undefined && { note: input.note }), ...(input.since !== undefined && { since: input.since }),
      ...(input.active !== undefined && { active: input.active }), updated_by: user.id, updated_at: sqlNow(),
    });
    await audit(ctx, req, { userId: user.id, action: 'patient.medical.item.update', entity: 'patient', entityId: id, diff: { itemId, fields: Object.keys(input) } });
    res.json({ item: itemDto((await itemRows(id)).find((r) => r.id === itemId)!) });
  });

  router.delete('/items/:itemId', requirePermission('medical:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const itemId = idParam.parse(req.params.itemId);
    const row = await itemOf(user, id, itemId);
    await db('patient_medical_items').where({ id: itemId }).del();
    await audit(ctx, req, { userId: user.id, action: 'patient.medical.item.delete', entity: 'patient', entityId: id, diff: { itemId, kind: row.kind } });
    res.status(204).end();
  });

  return router;
}
