import { Router } from 'express';
import { z } from 'zod';
import {
  commissionPaymentInputSchema, commissionPaymentUpdateSchema,
  type CommissionFeeDto, type CommissionLineDto, type CommissionPaymentDto, type CommissionStatementDto, type PaymentMethod,
} from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { sqlNow } from '../../db/connection';
import { badRequest, notFound } from '../../lib/errors';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { doctorIdFor } from '../visits/access';
import { round2 } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z.object({ from: date.optional(), to: date.optional() });
const FAR = '9999-12-31';

const person = (r: Row, prefix: string) => ({ id: r[`${prefix}_id`] as number, fname: r[`${prefix}_fname`] as string, lname: r[`${prefix}_lname`] as string });

/**
 * Works out what each outside specialist owes the owner of the dental unit he used (owner decision):
 * the specialist's percentage of what he actually collected from patients, for the owner of the unit of
 * the patient's latest completed visit on or before the payment date, less what he has already paid over.
 * Everything is in cents-safe numbers and figures for a period are separate from the running balance.
 */
export async function commissionStatement(db: Db, from: string | undefined, to: string | undefined): Promise<CommissionStatementDto & { rows: (CommissionLineDto & { ownerId: number | null; oldestCollected: string | null; lastReceived: string | null })[] }> {
  const start = from ?? '0000-01-01';
  const end = to ?? FAR;

  const specialists: Row[] = await db('doctors').where({ kind: 'external' }).select('id', 'fname', 'lname', 'commission_percent');
  const spec = new Map<number, Row>(specialists.map((d) => [d.id, d]));

  // Money the specialists collected from patients (clinic payments of their own patients).
  const collected: Row[] = specialists.length
    ? await db('payments as pay').join('treatment_offers as q', 'q.id', 'pay.offer_id').join('patients as p', 'p.id', 'q.patient_id')
        .where('pay.type', 'clinic').whereNull('pay.deleted_at').whereNull('q.deleted_at').whereNull('p.deleted_at')
        .whereIn('p.doctor_id', specialists.map((d) => d.id)).where('pay.date', '<=', end)
        .select('pay.id', 'pay.date', 'pay.amount', 'p.id as patient_id', 'p.doctor_id')
    : [];

  // Each patient's completed visits with the owner of the unit, to find the latest one before each payment.
  const patientIds = [...new Set(collected.map((c) => c.patient_id as number))];
  const visits: Row[] = patientIds.length
    ? await db('appointments as a').join('dental_units as u', 'u.id', 'a.unit_id')
        .whereIn('a.patient_id', patientIds).where('a.status', 'completed').whereNull('a.deleted_at')
        .orderBy([{ column: 'a.date' }, { column: 'a.time' }]).select('a.patient_id', 'a.date', 'u.owner_doctor_id')
    : [];
  const byPatient = new Map<number, Row[]>();
  for (const v of visits) byPatient.set(v.patient_id, [...(byPatient.get(v.patient_id) ?? []), v]);
  const ownerFor = (patientId: number, day: string): number | null => {
    let found: number | null = null;
    for (const v of byPatient.get(patientId) ?? []) if (v.date <= day) found = v.owner_doctor_id;
    return found;
  };

  const received: Row[] = await db('payments').where({ type: 'commission' }).whereNull('deleted_at').where('date', '<=', end).select('model_id', 'collected_by_doctor_id', 'date', 'amount');

  type Group = { specialistId: number; ownerId: number | null; collectedUpTo: number; collectedPeriod: number; receivedUpTo: number; receivedPeriod: number; oldestCollected: string | null; lastReceived: string | null };
  const groups = new Map<string, Group>();
  const group = (specialistId: number, ownerId: number | null): Group => {
    const key = `${specialistId}:${ownerId ?? ''}`;
    if (!groups.has(key)) groups.set(key, { specialistId, ownerId, collectedUpTo: 0, collectedPeriod: 0, receivedUpTo: 0, receivedPeriod: 0, oldestCollected: null, lastReceived: null });
    return groups.get(key)!;
  };
  for (const c of collected) {
    const g = group(c.doctor_id, ownerFor(c.patient_id, c.date));
    g.collectedUpTo += Number(c.amount);
    if (!g.oldestCollected || c.date < g.oldestCollected) g.oldestCollected = c.date;
    if (c.date >= start) g.collectedPeriod += Number(c.amount);
  }
  for (const r of received) {
    if (!r.model_id) continue;
    const g = group(r.model_id, r.collected_by_doctor_id ?? null);
    g.receivedUpTo += Number(r.amount);
    if (!g.lastReceived || r.date > g.lastReceived) g.lastReceived = r.date;
    if (r.date >= start) g.receivedPeriod += Number(r.amount);
  }

  const people = new Map<number, Row>((await db('doctors').select('id', 'fname', 'lname')).map((d: Row) => [d.id, d]));
  const lines: (CommissionLineDto & { ownerId: number | null; oldestCollected: string | null; lastReceived: string | null })[] = [];
  for (const g of groups.values()) {
    const s = spec.get(g.specialistId);
    if (!s) continue;
    const pct = s.commission_percent == null ? null : Number(s.commission_percent);
    const owedPeriod = pct === null ? null : round2((g.collectedPeriod * pct) / 100);
    const owedUpTo = pct === null ? null : round2((g.collectedUpTo * pct) / 100);
    const balance = owedUpTo === null ? null : round2(owedUpTo - g.receivedUpTo);
    if (!g.collectedPeriod && !g.receivedPeriod && !balance) continue;
    const o = g.ownerId ? people.get(g.ownerId) : undefined;
    lines.push({
      specialist: { id: s.id, fname: s.fname, lname: s.lname, commissionPercent: pct },
      owner: o ? { id: o.id, fname: o.fname, lname: o.lname } : null, ownerId: g.ownerId, oldestCollected: g.oldestCollected, lastReceived: g.lastReceived,
      collected: round2(g.collectedPeriod), owed: owedPeriod, received: round2(g.receivedPeriod), balance,
    });
  }
  lines.sort((a, b) => `${a.specialist.fname}${a.owner?.fname ?? '~'}`.localeCompare(`${b.specialist.fname}${b.owner?.fname ?? '~'}`));

  // Fees an owner paid a specialist for treating the owner's patient (commission expenses): the specialist owes nothing on these.
  const feeRows: Row[] = await db('expenses as e').leftJoin('appointments as a', 'a.id', 'e.appointment_id').leftJoin('patients as p', 'p.id', 'a.patient_id')
    .join('doctors as sd', 'sd.id', 'e.model_id').leftJoin('doctors as od', 'od.id', 'p.doctor_id')
    .where('e.type', 'commission').whereNull('e.deleted_at').where('e.date', '>=', start).where('e.date', '<=', end)
    .select('e.amount', 'sd.id as s_id', 'sd.fname as s_fname', 'sd.lname as s_lname', 'od.id as o_id', 'od.fname as o_fname', 'od.lname as o_lname');
  const feeMap = new Map<string, CommissionFeeDto>();
  for (const f of feeRows) {
    const key = `${f.s_id}:${f.o_id ?? ''}`;
    const cur = feeMap.get(key) ?? { specialist: person(f, 's'), owner: f.o_id ? person(f, 'o') : null, paid: 0, count: 0 };
    cur.paid = round2(cur.paid + Number(f.amount));
    cur.count += 1;
    feeMap.set(key, cur);
  }

  const missing = specialists.filter((s) => s.commission_percent == null && groups.size && [...groups.values()].some((g) => g.specialistId === s.id && g.collectedUpTo > 0));
  return {
    lines: lines.map(({ ownerId: _o, oldestCollected: _a, lastReceived: _b, ...l }) => l), rows: lines, fees: [...feeMap.values()],
    missingPercentage: missing.map((s) => ({ id: s.id, fname: s.fname, lname: s.lname })),
  };
}

/** What each person may see of the commission figures: admins all, an owner his own, a specialist his own. */
async function scoped(db: Db, user: AuthUser, s: Awaited<ReturnType<typeof commissionStatement>>): Promise<CommissionStatementDto> {
  const { rows, ...rest } = s;
  if (user.role === 'admin') return { lines: rest.lines, fees: rest.fees, missingPercentage: rest.missingPercentage };
  const me = user.role === 'doctor' ? await doctorIdFor(db, user.id) : null;
  if (me === null) return { lines: [], fees: [], missingPercentage: [] };
  const mine = await db('doctors').where({ id: me }).first('kind');
  const isOwner = mine?.kind === 'owner';
  return {
    lines: rows.filter((r) => (isOwner ? r.ownerId === me : r.specialist.id === me)).map(({ ownerId: _o, oldestCollected: _a, lastReceived: _b, ...l }) => l),
    fees: rest.fees.filter((f) => (isOwner ? f.owner?.id === me : f.specialist.id === me)),
    missingPercentage: [],
  };
}

const toPaymentDto = (r: Row): CommissionPaymentDto => ({
  id: r.id, date: r.date, amount: round2(Number(r.amount)), currency: r.currency, method: (r.method as PaymentMethod | null) ?? null, description: r.description ?? null,
  specialist: r.s_id ? person(r, 's') : null, owner: r.o_id ? person(r, 'o') : null,
});

/** Commission: the statement, and the payments specialists make to the owners. Staff have no part in it. */
export function commissionRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin', 'doctor'));

  const payments = () =>
    db('payments as pay').leftJoin('doctors as sd', 'sd.id', 'pay.model_id').leftJoin('doctors as od', 'od.id', 'pay.collected_by_doctor_id')
      .where('pay.type', 'commission').whereNull('pay.deleted_at')
      .select('pay.*', 'sd.id as s_id', 'sd.fname as s_fname', 'sd.lname as s_lname', 'od.id as o_id', 'od.fname as o_fname', 'od.lname as o_lname');

  /** Whose commission payments these are: an owner the ones he received, a specialist the ones he paid. */
  async function mineOnly(user: AuthUser) {
    if (user.role === 'admin') return { all: true as const };
    const me = await doctorIdFor(db, user.id);
    const kind = me ? (await db('doctors').where({ id: me }).first('kind'))?.kind : null;
    return { all: false as const, me, kind: kind as 'owner' | 'external' | null };
  }

  router.get('/statement', requirePermission('payments:read'), async (req, res) => {
    const user = requireUser(req);
    const { from, to } = range.parse(req.query);
    res.json(await scoped(db, user, await commissionStatement(db, from, to)));
  });

  router.get('/payments', requirePermission('payments:read'), async (req, res) => {
    const user = requireUser(req);
    const { from, to } = range.parse(req.query);
    const who = await mineOnly(user);
    const rows: Row[] = await payments().modify((qb) => {
      if (!who.all) {
        if (!who.me) qb.whereRaw('1 = 0');
        else if (who.kind === 'owner') qb.where('pay.collected_by_doctor_id', who.me);
        else qb.where('pay.model_id', who.me);
      }
      if (from) qb.where('pay.date', '>=', from);
      if (to) qb.where('pay.date', '<=', to);
    }).orderBy([{ column: 'pay.date', order: 'desc' }, { column: 'pay.id', order: 'desc' }]).limit(500);
    res.json({ data: rows.map(toPaymentDto) });
  });

  /** An owner records what he received; an admin can record for any owner. Never a specialist. */
  async function mayRecordFor(user: AuthUser, ownerId: number): Promise<void> {
    if (user.role === 'admin') return;
    const who = await mineOnly(user);
    if (!who.me || who.kind !== 'owner' || who.me !== ownerId) throw notFound('Not found');
  }

  async function checkParties(specialistId: number, ownerId: number): Promise<void> {
    const s = await db('doctors').where({ id: specialistId }).first('kind');
    if (!s) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    if (s.kind !== 'external') throw badRequest('NOT_A_SPECIALIST', 'Commission is paid by an outside specialist');
    const o = await db('doctors').where({ id: ownerId }).first('kind');
    if (!o) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    if (o.kind !== 'owner') throw badRequest('NOT_AN_OWNER', 'Commission is received by an owner doctor');
  }

  router.post('/payments', requirePermission('payments:create'), async (req, res) => {
    const user = requireUser(req);
    const input = commissionPaymentInputSchema.parse(req.body);
    await mayRecordFor(user, input.ownerId);
    await checkParties(input.specialistId, input.ownerId);
    if (input.date > clinicNow(env, ctx.clock()).date) throw badRequest('FUTURE_DATE', 'A payment cannot be dated in the future');
    const now = sqlNow();
    const [id] = await db('payments').insert({
      date: input.date, type: 'commission', amount: input.amount, remaining: null, currency: '$', description: input.description ?? null, method: input.method,
      offer_id: null, model_id: input.specialistId, collected_by_doctor_id: input.ownerId, dr_part: 100, created_by: user.id, created_at: now, updated_at: now,
    });
    await audit(ctx, req, { userId: user.id, action: 'commission.payment.create', entity: 'payment', entityId: id as number, diff: { specialistId: input.specialistId, ownerId: input.ownerId, amount: input.amount } });
    res.status(201).json({ payment: toPaymentDto((await payments().where('pay.id', id).first())!) });
  });

  async function loadMine(user: AuthUser, id: number): Promise<Row> {
    const row = await payments().where('pay.id', id).first();
    if (!row) throw notFound('Payment not found');
    await mayRecordFor(user, row.collected_by_doctor_id).catch(() => { throw notFound('Payment not found'); });
    return row;
  }

  router.patch('/payments/:id', requirePermission('payments:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = commissionPaymentUpdateSchema.parse(req.body);
    const current = await loadMine(user, id);
    if (input.date && input.date > clinicNow(env, ctx.clock()).date) throw badRequest('FUTURE_DATE', 'A payment cannot be dated in the future');
    const update: Record<string, unknown> = { updated_at: sqlNow() };
    if (input.ownerId !== undefined && input.ownerId !== current.collected_by_doctor_id) {
      // Who received it: an admin may assign any owner; an owner only himself. It must be an owner, and the payment keeps its specialist.
      await mayRecordFor(user, input.ownerId);
      await checkParties(current.model_id, input.ownerId);
      update.collected_by_doctor_id = input.ownerId;
    }
    for (const [k, col] of [['amount', 'amount'], ['date', 'date'], ['method', 'method'], ['description', 'description']] as const) if (input[k] !== undefined) update[col] = input[k];
    await db('payments').where({ id }).update(update);
    await audit(ctx, req, { userId: user.id, action: 'commission.payment.update', entity: 'payment', entityId: id, diff: { fields: Object.keys(input), ...(update.collected_by_doctor_id ? { ownerId: update.collected_by_doctor_id } : {}) } });
    res.json({ payment: toPaymentDto((await payments().where('pay.id', id).first())!) });
  });

  router.delete('/payments/:id', requirePermission('payments:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await loadMine(user, id);
    const now = sqlNow();
    await db('payments').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'commission.payment.delete', entity: 'payment', entityId: id });
    res.status(204).end();
  });

  return router;
}
