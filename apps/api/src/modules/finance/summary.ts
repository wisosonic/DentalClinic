import { Router } from 'express';
import { z } from 'zod';
import { EXPENSE_TYPES, type DoctorFiguresDto, type ExpenseType, type FinanceSummaryDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { doctorIdFor } from '../visits/access';
import { commissionStatement } from './commission';
import { monthlyTotals } from './months';
import { OWING, offerQuery } from '../offers/service';
import { round2 } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({ from: date.optional(), to: date.optional() });

/** The money in one page, for admins: what came in, what went out, the difference, and what patients still owe. */
export function summaryRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/summary', requireRole('admin'), requirePermission('payments:read'), async (req, res) => {
    const { from, to } = query.parse(req.query);
    const between = (qb: any, column: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
      if (from) qb.where(column, '>=', from);
      if (to) qb.where(column, '<=', to);
    };

    // Money received: payments from patients (of quotes that still exist), and commission specialists paid over.
    const fromPatients = (await db('payments as pay').join('treatment_offers as q', 'q.id', 'pay.offer_id').join('patients as p', 'p.id', 'q.patient_id')
      .where('pay.type', 'clinic').whereNull('pay.deleted_at').whereNull('q.deleted_at').whereNull('p.deleted_at')
      .modify((qb) => between(qb, 'pay.date')).sum({ total: 'pay.amount' }).count({ n: '*' }).first()) as Row | undefined;
    const commission = (await db('payments as pay').where('pay.type', 'commission').whereNull('pay.deleted_at')
      .modify((qb) => between(qb, 'pay.date')).sum({ total: 'pay.amount' }).count({ n: '*' }).first()) as Row | undefined;

    const spent: Row[] = await db('expenses as e').whereNull('e.deleted_at').modify((qb) => between(qb, 'e.date'))
      .select('e.type').sum({ total: 'e.amount' }).count({ n: '*' }).groupBy('e.type');
    const byType = EXPENSE_TYPES.map((type) => ({ type: type as ExpenseType, total: round2(Number(spent.find((r) => r.type === type)?.total ?? 0)) })).filter((x) => x.total > 0);
    const expensesTotal = round2(spent.reduce((s, r) => s + Number(r.total ?? 0), 0));

    const named = async (type: 'lab' | 'supplier', table: 'labs' | 'suppliers') => {
      const rows: Row[] = await db('expenses as e').join(`${table} as t`, 't.id', 'e.model_id').where('e.type', type).whereNull('e.deleted_at')
        .modify((qb) => between(qb, 'e.date')).select('t.id', 't.name').sum({ total: 'e.amount' }).groupBy('t.id', 't.name');
      return rows.map((r) => ({ id: r.id as number, name: r.name as string, total: round2(Number(r.total)) })).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
    };
    const byLab = await named('lab', 'labs');
    const bySupplier = await named('supplier', 'suppliers');

    const owing: Row[] = await offerQuery(db).whereIn('q.status', OWING);
    const perPatient = new Map<number, { patient: { id: number; fname: string; lname: string }; owed: number }>();
    let debtTotal = 0;
    let debtOffers = 0;
    for (const r of owing) {
      const left = round2(Number(r.price) - Number(r.paid));
      if (left <= 0) continue;
      debtTotal += left;
      debtOffers += 1;
      const cur = perPatient.get(r.patient_id) ?? { patient: { id: r.patient_id, fname: r.p_fname, lname: r.p_lname }, owed: 0 };
      cur.owed = round2(cur.owed + left);
      perPatient.set(r.patient_id, cur);
    }

    const received = [
      { type: 'clinic' as const, total: round2(Number(fromPatients?.total ?? 0)), count: Number(fromPatients?.n ?? 0) },
      { type: 'commission' as const, total: round2(Number(commission?.total ?? 0)), count: Number(commission?.n ?? 0) },
    ];
    const paymentsTotal = round2(received.reduce((sum, r) => sum + r.total, 0));
    const byMonth = await monthlyTotals(db, { from, to });

    const body: FinanceSummaryDto = {
      from: from ?? null, to: to ?? null,
      payments: { total: paymentsTotal, count: received.reduce((sum, r) => sum + r.count, 0), byType: received.filter((r) => r.count > 0) },
      expenses: { total: expensesTotal, count: spent.reduce((s, r) => s + Number(r.n ?? 0), 0), byType, byLab, bySupplier },
      byMonth: byMonth.slice(-36), // the last three years at most
      net: round2(paymentsTotal - expensesTotal),
      debts: { total: round2(debtTotal), patients: perPatient.size, offers: debtOffers, top: [...perPatient.values()].sort((a, b) => b.owed - a.owed).slice(0, 5) },
    };
    res.json(body);
  });

  // Each doctor's own figures: an admin sees every doctor's, a doctor only his own, staff none.
  router.get('/doctors', requireRole('admin', 'doctor'), requirePermission('payments:read'), async (req, res) => {
    const user = requireUser(req);
    const { from, to } = query.parse(req.query);
    const between = (qb: any, column: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
      if (from) qb.where(column, '>=', from);
      if (to) qb.where(column, '<=', to);
    };
    const me = user.role === 'admin' ? null : await doctorIdFor(db, user.id);
    if (user.role !== 'admin' && me === null) {
      res.json({ from: from ?? null, to: to ?? null, doctors: [] });
      return;
    }

    const doctors: Row[] = await db('doctors').modify((qb) => { if (me !== null) qb.where({ id: me }); }).orderBy(['kind', 'fname']).select('id', 'fname', 'lname', 'kind');
    const ids = doctors.map((d) => d.id as number);

    const offers: Row[] = ids.length
      ? await db('treatment_offers as q').join('patients as p', 'p.id', 'q.patient_id').whereNull('q.deleted_at').whereNull('p.deleted_at')
          .whereIn('p.doctor_id', ids).whereNot('q.status', 'draft').modify((qb) => { // created_at has a time; compare the day only so the last day of the period counts
            if (from) qb.whereRaw('substr(q.created_at, 1, 10) >= ?', [from]);
            if (to) qb.whereRaw('substr(q.created_at, 1, 10) <= ?', [to]);
          })
          .select('p.doctor_id').count({ n: '*' }).sum({ value: 'q.price' }).groupBy('p.doctor_id')
      : [];
    const collected: Row[] = ids.length
      ? await db('payments as pay').join('treatment_offers as q', 'q.id', 'pay.offer_id').join('patients as p', 'p.id', 'q.patient_id')
          .where('pay.type', 'clinic').whereNull('pay.deleted_at').whereNull('q.deleted_at').whereNull('p.deleted_at')
          .whereIn('pay.collected_by_doctor_id', ids).modify((qb) => between(qb, 'pay.date'))
          .select('pay.collected_by_doctor_id as doctor_id').sum({ total: 'pay.amount' }).groupBy('pay.collected_by_doctor_id')
      : [];
    const owing: Row[] = ids.length ? await offerQuery(db).whereIn('q.status', OWING).whereIn('p.doctor_id', ids) : [];
    const debts = new Map<number, number>();
    for (const r of owing) {
      const left = round2(Number(r.price) - Number(r.paid));
      if (left > 0) debts.set(r.p_doctor_id, round2((debts.get(r.p_doctor_id) ?? 0) + left));
    }
    const statement = await commissionStatement(db, from, to);

    const body: { from: string | null; to: string | null; doctors: DoctorFiguresDto[] } = {
      from: from ?? null, to: to ?? null,
      doctors: doctors.map((d) => {
        const q = offers.find((r) => r.doctor_id === d.id);
        const lines = statement.rows.filter((l) => (d.kind === 'owner' ? l.ownerId === d.id : l.specialist.id === d.id));
        const unknown = lines.some((l) => l.balance === null);
        const fees = statement.fees.filter((f) => (d.kind === 'owner' ? f.owner?.id === d.id : f.specialist.id === d.id));
        return {
          doctor: { id: d.id, fname: d.fname, lname: d.lname, kind: d.kind },
          offers: { count: Number(q?.n ?? 0), value: round2(Number(q?.value ?? 0)) },
          collected: round2(Number(collected.find((r) => r.doctor_id === d.id)?.total ?? 0)),
          debts: debts.get(d.id) ?? 0,
          commissionBalance: unknown ? null : round2(lines.reduce((sum, l) => sum + (l.balance ?? 0), 0)),
          fees: round2(fees.reduce((sum, f) => sum + f.paid, 0)),
        };
      }),
    };
    res.json(body);
  });

  return router;
}
