import { Router } from 'express';
import { z } from 'zod';
import { LAB_ACTIONS, LAB_STATUSES, labOrderInputSchema, labOrderUpdateSchema, type LabOrderDto, type Paginated } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { whereWords } from '../../lib/search';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';
import { limitToScope, moneyScope, round2 } from '../finance/service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  labId: z.coerce.number().int().positive().optional(),
  patientId: z.coerce.number().int().positive().optional(),
  status: z.enum(LAB_STATUSES).optional(),
  overdue: z.enum(['1', 'true']).optional(),
  q: z.string().trim().max(100).optional(),
});

/** Lab orders: staff and admins write them; a doctor reads those of his own patients, without the cost. */
export function labOrdersRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin', 'doctor', 'staff'));

  const today = () => clinicNow(env, ctx.clock()).date;

  const base = () =>
    db('lab_orders as o')
      .join('labs as l', 'l.id', 'o.lab_id')
      .join('patients as p', 'p.id', 'o.patient_id')
      .leftJoin('teeth as t', 't.id', 'o.tooth_id')
      .whereNull('o.deleted_at')
      .whereNull('p.deleted_at')
      .select('o.*', 'l.name as l_name', 'p.fname as p_fname', 'p.lname as p_lname', 't.index as t_index');

  const toDto = (r: Row, user: AuthUser): LabOrderDto => {
    const dto: LabOrderDto = {
      id: r.id, lab: { id: r.lab_id, name: r.l_name }, patient: { id: r.patient_id, fname: r.p_fname, lname: r.p_lname },
      item: r.item, tooth: r.tooth_id ? { id: r.tooth_id, index: String(r.t_index) } : null, appointmentId: r.appointment_id ?? null,
      currency: r.currency, status: r.status, sentAt: r.sent_at ?? null, dueAt: r.due_at ?? null, receivedAt: r.received_at ?? null,
      overdue: Boolean(r.due_at) && r.due_at < today() && (r.status === 'draft' || r.status === 'sent'),
    };
    if (user.role !== 'doctor') dto.cost = round2(Number(r.cost ?? 0));
    return dto;
  };

  /** One order the person may see; another doctor's patient's order is a 404. */
  async function load(user: AuthUser, id: number): Promise<Row> {
    const scope = await moneyScope(db, user);
    const qb = base().where('o.id', id);
    if (user.role === 'doctor') limitToScope(qb, scope);
    const row: Row | undefined = await qb.first();
    if (!row) throw notFound();
    return row;
  }

  /** The references of an order must exist (and the visit must be the patient's). */
  async function checkRefs(input: { labId?: number; patientId?: number; toothId?: number | null; appointmentId?: number | null }, patientId: number) {
    if (input.labId !== undefined && !(await db('labs').where({ id: input.labId }).first())) throw badRequest('LAB_NOT_FOUND', 'Choose a lab from the list');
    if (input.toothId && !(await db('teeth').where({ id: input.toothId }).first())) throw badRequest('TOOTH_NOT_FOUND', 'Choose a tooth from the chart');
    if (input.appointmentId) {
      const a = await db('appointments').where({ id: input.appointmentId, patient_id: patientId }).whereNull('deleted_at').first();
      if (!a) throw badRequest('APPOINTMENT_NOT_FOUND', 'That visit does not belong to this patient');
    }
  }

  router.get('/', requirePermission('labs:read'), async (req, res) => {
    const user = requireUser(req);
    const q = listQuery.parse(req.query);
    const scope = await moneyScope(db, user);
    const qb = base();
    if (user.role === 'doctor') limitToScope(qb, scope);
    if (q.labId) qb.where('o.lab_id', q.labId);
    if (q.patientId) qb.where('o.patient_id', q.patientId);
    if (q.status) qb.where('o.status', q.status);
    if (q.overdue) qb.where('o.due_at', '<', today()).whereIn('o.status', ['draft', 'sent']);
    if (q.q) whereWords(qb, ['o.item', 'l.name', 'p.fname', 'p.lname'], q.q);
    const totalRow = (await qb.clone().clearSelect().count({ n: '*' }).first()) as Row | undefined;
    const rows: Row[] = await qb.orderByRaw('CASE WHEN o.due_at IS NULL THEN 1 ELSE 0 END').orderBy('o.due_at').orderBy('o.id', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const body: Paginated<LabOrderDto> = { data: rows.map((r) => toDto(r, user)), meta: { page: q.page, pageSize: q.pageSize, total: Number(totalRow?.n ?? 0) } };
    res.json(body);
  });

  router.get('/:id', requirePermission('labs:read'), async (req, res) => {
    const user = requireUser(req);
    const row = await load(user, idParam.parse(req.params.id));
    await auditView(ctx, req, { user, action: 'lab_order.view', patientId: row.patient_id });
    res.json({ order: toDto(row, user) });
  });

  router.post('/', requirePermission('labs:create'), async (req, res) => {
    const user = requireUser(req);
    requireStaffWrite(user);
    const input = labOrderInputSchema.parse(req.body);
    if (!(await db('patients').where({ id: input.patientId }).whereNull('deleted_at').first())) throw badRequest('PATIENT_NOT_FOUND', 'Choose a patient from the list');
    await checkRefs(input, input.patientId);
    const now = sqlNow();
    const [id] = await db('lab_orders').insert({
      lab_id: input.labId, patient_id: input.patientId, item: input.item, tooth_id: input.toothId ?? null, appointment_id: input.appointmentId ?? null,
      cost: input.cost, currency: '$', due_at: input.dueAt ?? null, status: 'draft', created_at: now, updated_at: now,
    });
    await audit(ctx, req, { userId: user.id, action: 'lab_order.create', entity: 'lab_order', entityId: id as number, diff: { patientId: input.patientId, labId: input.labId } });
    res.status(201).json({ order: toDto(await load(user, id as number), user) });
  });

  router.patch('/:id', requirePermission('labs:update'), async (req, res) => {
    const user = requireUser(req);
    requireStaffWrite(user);
    const id = idParam.parse(req.params.id);
    const input = labOrderUpdateSchema.parse(req.body);
    const current = await load(user, id);
    if (current.status === 'fitted') throw conflict('ORDER_CLOSED', 'A fitted order can no longer be changed');
    await checkRefs(input, current.patient_id);
    await db('lab_orders').where({ id }).update({
      ...(input.labId !== undefined && { lab_id: input.labId }),
      ...(input.item !== undefined && { item: input.item }),
      ...(input.toothId !== undefined && { tooth_id: input.toothId }),
      ...(input.appointmentId !== undefined && { appointment_id: input.appointmentId }),
      ...(input.cost !== undefined && { cost: input.cost }),
      ...(input.dueAt !== undefined && { due_at: input.dueAt }),
      updated_at: sqlNow(),
    });
    await audit(ctx, req, { userId: user.id, action: 'lab_order.update', entity: 'lab_order', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ order: toDto(await load(user, id), user) });
  });

  /** draft -> sent -> received -> fitted, one step at a time. */
  const NEXT = { send: { from: 'draft', to: 'sent', stamp: 'sent_at' }, receive: { from: 'sent', to: 'received', stamp: 'received_at' }, fit: { from: 'received', to: 'fitted', stamp: null } } as const;

  router.post('/:id/:action', requirePermission('labs:update'), async (req, res) => {
    const user = requireUser(req);
    requireStaffWrite(user);
    const id = idParam.parse(req.params.id);
    const action = z.enum(LAB_ACTIONS).parse(req.params.action);
    const step = NEXT[action];
    const current = await load(user, id);
    if (current.status !== step.from) throw conflict('BAD_STATUS', `Only an order that is ${step.from} can be ${action === 'fit' ? 'marked fitted' : `${action === 'send' ? 'sent' : 'received'}`}`);
    await db('lab_orders').where({ id }).update({ status: step.to, ...(step.stamp && { [step.stamp]: today() }), updated_at: sqlNow() });
    await audit(ctx, req, { userId: user.id, action: `lab_order.${action}`, entity: 'lab_order', entityId: id });
    res.json({ order: toDto(await load(user, id), user) });
  });

  router.delete('/:id', requirePermission('labs:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await load(user, id);
    const now = sqlNow();
    await db('lab_orders').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'lab_order.delete', entity: 'lab_order', entityId: id });
    res.status(204).end();
  });

  return router;
}

/** The permission matrix gives doctors read access only; this keeps that true if the matrix changes. */
function requireStaffWrite(user: AuthUser): void {
  if (user.role === 'doctor') throw notFound();
}
