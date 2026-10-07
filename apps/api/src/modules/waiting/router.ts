import { Router } from 'express';
import { z } from 'zod';
import {
  WAITING_ACTIONS, waitingCheckInSchema,
  type WaitingAction, type WaitingCandidateDto, type WaitingDisplayDto, type WaitingListDto, type WaitingScreenDto, type WaitingStatus, type WaitingTicketDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { randomToken, safeEqual } from '../../lib/crypto';
import { isUniqueError } from '../../lib/dbErrors';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { clinicNow } from '../../lib/time';
import { limiter } from '../../middleware/rateLimit';
import { requireAuth, requirePermission, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { doctorIdFor } from '../visits/access';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();
const SCREEN_KEY = 'waiting.display_key';
const ACTIVE: WaitingStatus[] = ['waiting', 'called'];

/** Which statuses each action starts from, and where it ends. */
const RULES: Record<WaitingAction, { from: WaitingStatus[]; to: WaitingStatus }> = {
  call: { from: ['waiting', 'called'], to: 'called' }, // from `called` it calls the patient again
  finish: { from: ['called'], to: 'done' },
  leave: { from: ['waiting', 'called'], to: 'left' },
  requeue: { from: ['called'], to: 'waiting' },
};

/**
 * The waiting room. Staff give an arriving patient a number (for an expected appointment, or for anyone, with the
 * doctor and dental unit chosen); the treating doctor sees the patients waiting for him and calls them by number; a
 * screen in the waiting room shows the number called and the dental unit to go to. Numbers start again at 1 each day
 * in each clinic. Admins and staff see and handle every ticket; a doctor only the tickets of patients waiting for
 * him (a doctor login with no doctor profile sees none).
 */
export function waitingRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  const today = () => clinicNow(env, ctx.clock()).date;
  /** A doctor reaches only his own tickets: the id to restrict to, null for admin and staff, -1 when he has no profile. */
  async function onlyDoctor(user: AuthUser): Promise<number | null> {
    if (user.role !== 'doctor') return null;
    return (await doctorIdFor(db, user.id)) ?? -1;
  }

  const query = () =>
    db('waiting_tickets as w')
      .join('patients as p', 'p.id', 'w.patient_id')
      .join('doctors as d', 'd.id', 'w.doctor_id')
      .leftJoin('dental_units as u', 'u.id', 'w.unit_id')
      .leftJoin('appointments as a', function join() {
        this.on('a.id', 'w.appointment_id').andOnNull('a.deleted_at');
      })
      .whereNull('p.deleted_at')
      .select('w.*', 'p.fname as p_fname', 'p.lname as p_lname', 'd.fname as d_fname', 'd.lname as d_lname', 'u.name as u_name', 'a.time as a_time', 'a.intended as a_intended');

  async function toDtos(rows: Row[]): Promise<WaitingTicketDto[]> {
    const ids = rows.map((r) => r.appointment_id).filter(Boolean);
    const categories: Row[] = ids.length
      ? await db('appointment_category as ac').join('categories as c', 'c.id', 'ac.category_id').whereIn('ac.appointment_id', ids).select('ac.appointment_id', 'c.name').orderBy('c.name')
      : [];
    return rows.map((r) => ({
      id: r.id, number: r.number, date: r.date, status: r.status as WaitingStatus,
      patient: { id: r.patient_id, fname: r.p_fname, lname: r.p_lname },
      doctor: { id: r.doctor_id, fname: r.d_fname, lname: r.d_lname },
      unit: r.unit_id ? { id: r.unit_id, name: r.u_name } : null,
      appointment: r.appointment_id && r.a_time ? { id: r.appointment_id, time: r.a_time, procedures: categories.filter((c) => c.appointment_id === r.appointment_id).map((c) => c.name as string) } : null,
      arrivedAt: r.arrived_at, calledAt: r.called_at ?? null, callCount: r.call_count, finishedAt: r.finished_at ?? null,
    }));
  }

  /** A ticket this person may reach, today's or an older one: a doctor's own, anyone's for admin and staff (404 otherwise). */
  async function load(user: AuthUser, id: number): Promise<Row> {
    const row: Row | undefined = await query().where('w.id', id).first();
    const only = await onlyDoctor(user);
    if (!row || (only !== null && row.doctor_id !== only)) throw notFound('Ticket not found');
    return row;
  }

  // ----- today's tickets ------------------------------------------------------------------------------------------
  router.get('/', requirePermission('waiting:read'), async (req, res) => {
    const user = requireUser(req);
    const only = await onlyDoctor(user);
    const rows: Row[] = await query().where('w.date', today()).modify((qb) => { if (only !== null) qb.where('w.doctor_id', only); })
      .orderBy([{ column: 'w.number' }, { column: 'w.id' }]);
    const body: WaitingListDto = { date: today(), data: await toDtos(rows) };
    res.json(body);
  });

  // Today's expected appointments whose patient has no number yet, for the desk.
  router.get('/candidates', requirePermission('waiting:create'), async (_req, res) => {
    const date = today();
    const rows: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').join('doctors as d', 'd.id', 'a.doctor_id').leftJoin('dental_units as u', 'u.id', 'a.unit_id')
      .whereNull('a.deleted_at').whereNull('p.deleted_at').where('a.date', date).whereIn('a.status', ['pending', 'confirmed'])
      .whereNotExists(db('waiting_tickets as w').whereRaw('w.patient_id = a.patient_id').where('w.date', date).whereIn('w.status', ACTIVE).select(db.raw('1')))
      .select('a.id', 'a.time', 'a.patient_id', 'a.doctor_id', 'a.unit_id', 'p.fname as p_fname', 'p.lname as p_lname', 'd.fname as d_fname', 'd.lname as d_lname', 'u.name as u_name')
      .orderBy([{ column: 'a.time' }, { column: 'a.id' }]);
    const data: WaitingCandidateDto[] = rows.map((r) => ({
      appointmentId: r.id, time: r.time, patient: { id: r.patient_id, fname: r.p_fname, lname: r.p_lname }, doctor: { id: r.doctor_id, fname: r.d_fname, lname: r.d_lname },
      unit: r.unit_id ? { id: r.unit_id, name: r.u_name } : null,
    }));
    res.json({ data });
  });

  // ----- giving a number --------------------------------------------------------------------------------------------
  router.post('/', requirePermission('waiting:create'), async (req, res) => {
    const user = requireUser(req);
    const input = waitingCheckInSchema.parse(req.body);
    const date = today();

    const patient: Row | undefined = await db('patients').where({ id: input.patientId }).whereNull('deleted_at').first('id');
    if (!patient) throw badRequest('UNKNOWN_PATIENT', 'Unknown patient');

    let doctorId = input.doctorId;
    let unitId = input.unitId;
    let appointmentId: number | null = null;
    if (input.appointmentId !== undefined) {
      const appt: Row | undefined = await db('appointments').where({ id: input.appointmentId, patient_id: patient.id }).whereNull('deleted_at').first('id', 'date', 'status', 'doctor_id', 'unit_id');
      if (!appt) throw badRequest('UNKNOWN_APPOINTMENT', 'Unknown appointment');
      if (appt.date !== date || !['pending', 'confirmed'].includes(appt.status)) throw badRequest('NOT_TODAYS_APPOINTMENT', 'That appointment is not one that is expected today');
      appointmentId = appt.id;
      doctorId = appt.doctor_id;
      unitId = appt.unit_id ?? input.unitId; // an older appointment may have no unit: the desk then chooses one
    }
    if (!doctorId || !unitId) throw badRequest('UNIT_REQUIRED', 'Choose the doctor and the dental unit');
    if (!(await db('doctors').where({ id: doctorId }).first('id'))) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    const unit: Row | undefined = await db('dental_units').where({ id: unitId }).first('id', 'clinic_id');
    if (!unit) throw badRequest('UNKNOWN_UNIT', 'Unknown dental unit');
    if (!unit.clinic_id) throw new HttpError(409, 'CLINIC_DELETED', 'That dental unit belongs to a clinic that has been deleted');

    const waiting: Row | undefined = await db('waiting_tickets').where({ patient_id: patient.id, date }).whereIn('status', ACTIVE).first('id', 'number');
    if (waiting) throw new HttpError(409, 'ALREADY_WAITING', 'This patient already has a number today', { number: waiting.number });

    // The next number of the day in this clinic. Two desks at once may pick the same one: the unique index refuses
    // the second, which simply takes the next.
    let created: number | undefined;
    for (let attempt = 0; attempt < 8 && !created; attempt++) {
      const last = await db('waiting_tickets').where({ clinic_id: unit.clinic_id, date }).max({ n: 'number' }).first();
      const number = Number(last?.n ?? 0) + 1;
      const now = sqlNow();
      try {
        [created] = (await db('waiting_tickets').insert({
          date, number, clinic_id: unit.clinic_id, patient_id: patient.id, doctor_id: doctorId, unit_id: unitId, appointment_id: appointmentId,
          status: 'waiting', arrived_at: now, call_count: 0, created_by: user.id, created_at: now, updated_at: now,
        })) as number[];
      } catch (err) {
        if (!isUniqueError(err)) throw err;
      }
    }
    if (!created) throw new HttpError(503, 'NUMBER_FAILED', 'Could not give a number, please try again');
    const ticket = (await toDtos([await query().where('w.id', created).first()]))[0]!;
    await audit(ctx, req, { userId: user.id, action: 'waiting.checkin', entity: 'waiting_ticket', entityId: created, diff: { number: ticket.number, doctorId, unitId, appointmentId } });
    res.status(201).json({ ticket });
  });

  // ----- the waiting-room screen's address (admin) ---------------------------------------------------------------------
  const screen = async (): Promise<WaitingScreenDto> => {
    const row: Row | undefined = await db('app_settings').where({ key: SCREEN_KEY }).first('value');
    return { key: row?.value ?? null, path: row ? `/waiting-display?key=${row.value}` : null };
  };
  router.get('/screen', requirePermission('settings:read'), async (_req, res) => {
    res.json(await screen());
  });
  // Makes the address, or makes a new one (the old one stops working: use it when a screen goes missing or the address leaks).
  router.post('/screen/reset', requirePermission('settings:update'), async (req, res) => {
    const user = requireUser(req);
    const value = randomToken(24);
    const now = sqlNow();
    const updated = await db('app_settings').where({ key: SCREEN_KEY }).update({ value, updated_by: user.id, updated_at: now });
    if (!updated) await db('app_settings').insert({ key: SCREEN_KEY, value, updated_by: user.id, created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'waiting.screen_key', entity: 'settings', entityId: 'waiting-screen' }); // never the key itself
    res.json(await screen());
  });

  // ----- calling, finishing, sending away ---------------------------------------------------------------------------
  router.post('/:id/:action', requirePermission('waiting:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const action = z.enum(WAITING_ACTIONS).safeParse(req.params.action);
    if (!action.success) throw notFound('Unknown action');
    const rule = RULES[action.data];
    const ticket = await load(user, id);
    if (ticket.date !== today()) throw new HttpError(409, 'TICKET_EXPIRED', 'This number was for an earlier day');
    if (!rule.from.includes(ticket.status)) {
      throw new HttpError(409, 'INVALID_TICKET_ACTION', 'This number cannot be changed that way now', { status: ticket.status, action: action.data });
    }

    const now = sqlNow();
    await db.transaction(async (trx) => {
      const update: Record<string, unknown> = { status: rule.to, updated_at: now };
      if (action.data === 'call') {
        // A doctor moving on to the next patient has finished with the one he called before in this unit.
        await trx('waiting_tickets').where({ date: ticket.date, status: 'called', doctor_id: ticket.doctor_id, unit_id: ticket.unit_id }).whereNot({ id }).update({ status: 'done', finished_at: now, updated_at: now });
        update.called_at = now;
        update.call_count = Number(ticket.call_count) + 1;
      }
      if (action.data === 'finish' || action.data === 'leave') update.finished_at = now;
      if (action.data === 'requeue') update.called_at = null;
      const changed = await trx('waiting_tickets').where({ id }).whereIn('status', rule.from).update(update);
      if (!changed) throw new HttpError(409, 'INVALID_TICKET_ACTION', 'The ticket was just changed by someone else');
    });
    await audit(ctx, req, { userId: user.id, action: `waiting.${action.data}`, entity: 'waiting_ticket', entityId: id, diff: { number: ticket.number } });
    res.json({ ticket: (await toDtos([await query().where('w.id', id).first()]))[0] });
  });

  return router;
}

/**
 * What the waiting-room screen reads: no sign-in (a screen on the wall has no one to sign in), only the secret in
 * its address. It shows numbers and dental units, never a name, and nothing else.
 */
export function waitingDisplayRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.get('/', limiter(env, { windowMs: 60_000, limit: 120, message: 'Too many requests.' }), async (req, res) => {
    const given = typeof req.query.key === 'string' ? req.query.key : '';
    const stored: Row | undefined = await db('app_settings').where({ key: SCREEN_KEY }).first('value');
    if (!stored || !given || !safeEqual(given, stored.value)) throw notFound('Not found'); // a wrong address looks like no page
    const date = clinicNow(env, ctx.clock()).date;
    const called: Row[] = await db('waiting_tickets as w').join('patients as p', 'p.id', 'w.patient_id').leftJoin('dental_units as u', 'u.id', 'w.unit_id')
      .whereNull('p.deleted_at').where({ 'w.date': date, 'w.status': 'called' }).select('w.number', 'w.called_at', 'w.call_count', 'u.id as unit_id', 'u.name as unit')
      .orderBy([{ column: 'w.called_at', order: 'desc' }, { column: 'w.id', order: 'desc' }]);
    // One entry per dental unit: the most recent call there.
    const seen = new Set<number | null>();
    const calls = called.filter((c) => { const k = c.unit_id ?? null; if (k !== null && seen.has(k)) return false; seen.add(k); return true; });
    const waiting = Number((await db('waiting_tickets as w').join('patients as p', 'p.id', 'w.patient_id').whereNull('p.deleted_at').where({ 'w.date': date, 'w.status': 'waiting' }).count({ n: '*' }).first())?.n ?? 0);
    const clinic: Row | undefined = await db('clinics').orderBy('id').first('name');
    const body: WaitingDisplayDto = {
      calls: calls.map((c) => ({ number: c.number, unit: c.unit ?? null, calledAt: c.called_at, callCount: c.call_count })),
      waiting, clinic: clinic?.name ?? null,
    };
    res.set('Cache-Control', 'no-store').json(body);
  });
  return router;
}
