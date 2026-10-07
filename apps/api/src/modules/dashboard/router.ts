import { Router } from 'express';
import { ACTIVE_STATUSES, APPOINTMENT_STATUSES, type DashboardChartsDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { limitToScope, moneyScope, round2 } from '../finance/service';
import { OWING, offerQuery } from '../offers/service';
import { monthlyTotals } from '../finance/months';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/** 'YYYY-MM-DD' plus days, in UTC so daylight saving never shifts it. */
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The first day of the month `back` months before the month of `date`. */
const monthStart = (date: string, back: number): string => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 10);
};

/**
 * The charts under the dashboard tiles. One request, shaped by role so a person never receives data they
 * may not see: an admin gets the clinic, a doctor only his own patients' figures (no expenses), staff
 * the front desk's view (no money). Patients have no reports permission and get 403.
 */
export function dashboardRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin', 'doctor', 'staff'));

  router.get('/charts', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    const today = clinicNow(env, ctx.clock()).date;

    if (user.role === 'staff') {
      const end = addDays(today, 6);
      const perDay: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').whereNull('a.deleted_at').whereNull('p.deleted_at')
        .whereIn('a.status', ACTIVE_STATUSES).whereBetween('a.date', [today, end]).select('a.date').count({ n: '*' }).groupBy('a.date');
      const overdue = db('lab_orders as o').join('patients as p', 'p.id', 'o.patient_id').join('labs as l', 'l.id', 'o.lab_id').whereNull('o.deleted_at').whereNull('p.deleted_at')
        .where('o.due_at', '<', today).whereIn('o.status', ['draft', 'sent']);
      const overdueCount = (await overdue.clone().count({ n: '*' }).first()) as Row | undefined;
      const oldest: Row[] = await overdue.clone().orderBy('o.due_at').orderBy('o.id').limit(5)
        .select('o.id', 'o.item', 'o.due_at', 'l.name as lab', 'p.id as pid', 'p.fname', 'p.lname');
      const toBook = (await db('treatment_offers as q').join('patients as p', 'p.id', 'q.patient_id').whereNull('q.deleted_at').whereNull('p.deleted_at')
        .where('q.status', 'accepted').whereExists((s) => s.select(db.raw('1')).from('offer_items as i').whereRaw('i.offer_id = q.id').where('i.status', 'pending'))
        .count({ n: '*' }).first()) as Row | undefined;
      const body: DashboardChartsDto = {
        role: 'staff',
        appointmentsPerDay: Array.from({ length: 7 }, (_, i) => {
          const date = addDays(today, i);
          return { date, count: Number(perDay.find((r) => r.date === date)?.n ?? 0) };
        }),
        overdueLabOrders: {
          count: Number(overdueCount?.n ?? 0),
          oldest: oldest.map((r) => ({ id: r.id, item: r.item, lab: r.lab, patient: { id: r.pid, fname: r.fname, lname: r.lname }, dueAt: r.due_at })),
        },
        offersToBook: Number(toBook?.n ?? 0),
      };
      res.json(body);
      return;
    }

    // Admin: the whole clinic. Doctor: his own patients (and visits he treats); an unlinked doctor has none.
    const scope = await moneyScope(db, user);
    const role = user.role === 'admin' ? 'admin' : 'doctor';
    const mine = scope.all ? null : scope.doctorId;
    if (!scope.all && mine === null) {
      res.json({ role, byMonth: [], debtsByMonth: [], appointmentsByMonth: [], topDebts: [], appointmentsByStatus: [], topProcedures: [] } satisfies DashboardChartsDto);
      return;
    }
    const ownVisits = (qb: any) => { if (mine !== null) qb.where((w: any) => w.where('a.doctor_id', mine).orWhere('p.doctor_id', mine)); }; // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder

    const byMonth = await monthlyTotals(db, { from: monthStart(today, 5), to: today, doctorId: mine });

    const owing: Row[] = await (() => { const qb = offerQuery(db).whereIn('q.status', OWING); limitToScope(qb, scope); return qb; })();
    const perPatient = new Map<number, { patient: { id: number; fname: string; lname: string }; owed: number }>();
    for (const r of owing) {
      const left = round2(Number(r.price) - Number(r.paid));
      if (left <= 0) continue;
      const cur = perPatient.get(r.patient_id) ?? { patient: { id: r.patient_id, fname: r.p_fname, lname: r.p_lname }, owed: 0 };
      cur.owed = round2(cur.owed + left);
      perPatient.set(r.patient_id, cur);
    }

    // What was owed at the end of each month: the offers made by then, less the payments dated by then (a month still
    // running ends today). It uses each offer's price as it is now, so it is an honest picture, not an accounting history.
    const payments: Row[] = owing.length ? await db('payments').whereIn('offer_id', owing.map((r) => r.id)).whereNull('deleted_at').select('offer_id', 'date', 'amount') : [];
    const debtsByMonth = byMonth.map((m) => {
      const [y, mo] = m.month.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); // the month's last day
      const end = last < today ? last : today;
      let owed = 0;
      for (const o of owing) {
        if (String(o.created_at).slice(0, 10) > end) continue;
        const paid = payments.filter((p) => p.offer_id === o.id && String(p.date) <= end).reduce((sum, p) => sum + Number(p.amount), 0);
        owed += Math.max(0, round2(Number(o.price) - paid));
      }
      return { month: m.month, owed: round2(owed) };
    });

    // Visits in each of the six months, the current one whole (what is booked for the rest of it counts), cancelled ones left out.
    const firstDay = `${byMonth[0]?.month ?? today.slice(0, 7)}-01`;
    const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const perMonth: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').whereNull('a.deleted_at').whereNull('p.deleted_at')
      .whereIn('a.status', [...ACTIVE_STATUSES, 'no_show']).whereBetween('a.date', [firstDay, lastDay]).modify(ownVisits)
      .select(db.raw('substr(a.date, 1, 7) as month')).count({ n: '*' }).groupByRaw('substr(a.date, 1, 7)');
    const appointmentsByMonth = byMonth.map((m) => ({ month: m.month, count: Number(perMonth.find((r) => r.month === m.month)?.n ?? 0) }));

    const since = addDays(today, -29);
    const byStatus: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').whereNull('a.deleted_at').whereNull('p.deleted_at')
      .whereBetween('a.date', [since, today]).modify(ownVisits).select('a.status').count({ n: '*' }).groupBy('a.status');
    const procedures: Row[] = await db('appointment_category as ac').join('appointments as a', 'a.id', 'ac.appointment_id').join('patients as p', 'p.id', 'a.patient_id')
      .join('categories as c', 'c.id', 'ac.category_id').whereNull('a.deleted_at').whereNull('p.deleted_at')
      .whereIn('a.status', ACTIVE_STATUSES).whereBetween('a.date', [addDays(today, -89), today]).modify(ownVisits)
      .select('c.id', 'c.name').count({ n: '*' }).groupBy('c.id', 'c.name').orderBy('n', 'desc').orderBy('c.name').limit(10);

    const body: DashboardChartsDto = {
      role,
      byMonth,
      debtsByMonth,
      appointmentsByMonth,
      topDebts: [...perPatient.values()].sort((a, b) => b.owed - a.owed).slice(0, 5),
      appointmentsByStatus: APPOINTMENT_STATUSES.map((status) => ({ status, count: Number(byStatus.find((r) => r.status === status)?.n ?? 0) })),
      topProcedures: procedures.map((r) => ({ id: r.id, name: r.name, count: Number(r.n) })),
    };
    res.json(body);
  });

  return router;
}
