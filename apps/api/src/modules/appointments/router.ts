import { Router } from 'express';
import { z } from 'zod';
import {
  APPOINTMENT_STATUSES,
  appointmentCategoriesSchema,
  appointmentInputSchema,
  appointmentTeethSchema,
  appointmentUpdateSchema,
  dateSchema,
  type AppointmentDto,
  type AppointmentStatus,
  type Paginated,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { can } from '../../lib/permissions';
import { canManageAppointment, doctorScope, involvedIn, ownsPatient } from '../../lib/scope';
import { whereWords } from '../../lib/search';
import { clinicNow, hoursUntil } from '../../lib/time';
import { requireAuth, requirePermission, requireUser, type AuthUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';
import { appointmentBooked, appointmentCancelled, appointmentNoShow } from '../notifications/events';
import { syncOffersForAppointment } from '../offers/service';
import { assertPortalOn, operating } from '../settings/operating';
import { appointmentQuery, assertBookable, assertClinicExists, getBusy, toDtos } from './service';

const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  patientId: z.coerce.number().int().positive().optional(),
  doctorId: z.coerce.number().int().positive().optional(),
  clinicId: z.coerce.number().int().positive().optional(),
  unitId: z.coerce.number().int().positive().optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(APPOINTMENT_STATUSES)).optional()),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['date', 'time', 'patient', 'doctor', 'unit', 'status', 'report']).default('date'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// Whatever column is chosen, ties fall back to date, time and id so pages never overlap.
function appointmentOrder(sort: string, order: 'asc' | 'desc') {
  const first: Record<string, string[]> = {
    date: [], time: ['a.time', 'a.date'], patient: ['p.lname', 'p.fname'], doctor: ['d.lname', 'd.fname'], unit: ['u.name'], status: ['a.status'], report: ['has_report'],
  };
  const columns = [...(first[sort] ?? []), 'a.date', 'a.time', 'a.id'];
  return [...new Set(columns)].map((column) => ({ column, order }));
}

const busyQuery = z.object({
  doctorId: z.coerce.number().int().positive(),
  unitId: z.coerce.number().int().positive(),
  date: dateSchema,
  /** When editing: ignore this appointment so its own time shows as free. */
  excludeId: z.coerce.number().int().positive().optional(),
});

type Transition = { from: AppointmentStatus[]; to: AppointmentStatus };
const TRANSITIONS: Record<string, Transition> = {
  confirm: { from: ['pending'], to: 'confirmed' },
  cancel: { from: ['pending', 'confirmed'], to: 'cancelled' },
  complete: { from: ['confirmed'], to: 'completed' },
  'no-show': { from: ['confirmed'], to: 'no_show' },
};

const VERB: Record<string, string> = { confirm: 'confirmed', cancel: 'cancelled', complete: 'completed', 'no-show': 'marked as a no-show' };

const isStaff = (user: AuthUser) => user.role !== 'patient';

export function appointmentsRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  const ownPatientId = async (user: AuthUser): Promise<number | null> =>
    (await db('patients').where({ user_id: user.id }).whereNull('deleted_at').first('id'))?.id ?? null;

  /** Loads one appointment; a patient only ever sees their own (404 otherwise). */
  async function load(user: AuthUser, id: number) {
    const row = await appointmentQuery(db).where('a.id', id).first();
    if (!row) throw notFound('Appointment not found');
    if (!isStaff(user) && row.patient_id !== (await ownPatientId(user))) throw notFound('Appointment not found');
    if (!involvedIn(await doctorScope(db, user), row)) throw notFound('Appointment not found');
    return row;
  }

  /**
   * An external specialist changes only appointments of his own patients that he treats himself.
   * (For another doctor's patient he may see the appointment and write the report, nothing more.)
   */
  async function assertManage(user: AuthUser, row: { doctor_id: number; p_doctor_id?: number | null }) {
    if (!canManageAppointment(await doctorScope(db, user), row)) {
      throw forbidden('You can only manage appointments of your own patients');
    }
  }

  const detail = async (user: AuthUser, id: number): Promise<AppointmentDto> => {
    const row = await load(user, id);
    return (await toDtos(db, [row], { staff: isStaff(user), withTeeth: true, scope: await doctorScope(db, user) }))[0]!;
  };

  async function assertExist(table: string, ids: number[], code: string, label: string) {
    const unique = [...new Set(ids)];
    if (!unique.length) return unique;
    const found = await db(table).whereIn('id', unique).count({ n: '*' }).first();
    if (Number(found?.n) !== unique.length) throw badRequest(code, `Unknown ${label}`);
    return unique;
  }

  // ----- list ---------------------------------------------------------------

  router.get('/', requirePermission('appointments:read'), async (req, res) => {
    const user = requireUser(req);
    const f = listQuery.parse(req.query);
    const scope = await doctorScope(db, user);

    let patientId = f.patientId;
    if (!isStaff(user)) {
      patientId = (await ownPatientId(user)) ?? -1; // no linked record: nothing to show
    }

    const base = appointmentQuery(db).modify((qb) => {
      if (patientId) qb.where('a.patient_id', patientId);
      if (f.doctorId) qb.where('a.doctor_id', f.doctorId);
      if (f.clinicId) qb.where('a.clinic_id', f.clinicId);
      if (f.unitId) qb.where('a.unit_id', f.unitId);
      if (f.status?.length) qb.whereIn('a.status', f.status);
      if (f.from) qb.where('a.date', '>=', f.from);
      if (f.to) qb.where('a.date', '<=', f.to);
      if (f.q && isStaff(user)) whereWords(qb, ['p.fname', 'p.lname', 'p.phone'], f.q);
      // A specialist sees the appointments he treats and those of his own patients, nothing else.
      if (scope.restricted) {
        if (scope.doctorId === null) qb.whereRaw('1 = 0');
        else qb.where((w) => w.where('a.doctor_id', scope.doctorId).orWhere('p.doctor_id', scope.doctorId));
      }
    });
    const total = Number((await base.clone().clearSelect().count({ n: '*' }).first())?.n ?? 0);
    const rows = await base
      .clone()
      .select(db.raw('(SELECT COUNT(*) FROM reports rp WHERE rp.appointment_id = a.id) as has_report')) // only to sort by
      .orderBy(appointmentOrder(f.sort, f.order))
      .limit(f.pageSize)
      .offset((f.page - 1) * f.pageSize);

    const body: Paginated<AppointmentDto> = {
      data: await toDtos(db, rows, { staff: isStaff(user), scope }),
      meta: { page: f.page, pageSize: f.pageSize, total },
    };
    res.json(body);
  });

  // ----- what is already booked that day (before /:id) ----------------------

  router.get('/busy', requirePermission('appointments:create'), async (req, res) => {
    res.json(await getBusy(db, busyQuery.parse(req.query), await doctorScope(db, requireUser(req))));
  });

  // ----- create: doctors, staff and admins only -----------------------------

  router.post('/', requirePermission('appointments:create'), async (req, res) => {
    const user = requireUser(req);
    const parsed = appointmentInputSchema.parse(req.body);
    const body = { ...parsed, durationMinutes: parsed.durationMinutes ?? (await operating(ctx)).appointments.defaultDuration };

    const patientRow = await db('patients').where({ id: body.patientId }).whereNull('deleted_at').first('id', 'doctor_id');
    // A specialist can only book his own patients, and only with himself as the doctor. Another
    // doctor's patient looks exactly like one that doesn't exist.
    const scope = await doctorScope(db, user);
    if (!patientRow || !ownsPatient(scope, patientRow.doctor_id)) throw badRequest('UNKNOWN_PATIENT', 'Unknown patient');
    if (scope.restricted && body.doctorId !== scope.doctorId) throw forbidden('You can only book appointments for yourself');
    if (!(await db('doctors').where({ id: body.doctorId }).first('id'))) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    if (!(await db('clinics').where({ id: body.clinicId }).first('id'))) throw badRequest('UNKNOWN_CLINIC', 'Unknown clinic');
    const categoryIds = await assertExist('categories', body.categoryIds ?? [], 'UNKNOWN_CATEGORY', 'category');
    const toothIds = await assertExist('teeth', body.toothIds ?? [], 'UNKNOWN_TOOTH', 'tooth');

    const status: AppointmentStatus = body.status ?? 'confirmed';
    const now = sqlNow();

    const id = await db.transaction(async (trx) => {
      await assertBookable(ctx, trx, {
        doctorId: body.doctorId, clinicId: body.clinicId, unitId: body.unitId,
        date: body.date, time: body.time, durationMinutes: body.durationMinutes,
      });
      const [newId] = await trx('appointments').insert({
        date: body.date, time: body.time, duration_minutes: body.durationMinutes, status, intended: body.intended ?? null,
        patient_id: body.patientId, doctor_id: body.doctorId, clinic_id: body.clinicId, unit_id: body.unitId,
        created_at: now, updated_at: now,
      });
      if (categoryIds.length) {
        await trx('appointment_category').insert(categoryIds.map((c) => ({ appointment_id: newId, category_id: c, created_at: now, updated_at: now })));
      }
      if (toothIds.length) {
        await trx('appointment_tooth').insert(toothIds.map((t) => ({ appointment_id: newId, tooth_id: t, created_at: now, updated_at: now })));
      }
      return newId as number;
    });

    await audit(ctx, req, {
      userId: user.id, action: 'appointment.create', entity: 'appointment', entityId: id,
      diff: { date: body.date, time: body.time, durationMinutes: body.durationMinutes, doctorId: body.doctorId, unitId: body.unitId, status },
    });
    await appointmentBooked(ctx, id, user.id);
    res.status(201).json({ appointment: await detail(user, id) });
  });

  // ----- read one -----------------------------------------------------------

  router.get('/:id', requirePermission('appointments:read'), async (req, res) => {
    const user = requireUser(req);
    const appointment = await detail(user, idParam.parse(req.params.id));
    await auditView(ctx, req, { user, action: 'appointment.view', patientId: appointment.patientId, appointmentId: appointment.id });
    res.json({ appointment });
  });

  // ----- edit / reschedule --------------------------------------------------

  router.patch('/:id', requirePermission('appointments:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const body = appointmentUpdateSchema.parse(req.body);

    const current = await load(user, id);
    await assertManage(user, current);
    assertClinicExists(current); // the clinic was deleted: kept for the records, no longer editable
    if (!['pending', 'confirmed'].includes(current.status)) {
      throw new HttpError(409, 'NOT_EDITABLE', `A ${current.status.replace('_', ' ')} appointment can't be changed`, { status: current.status });
    }
    // Staff choose the length when booking; only a doctor or an admin changes it afterwards.
    if (body.durationMinutes !== undefined && body.durationMinutes !== current.duration_minutes && user.role === 'staff') {
      throw new HttpError(403, 'DURATION_RESTRICTED', "Only a doctor or an admin can change an appointment's length");
    }

    const next = {
      doctorId: body.doctorId ?? current.doctor_id,
      clinicId: body.clinicId ?? current.clinic_id,
      unitId: body.unitId ?? current.unit_id,
      date: body.date ?? current.date,
      time: body.time ?? current.time,
      durationMinutes: body.durationMinutes ?? current.duration_minutes,
    };
    if (!next.unitId) throw badRequest('UNIT_REQUIRED', 'Choose a dental unit');
    if ((await doctorScope(db, user)).restricted && body.doctorId !== undefined && body.doctorId !== current.doctor_id) {
      throw forbidden('You can only book appointments for yourself');
    }
    if (body.doctorId && !(await db('doctors').where({ id: body.doctorId }).first('id'))) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    if (body.clinicId && !(await db('clinics').where({ id: body.clinicId }).first('id'))) throw badRequest('UNKNOWN_CLINIC', 'Unknown clinic');

    const moved =
      next.doctorId !== current.doctor_id || next.clinicId !== current.clinic_id || next.unitId !== current.unit_id ||
      next.date !== current.date || next.time !== current.time || next.durationMinutes !== current.duration_minutes;

    await db.transaction(async (trx) => {
      if (moved) await assertBookable(ctx, trx, { ...next, unitId: next.unitId as number, excludeId: id });
      await trx('appointments').where({ id }).update({
        doctor_id: next.doctorId, clinic_id: next.clinicId, unit_id: next.unitId, date: next.date, time: next.time,
        duration_minutes: next.durationMinutes,
        ...(body.intended !== undefined ? { intended: body.intended } : {}),
        updated_at: sqlNow(),
      });
    });

    await audit(ctx, req, { userId: user.id, action: 'appointment.update', entity: 'appointment', entityId: id, diff: { fields: Object.keys(body) } });
    res.json({ appointment: await detail(user, id) });
  });

  // ----- status changes -----------------------------------------------------

  router.post('/:id/:action', async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const action = String(req.params.action);
    const rule = TRANSITIONS[action];
    if (!rule) throw notFound('Unknown action');

    // Who may do what: the clinical step needs visits:update; patients may only cancel their own.
    if (!isStaff(user)) {
      if (action !== 'cancel') throw forbidden();
      await assertPortalOn(ctx); // a patient cancels through the portal, which the clinic may switch off
    } else if (action === 'complete') {
      if (!can(user.role, 'visits:update')) throw forbidden();
    } else if (!can(user.role, 'appointments:update')) {
      throw forbidden();
    }

    const row = await load(user, id);
    assertClinicExists(row);
    if (isStaff(user)) await assertManage(user, row);
    if (!rule.from.includes(row.status)) {
      throw new HttpError(409, 'INVALID_TRANSITION', `A ${String(row.status).replace('_', ' ')} appointment can't be ${VERB[action]}`, { status: row.status, action });
    }

    const now = clinicNow(env, ctx.clock());
    const hours = hoursUntil(now, row.date, row.time);
    const cancelMinHours = (await operating(ctx)).appointments.cancelMinHours;
    if (!isStaff(user) && hours < cancelMinHours) {
      throw new HttpError(409, 'TOO_LATE_TO_CANCEL', `Appointments can only be cancelled online at least ${cancelMinHours} hours ahead. Please call the clinic.`, { hours: cancelMinHours });
    }
    if (action === 'complete' && row.date > now.date) throw new HttpError(409, 'FUTURE_APPOINTMENT', "An appointment that hasn't happened yet can't be completed");
    if (action === 'no-show' && hours > 0) throw new HttpError(409, 'FUTURE_APPOINTMENT', "An appointment that hasn't started yet can't be a no-show");

    await db.transaction(async (trx) => {
      // The status check in the WHERE makes this atomic if two people act at once.
      const changed = await trx('appointments').where({ id }).whereIn('status', rule.from).update({ status: rule.to, updated_at: sqlNow() });
      if (!changed) throw new HttpError(409, 'INVALID_TRANSITION', 'The appointment was just changed by someone else');
      if (action === 'complete') {
        const visit = `${row.date} ${row.time}:00`;
        await trx('patients').where({ id: row.patient_id }).where((w) => w.whereNull('last_visit').orWhere('last_visit', '<', visit)).update({ last_visit: visit });
      }
    });

    await syncOffersForAppointment(db, id);
    await audit(ctx, req, { userId: user.id, action: `appointment.${action}`, entity: 'appointment', entityId: id, diff: { from: row.status, to: rule.to } });
    if (action === 'cancel') await appointmentCancelled(ctx, id, user.id);
    if (action === 'no-show') await appointmentNoShow(ctx, id, user.id);
    res.json({ appointment: await detail(user, id) });
  });

  // ----- delete (to the Trash) ----------------------------------------------

  router.delete('/:id', requirePermission('appointments:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const row = await load(user, id);
    await assertManage(user, row);
    const now = sqlNow();
    await db('appointments').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
    await syncOffersForAppointment(db, id);
    await audit(ctx, req, { userId: user.id, action: 'appointment.delete', entity: 'appointment', entityId: id });
    res.status(204).end();
  });

  // ----- procedures and teeth -----------------------------------------------

  async function editableAppointment(user: AuthUser, id: number) {
    const row = await load(user, id);
    assertClinicExists(row);
    await assertManage(user, row);
    if (['cancelled', 'no_show'].includes(row.status)) throw new HttpError(409, 'NOT_EDITABLE', `A ${String(row.status).replace('_', ' ')} appointment can't be changed`, { status: row.status });
    return row;
  }

  router.put('/:id/categories', requirePermission('appointments:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const { categoryIds } = appointmentCategoriesSchema.parse(req.body);
    await editableAppointment(user, id);
    const ids = await assertExist('categories', categoryIds, 'UNKNOWN_CATEGORY', 'category');
    const now = sqlNow();
    await db.transaction(async (trx) => {
      await trx('appointment_category').where({ appointment_id: id }).del();
      if (ids.length) await trx('appointment_category').insert(ids.map((c) => ({ appointment_id: id, category_id: c, created_at: now, updated_at: now })));
    });
    await audit(ctx, req, { userId: user.id, action: 'appointment.categories', entity: 'appointment', entityId: id, diff: { categoryIds: ids } });
    res.json({ appointment: await detail(user, id) });
  });

  router.put('/:id/teeth', requirePermission('visits:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const { teeth } = appointmentTeethSchema.parse(req.body);
    await editableAppointment(user, id);
    await assertExist('teeth', teeth.map((t) => t.toothId), 'UNKNOWN_TOOTH', 'tooth');
    const now = sqlNow();
    await db.transaction(async (trx) => {
      await trx('appointment_tooth').where({ appointment_id: id }).del();
      if (teeth.length) {
        await trx('appointment_tooth').insert(teeth.map((t) => ({ appointment_id: id, tooth_id: t.toothId, description: t.description ?? null, created_at: now, updated_at: now })));
      }
    });
    await audit(ctx, req, { userId: user.id, action: 'appointment.teeth', entity: 'appointment', entityId: id, diff: { toothIds: teeth.map((t) => t.toothId) } });
    res.json({ appointment: await detail(user, id) });
  });

  return router;
}
