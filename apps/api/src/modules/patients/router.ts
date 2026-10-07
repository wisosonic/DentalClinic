import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { STAFF_ROLES, patientInputSchema, patientUpdateSchema, type PatientDto, type Paginated } from '@aya/shared';
import { hashPassword } from '../../lib/password';
import { generatePassword } from '../../lib/crypto';
import { patientLoginEmail, uniqueUsername, usernameBase } from '../../lib/username';
import { limiter } from '../../middleware/rateLimit';
import { assertPortalOn } from '../settings/operating';
import { clinicLetterhead } from '../finance/letterhead';
import { revokeAllForUser } from '../auth/session';
import { renderPatientCard } from './card';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { isUniqueError } from '../../lib/dbErrors';
import { assertPatientAccess } from '../../lib/ownership';
import { doctorScope, ownsPatient } from '../../lib/scope';
import { whereWords } from '../../lib/search';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';
import { appointmentQuery, toDtos } from '../appointments/service';
import { buildChart, buildTimeline } from '../visits/timeline';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  doctorId: z.coerce.number().int().positive().optional(),
  sort: z.enum(['name', 'phone', 'number', 'lastVisit', 'createdAt']).default('name'),
  order: z.enum(['asc', 'desc']).optional(),
});

const timelineQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const createQuery = z.object({ allowDuplicate: z.enum(['true', 'false']).optional() });
const cardBody = z.object({ reset: z.boolean().optional() }).strict();

export function toPatientDto(row: Row, user: AuthUser): PatientDto {
  return {
    id: row.id,
    patientIdentifier: row.patient_identifier,
    fname: row.fname,
    lname: row.lname,
    phone: row.phone,
    dateOfBirth: row.date_of_birth ?? null,
    gender: row.gender ? String(row.gender).toLowerCase() : null,
    email: row.email ?? null,
    address: row.address ?? null,
    lastVisit: row.last_visit ?? null,
    // Internal notes stay inside the clinic.
    ...(user.role !== 'patient' ? { description: row.description ?? null } : {}),
    doctorId: row.doctor_id ?? null,
    username: row.username ?? null,
    hasAccount: row.user_id != null,
    createdAt: row.created_at ?? null,
  };
}

const COLUMNS: Record<string, string> = {
  fname: 'fname', lname: 'lname', phone: 'phone', dateOfBirth: 'date_of_birth', gender: 'gender',
  email: 'email', address: 'address', description: 'description', doctorId: 'doctor_id',
};

export function patientsRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  const find = (id: number) => db('patients').where({ id }).whereNull('deleted_at').first();

  /**
   * An external specialist reaches only his own patients; any other patient is "not found", even
   * one whose appointment he treats (he sees that appointment and writes its report, not the profile).
   */
  async function findVisible(user: AuthUser, id: number) {
    const row = await find(id);
    if (!row || !ownsPatient(await doctorScope(db, user), row.doctor_id)) throw notFound('Patient not found');
    return row;
  }

  /** No login yet, a login whose first (card) password has not been changed, or a login in use. */
  async function loginStateOf(row: Row): Promise<'none' | 'waiting' | 'active'> {
    if (row.user_id == null) return 'none';
    const login = await db('users').where({ id: row.user_id }).first('change_password');
    return !login ? 'none' : login.change_password ? 'waiting' : 'active';
  }

  async function validateRefs(input: { doctorId?: number | null; dateOfBirth?: string | null }) {
    if (input.doctorId && !(await db('doctors').where({ id: input.doctorId }).first('id'))) {
      throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    }
    if (input.dateOfBirth) {
      const today = clinicNow(env, ctx.clock()).date;
      if (input.dateOfBirth > today) throw badRequest('INVALID_DATE_OF_BIRTH', 'Date of birth cannot be in the future');
      if (input.dateOfBirth < '1900-01-01') throw badRequest('INVALID_DATE_OF_BIRTH', 'Date of birth is too far in the past');
    }
  }

  // A patient's own record (the linked account), before /:id.
  router.get('/me', requireRole('patient'), async (req, res) => {
    await assertPortalOn(ctx);
    const user = requireUser(req);
    const row = await db('patients').where({ user_id: user.id }).whereNull('deleted_at').first();
    if (!row) throw notFound('No patient record is linked to this account');
    res.json({ patient: toPatientDto(row, user) });
  });

  // A patient's own appointment history with their reports (summary and prescriptions only).
  router.get('/me/timeline', requireRole('patient'), async (req, res) => {
    await assertPortalOn(ctx);
    const user = requireUser(req);
    const row = await db('patients').where({ user_id: user.id }).whereNull('deleted_at').first();
    if (!row) throw notFound('No patient record is linked to this account');
    res.json(await buildTimeline(db, user, row, timelineQuery.parse(req.query)));
  });

  router.get('/', requireRole(...STAFF_ROLES), requirePermission('patients:read'), async (req, res) => {
    const user = requireUser(req);
    const { page, pageSize, q, doctorId, sort, order } = listQuery.parse(req.query);
    const scope = await doctorScope(db, user);

    const base = db('patients').whereNull('deleted_at').modify((qb) => {
      if (doctorId) qb.where({ doctor_id: doctorId });
      if (scope.restricted) {
        if (scope.doctorId === null) qb.whereRaw('1 = 0');
        else qb.where({ doctor_id: scope.doctorId });
      }
      whereWords(qb, ['fname', 'lname', 'phone', 'patient_identifier'], q);
    });
    const total = Number((await base.clone().count({ n: '*' }).first())?.n ?? 0);

    const dir = order ?? (sort === 'lastVisit' || sort === 'createdAt' ? 'desc' : 'asc');
    const sorted = base.clone();
    if (sort === 'name') sorted.orderBy([{ column: 'lname', order: dir }, { column: 'fname', order: dir }, { column: 'id', order: dir }]);
    else {
      const column = { phone: 'phone', number: 'patient_identifier', lastVisit: 'last_visit', createdAt: 'created_at' }[sort];
      sorted.orderBy([{ column, order: dir }, { column: 'id', order: dir }]);
    }

    const rows = await sorted.limit(pageSize).offset((page - 1) * pageSize);
    const body: Paginated<PatientDto> = { data: rows.map((r: Row) => toPatientDto(r, user)), meta: { page, pageSize, total } };
    res.json(body);
  });

  router.post('/', requireRole(...STAFF_ROLES), requirePermission('patients:create'), async (req, res) => {
    const user = requireUser(req);
    const input = patientInputSchema.parse(req.body);
    const { allowDuplicate } = createQuery.parse(req.query);
    const scope = await doctorScope(db, user);
    if (scope.restricted) {
      if (scope.doctorId === null) throw forbidden('Your login is not linked to a doctor profile yet');
      if (input.doctorId && input.doctorId !== scope.doctorId) throw forbidden('A new patient can only be your own');
      input.doctorId = scope.doctorId; // he cannot create patients for other doctors
    }
    // Every patient has a primary doctor: he is who collects their payments and whose quotes they are.
    if (!input.doctorId) throw badRequest('DOCTOR_REQUIRED', 'Choose the patient’s primary doctor');
    await validateRefs(input);

    if (allowDuplicate !== 'true') {
      const twin = await db('patients')
        .whereNull('deleted_at')
        .whereRaw('LOWER(fname) = ? AND LOWER(lname) = ? AND phone = ?', [input.fname.toLowerCase(), input.lname.toLowerCase(), input.phone])
        .first('id');
      if (twin) {
        throw new HttpError(409, 'DUPLICATE_PATIENT', 'A patient with the same name and phone already exists', { existingId: twin.id });
      }
    }

    const now = sqlNow();
    const values = {
      fname: input.fname, lname: input.lname, phone: input.phone,
      date_of_birth: input.dateOfBirth ?? null, gender: input.gender ?? null, email: input.email ?? null,
      address: input.address ?? null, description: input.description ?? null, doctor_id: input.doctorId ?? null,
      created_at: now, updated_at: now,
    };

    // The identifier is random and 6 digits (as in the existing data); retry on the rare collision. The username
    // (made from the name, unique) is chosen again on each try, so two registrations at once cannot share one.
    let id: number | undefined;
    for (let attempt = 0; attempt < 10 && !id; attempt++) {
      try {
        const patient_identifier = String(randomInt(100000, 1000000));
        const username = await uniqueUsername(db, usernameBase(input.fname, input.lname, patient_identifier));
        [id] = (await db('patients').insert({ ...values, patient_identifier, username })) as number[];
      } catch (err) {
        if (!isUniqueError(err)) throw err;
      }
    }
    if (!id) throw new HttpError(500, 'IDENTIFIER_FAILED', 'Could not generate a patient number, please try again');

    await audit(ctx, req, { userId: user.id, action: 'patient.create', entity: 'patient', entityId: id });
    res.status(201).json({ patient: { ...toPatientDto((await find(id))!, user), loginState: 'none' } });
  });

  router.get('/:id', requirePermission('patients:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await assertPatientAccess(db, user, id);
    const row = await findVisible(user, id);
    await auditView(ctx, req, { user, action: 'patient.view', patientId: id });
    const dto = toPatientDto(row, user);
    if (user.role !== 'patient') dto.loginState = await loginStateOf(row);
    res.json({ patient: dto });
  });

  router.get('/:id/timeline', requirePermission('patients:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await assertPatientAccess(db, user, id);
    const row = await findVisible(user, id);
    await auditView(ctx, req, { user, action: 'patient.timeline.view', patientId: id });
    res.json(await buildTimeline(db, user, row, timelineQuery.parse(req.query)));
  });

  // The tooth history is clinical: clinic staff only, never the patient.
  router.get('/:id/chart', requireRole(...STAFF_ROLES), requirePermission('patients:read'), async (req, res) => {
    const user = requireUser(req);
    const row = await findVisible(user, idParam.parse(req.params.id));
    await auditView(ctx, req, { user, action: 'patient.chart.view', patientId: row.id });
    res.json({ data: await buildChart(db, user, row) });
  });

  router.patch('/:id', requireRole(...STAFF_ROLES), requirePermission('patients:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = patientUpdateSchema.parse(req.body);
    if (!Object.keys(input).length) throw badRequest('EMPTY_UPDATE', 'Nothing to update');
    await findVisible(user, id);
    // A specialist cannot hand his patient to another doctor, or take over someone else's.
    if ((await doctorScope(db, user)).restricted && input.doctorId !== undefined) throw forbidden('You cannot change the doctor of a patient');
    await validateRefs(input);

    const update: Record<string, unknown> = { updated_at: sqlNow() };
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) update[COLUMNS[key]!] = value;
    }
    await db('patients').where({ id }).update(update);

    // Field names only: the values are health data and don't belong in the log.
    await audit(ctx, req, { userId: user.id, action: 'patient.update', entity: 'patient', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ patient: toPatientDto((await find(id))!, user) });
  });

  // The patient card: creates the patient's login (their username and a first, temporary password) the first
  // time, or replaces the first password while it has not been changed. Once the patient has chosen their own
  // password, a new card needs `reset: true`, which replaces it and signs them out everywhere. The password is
  // on the printout only: the database keeps its hash, and neither the log nor any answer repeats it.
  router.post(
    '/:id/card', requireRole(...STAFF_ROLES), requirePermission('patients:update'),
    limiter(env, { windowMs: 60_000, limit: 30, message: 'Too many cards. Please wait a minute.' }),
    async (req, res) => {
      const user = requireUser(req);
      const id = idParam.parse(req.params.id);
      const body = cardBody.parse(req.body ?? {});
      const patient = await findVisible(user, id);

      let username: string | null = patient.username ?? null;
      if (!username) {
        username = await uniqueUsername(db, usernameBase(patient.fname, patient.lname, patient.patient_identifier)); // a record from before usernames
      }
      const login: Row | undefined = patient.user_id ? await db('users').where({ id: patient.user_id }).first() : undefined;
      if (login && !login.is_active) throw new HttpError(409, 'ACCOUNT_DISABLED', 'The patient’s login is switched off: an administrator can switch it on under Users');
      const reset = Boolean(login && !login.change_password);
      if (reset && !body.reset) throw new HttpError(409, 'PASSWORD_ALREADY_CHANGED', 'The patient has already chosen their own password');

      const password = generatePassword(12);
      const doctor: Row | undefined = patient.doctor_id ? await db('doctors').where({ id: patient.doctor_id }).first('fname', 'lname') : undefined;
      const pdf = await renderPatientCard(
        {
          clinic: await clinicLetterhead(db, id),
          patient: { name: `${patient.fname} ${patient.lname}`.trim(), number: patient.patient_identifier, dateOfBirth: patient.date_of_birth ?? null, phone: patient.phone ?? null, doctor: doctor ? `${doctor.fname} ${doctor.lname}`.trim() : null },
          username, password, signInUrl: env.APP_URL, issuedOn: clinicNow(env, ctx.clock()).date,
        },
        { compress: env.NODE_ENV !== 'test' },
      );

      const now = sqlNow();
      const hash = await hashPassword(password, env.BCRYPT_COST);
      await db.transaction(async (trx) => {
        if (!login) {
          const [userId] = (await trx('users').insert({
            name: `${patient.fname} ${patient.lname}`.trim(), email: patientLoginEmail(username!), username, password: hash, role: 'patient',
            change_password: true, is_active: true, created_at: now, updated_at: now,
          })) as number[];
          const linked = await trx('patients').where({ id }).whereNull('user_id').update({ user_id: userId, username, updated_at: now });
          if (!linked) throw new HttpError(409, 'CARD_CONFLICT', 'Someone else just made this patient a card: try again');
        } else {
          await trx('users').where({ id: login.id }).update({ password: hash, change_password: true, failed_logins: 0, locked_until: null, updated_at: now });
          if (!patient.username) await trx('patients').where({ id }).update({ username, updated_at: now });
        }
      });
      if (login) await revokeAllForUser(ctx, login.id); // an old card's password, or the patient's own, no longer signs anyone in

      await audit(ctx, req, { userId: user.id, action: 'patient.card', entity: 'patient', entityId: id, diff: { created: !login, reset } });
      res.status(200).set({
        'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="patient-card-${patient.patient_identifier}.pdf"`,
        'Cache-Control': 'private, no-store',
      }).send(pdf);
    },
  );

  // Soft delete: the patient goes to the Trash (admin only), with their visits and payments. Only an admin
  // can restore or erase them for good. A doctor can delete only patients he can see.
  router.delete('/:id', requireRole(...STAFF_ROLES), requirePermission('patients:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await findVisible(user, id);
    const now = sqlNow();
    const changed = await db('patients').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
    if (!changed) throw notFound('Patient not found');
    await audit(ctx, req, { userId: user.id, action: 'patient.delete', entity: 'patient', entityId: id });
    res.status(204).end();
  });

  router.get('/:id/appointments', requirePermission('appointments:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await assertPatientAccess(db, user, id);
    await findVisible(user, id);
    await auditView(ctx, req, { user, action: 'patient.appointments.view', patientId: id });
    const rows = await appointmentQuery(db).where('a.patient_id', id).orderBy([{ column: 'a.date', order: 'desc' }, { column: 'a.time', order: 'desc' }]).limit(500);
    res.json({ data: await toDtos(db, rows, { staff: user.role !== 'patient' }) });
  });

  return router;
}
