import { Router } from 'express';
import { z } from 'zod';
import { EXPENSE_TYPES, directoryInputSchema, directoryUpdateSchema, expenseInputSchema, type DirectoryDto, type DirectoryEntryDto, type ExpenseDto, type ExpenseInput, type Paginated } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { whereWords } from '../../lib/search';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { round2 } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(EXPENSE_TYPES).optional(),
  labId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  from: date.optional(),
  to: date.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['date', 'type', 'amount', 'description']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** The owners' own spending is for admins; staff handle the clinic's. */
const isAdmin = (user: AuthUser) => user.role === 'admin';

/** Expenses (admins, and staff for everything except the owners' personal ones). */
export function expensesRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin', 'staff'));

  const base = () => db('expenses as e').leftJoin('users as u', 'u.id', 'e.user_id').whereNull('e.deleted_at').select('e.*', 'u.name as created_by');

  async function toDtos(rows: Row[]): Promise<ExpenseDto[]> {
    const ids = (type: string) => [...new Set(rows.filter((r) => r.type === type && r.model_id).map((r) => r.model_id as number))];
    const names = async (table: string, values: number[]) => new Map<number, Row>((values.length ? await db(table).whereIn('id', values) : []).map((r: Row) => [r.id, r]));
    const labs = await names('labs', ids('lab'));
    const suppliers = await names('suppliers', ids('supplier'));
    const doctors = await names('doctors', ids('commission'));
    const apptIds = [...new Set(rows.map((r) => r.appointment_id).filter(Boolean) as number[])];
    const appts = new Map<number, Row>(
      (apptIds.length
        ? await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').whereIn('a.id', apptIds).select('a.id', 'a.date', 'a.time', 'p.fname', 'p.lname')
        : []
      ).map((r: Row) => [r.id, r]),
    );
    return rows.map((r) => {
      const lab = r.type === 'lab' ? labs.get(r.model_id) : undefined;
      const supplier = r.type === 'supplier' ? suppliers.get(r.model_id) : undefined;
      const doctor = r.type === 'commission' ? doctors.get(r.model_id) : undefined;
      const a = r.appointment_id ? appts.get(r.appointment_id) : undefined;
      return {
        id: r.id, type: r.type, date: r.date, amount: round2(Number(r.amount)), currency: r.currency, description: r.description ?? null,
        lab: lab ? { id: lab.id, name: lab.name } : null, supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
        doctor: doctor ? { id: doctor.id, fname: doctor.fname, lname: doctor.lname } : null,
        appointment: a ? { id: a.id, date: a.date, time: a.time, patient: { fname: a.fname, lname: a.lname } } : null,
        createdBy: r.created_by ?? null,
      } as ExpenseDto;
    });
  }

  /** The things a typed expense must point at must exist, and make sense together. */
  async function check(input: ExpenseInput): Promise<{ model_id: number | null; appointment_id: number | null }> {
    if (input.type === 'lab') {
      if (!(await db('labs').where({ id: input.labId! }).first('id'))) throw badRequest('UNKNOWN_LAB', 'Unknown lab');
      return { model_id: input.labId!, appointment_id: null };
    }
    if (input.type === 'supplier') {
      if (!(await db('suppliers').where({ id: input.supplierId! }).first('id'))) throw badRequest('UNKNOWN_SUPPLIER', 'Unknown supplier');
      return { model_id: input.supplierId!, appointment_id: null };
    }
    if (input.type === 'commission') {
      const doctor = await db('doctors').where({ id: input.doctorId! }).first('id', 'kind');
      if (!doctor) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
      if (doctor.kind !== 'external') throw badRequest('NOT_A_SPECIALIST', 'A commission expense is paid to an outside specialist');
      if (!input.appointmentId) return { model_id: doctor.id, appointment_id: null };
      const appt = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').join('doctors as owner', 'owner.id', 'p.doctor_id')
        .where('a.id', input.appointmentId!).whereNull('a.deleted_at').whereNull('p.deleted_at').first('a.doctor_id', 'owner.kind as owner_kind');
      if (!appt) throw badRequest('UNKNOWN_APPOINTMENT', 'Unknown appointment');
      if (appt.doctor_id !== doctor.id) throw badRequest('WRONG_SPECIALIST', 'That specialist did not treat this appointment');
      if (appt.owner_kind !== 'owner') throw badRequest('NOT_AN_OWNER_PATIENT', "A commission expense is for a visit of an owner doctor's patient");
      return { model_id: doctor.id, appointment_id: input.appointmentId! };
    }
    return { model_id: null, appointment_id: null };
  }

  async function load(user: AuthUser, id: number): Promise<Row> {
    const row = await base().where('e.id', id).first();
    if (!row || (row.type === 'personal' && !isAdmin(user))) throw notFound('Expense not found'); // staff cannot tell a personal one exists
    return row;
  }

  router.get('/', requirePermission('expenses:read'), async (req, res) => {
    const user = requireUser(req);
    const q = listQuery.parse(req.query);
    if (q.type === 'personal' && !isAdmin(user)) {
      res.json({ data: [], meta: { page: q.page, pageSize: q.pageSize, total: 0 }, sum: 0 });
      return;
    }
    const filtered = base().modify((qb) => {
      if (!isAdmin(user)) qb.whereNot('e.type', 'personal');
      if (q.type) qb.where('e.type', q.type);
      if (q.labId) qb.where('e.type', 'lab').where('e.model_id', q.labId);
      if (q.supplierId) qb.where('e.type', 'supplier').where('e.model_id', q.supplierId);
      if (q.from) qb.where('e.date', '>=', q.from);
      if (q.to) qb.where('e.date', '<=', q.to);
      whereWords(qb, ['e.description'], q.q);
    });
    const total = Number((await filtered.clone().clearSelect().count({ n: '*' }).first())?.n ?? 0);
    const sum = round2(Number((await filtered.clone().clearSelect().sum({ s: 'e.amount' }).first())?.s ?? 0));
    const column = { date: 'e.date', type: 'e.type', amount: 'e.amount', description: 'e.description' }[q.sort];
    const rows = await filtered.clone().orderBy([{ column, order: q.order }, { column: 'e.id', order: q.order }]).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const body: Paginated<ExpenseDto> & { sum: number } = { data: await toDtos(rows), meta: { page: q.page, pageSize: q.pageSize, total }, sum };
    res.json(body);
  });

  // The visits a commission expense can be for: this specialist's appointments with the owners' patients, newest first.
  router.get('/commission-appointments', requirePermission('expenses:read'), async (req, res) => {
    const doctorId = idParam.parse(req.query.doctorId);
    const rows: Row[] = await db('appointments as a')
      .join('patients as p', 'p.id', 'a.patient_id').join('doctors as owner', 'owner.id', 'p.doctor_id')
      .where('a.doctor_id', doctorId).where('owner.kind', 'owner').whereNull('a.deleted_at').whereNull('p.deleted_at')
      .whereIn('a.status', ['confirmed', 'completed'])
      .orderBy([{ column: 'a.date', order: 'desc' }, { column: 'a.time', order: 'desc' }]).limit(100)
      .select('a.id', 'a.date', 'a.time', 'p.fname', 'p.lname');
    res.json({ data: rows.map((r) => ({ id: r.id, date: r.date, time: r.time, patient: { fname: r.fname, lname: r.lname } })) });
  });

  router.get('/:id', requirePermission('expenses:read'), async (req, res) => {
    const user = requireUser(req);
    res.json({ expense: (await toDtos([await load(user, idParam.parse(req.params.id))]))[0] });
  });

  router.post('/', requirePermission('expenses:create'), async (req, res) => {
    const user = requireUser(req);
    const input = expenseInputSchema.parse(req.body);
    if (input.type === 'personal' && !isAdmin(user)) throw forbidden('Only an admin can record personal expenses');
    if (input.date > clinicNow(env, ctx.clock()).date) throw badRequest('FUTURE_DATE', 'An expense cannot be dated in the future');
    const refs = await check(input);
    const now = sqlNow();
    const [id] = await db('expenses').insert({
      date: input.date, type: input.type, amount: input.amount, currency: '$', description: input.description ?? null, ...refs, user_id: user.id, created_at: now, updated_at: now,
    });
    await audit(ctx, req, { userId: user.id, action: 'expense.create', entity: 'expense', entityId: id as number, diff: { type: input.type, amount: input.amount } });
    res.status(201).json({ expense: (await toDtos([await load(user, id as number)]))[0] });
  });

  // The whole expense is sent again (the fields that matter depend on its type).
  router.patch('/:id', requirePermission('expenses:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = expenseInputSchema.parse(req.body);
    await load(user, id);
    if (input.type === 'personal' && !isAdmin(user)) throw forbidden('Only an admin can record personal expenses');
    if (input.date > clinicNow(env, ctx.clock()).date) throw badRequest('FUTURE_DATE', 'An expense cannot be dated in the future');
    const refs = await check(input);
    await db('expenses').where({ id }).update({ date: input.date, type: input.type, amount: input.amount, description: input.description ?? null, ...refs, updated_at: sqlNow() });
    await audit(ctx, req, { userId: user.id, action: 'expense.update', entity: 'expense', entityId: id, diff: { type: input.type, amount: input.amount } });
    res.json({ expense: (await toDtos([await load(user, id)]))[0] });
  });

  router.delete('/:id', requirePermission('expenses:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await load(user, id);
    const now = sqlNow();
    await db('expenses').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'expense.delete', entity: 'expense', entityId: id });
    res.status(204).end();
  });

  return router;
}

const toEntry = (r: Row): DirectoryDto => ({
  id: r.id, name: r.name, contact: r.personal ?? null, address: r.address ?? null, phone: r.phone, description: r.description ?? null,
});

/** The labs and suppliers the clinic deals with: a short list for forms, and full records to manage. */
export function directoryRouter(ctx: AppContext, table: 'labs' | 'suppliers'): Router {
  const { db } = ctx;
  const router = Router();
  const entity = table === 'labs' ? 'lab' : 'supplier';
  router.use(requireAuth(ctx), requireRole('admin', 'staff'));

  const load = async (id: number): Promise<Row> => {
    const row: Row | undefined = await db(table).where({ id }).first();
    if (!row) throw notFound();
    return row;
  };
  const columns = (v: { name?: string; contact?: string | null; address?: string | null; phone?: string; description?: string | null }) => ({
    ...(v.name !== undefined && { name: v.name }),
    ...(v.contact !== undefined && { personal: v.contact }),
    ...(v.address !== undefined && { address: v.address }),
    ...(v.phone !== undefined && { phone: v.phone }),
    ...(v.description !== undefined && { description: v.description }),
  });

  router.get('/', requirePermission(`${table}:read`), async (req, res) => {
    // ?full=1 returns the details; the short form is what the pickers need
    const rows: Row[] = await db(table).orderBy('name');
    const data: Array<DirectoryEntryDto | DirectoryDto> = req.query.full ? rows.map(toEntry) : rows.map((r) => ({ id: r.id, name: r.name }));
    res.json({ data });
  });

  router.post('/', requirePermission(`${table}:create`), async (req, res) => {
    const user = requireUser(req);
    const input = directoryInputSchema.parse(req.body);
    const now = sqlNow();
    const [id] = await db(table).insert({ ...columns(input), created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: `${entity}.create`, entity, entityId: id as number });
    res.status(201).json({ entry: toEntry(await load(id as number)) });
  });

  router.patch('/:id', requirePermission(`${table}:update`), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = directoryUpdateSchema.parse(req.body);
    await load(id);
    await db(table).where({ id }).update({ ...columns(input), updated_at: sqlNow() });
    await audit(ctx, req, { userId: user.id, action: `${entity}.update`, entity, entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ entry: toEntry(await load(id)) });
  });

  router.delete('/:id', requirePermission(`${table}:delete`), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await load(id);
    // an entry that appears in orders or expenses stays, so those records keep their name
    const [orders, expenses] = await Promise.all([
      table === 'labs' ? db('lab_orders').where({ lab_id: id }).count({ n: '*' }).first() : undefined,
      db('expenses').where({ type: entity, model_id: id }).count({ n: '*' }).first(),
    ]);
    if (Number((orders as Row | undefined)?.n ?? 0) + Number((expenses as Row | undefined)?.n ?? 0) > 0) {
      throw conflict('IN_USE', `This ${entity} is used by existing records and cannot be deleted`);
    }
    await db(table).where({ id }).delete();
    await audit(ctx, req, { userId: user.id, action: `${entity}.delete`, entity, entityId: id });
    res.status(204).end();
  });

  return router;
}
