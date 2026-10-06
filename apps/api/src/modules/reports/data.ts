import { ACTIVE_STATUSES } from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { clinicNow } from '../../lib/time';
import type { AuthUser } from '../../middleware/auth';
import { doctorScope } from '../../lib/scope';
import { appointmentQuery } from '../appointments/service';
import { monthlyTotals } from '../finance/months';
import { limitToScope, moneyScope, round2 } from '../finance/service';
import { OWING, offerQuery } from '../offers/service';
import type { ReportTable } from './render';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/**
 * Up to `sync` rows a report is made while the person waits. Bigger Excel reports, up to `background` rows, are
 * made in the background (see jobs.ts); beyond that the period must be shorter. An object, so tests can lower them.
 */
export const REPORT_LIMITS = { sync: 50_000, background: 500_000 };

export interface Period { from: string; to: string }
const label = (p: Period) => `${p.from} to ${p.to}`;
const name = (fname: string, lname: string) => `${fname} ${lname}`.trim();

/** Procedures of each appointment, as "A, B" (one query for all of them). */
async function proceduresOf(db: Db, ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string[]>();
  if (!ids.length) return new Map();
  const rows: Row[] = await db('appointment_category as ac').join('categories as c', 'c.id', 'ac.category_id').whereIn('ac.appointment_id', ids).orderBy('c.name').select('ac.appointment_id as id', 'c.name');
  for (const r of rows) map.set(r.id, [...(map.get(r.id) ?? []), r.name]);
  return new Map([...map].map(([k, v]) => [k, v.join(', ')]));
}

const endOf = (time: string, minutes: number) => {
  const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Every appointment of a day, to print for the front desk: no phone numbers and no notes. */
export async function dailySchedule(ctx: AppContext, user: AuthUser, date: string, doctorId?: number): Promise<ReportTable> {
  const { db } = ctx;
  const scope = await doctorScope(db, user);
  const qb = appointmentQuery(db).where('a.date', date).whereIn('a.status', ACTIVE_STATUSES);
  if (doctorId) qb.where('a.doctor_id', doctorId);
  // a specialist sees the visits he treats and those of his own patients; a login with no profile sees none
  if (scope.restricted) {
    if (scope.doctorId === null) qb.whereRaw('1 = 0');
    else qb.where((w) => w.where('a.doctor_id', scope.doctorId!).orWhere('p.doctor_id', scope.doctorId!));
  }
  const rows: Row[] = await qb.orderBy('a.time').orderBy('a.id');
  const procedures = await proceduresOf(db, rows.map((r) => r.id));
  return {
    title: 'Daily schedule', subtitle: `${date} · ${rows.length} appointment${rows.length === 1 ? '' : 's'}`,
    columns: [
      { key: 'time', header: 'Time', type: 'text', width: 12 }, { key: 'patient', header: 'Patient', type: 'text', width: 22 }, { key: 'doctor', header: 'Doctor', type: 'text', width: 20 },
      { key: 'unit', header: 'Dental unit', type: 'text', width: 18 }, { key: 'procedures', header: 'Procedures', type: 'text', width: 26 }, { key: 'status', header: 'Status', type: 'text', width: 11 },
    ],
    rows: rows.map((r) => ({
      time: `${r.time}–${endOf(r.time, r.duration_minutes)}`, patient: name(r.p_fname, r.p_lname), doctor: `Dr ${name(r.d_fname, r.d_lname)}`, unit: r.u_name ?? '',
      procedures: procedures.get(r.id) ?? '', status: String(r.status).replace('_', ' '),
    })),
  };
}

export type RevenueGroup = 'month' | 'type' | 'doctor';

/** Payments received and money spent for a period. An admin sees everything; a doctor only his own patients' payments. */
export async function revenue(ctx: AppContext, user: AuthUser, p: Period, group: RevenueGroup): Promise<ReportTable> {
  const { db } = ctx;
  const scope = await moneyScope(db, user);
  const mine = scope.all ? null : scope.doctorId;
  const subtitle = `${label(p)}${mine === null ? '' : ' · your patients'}`;

  if (group === 'month') {
    const months = mine === null || scope.doctorId !== null ? await monthlyTotals(db, { from: p.from, to: p.to, doctorId: mine }) : [];
    const columns: ReportTable['columns'] = [{ key: 'month', header: 'Month', type: 'text', width: 14 }, { key: 'payments', header: 'Payments', type: 'money', width: 16 }];
    if (scope.all) columns.push({ key: 'expenses', header: 'Expenses', type: 'money', width: 16 }, { key: 'net', header: 'Net', type: 'money', width: 16 });
    return {
      title: 'Revenue and expenses by month', subtitle, columns,
      rows: months.map((m) => ({ month: m.month, payments: m.payments, ...(scope.all ? { expenses: m.expenses, net: round2(m.payments - m.expenses) } : {}) })),
      totals: { label: 'Total', sum: scope.all ? ['payments', 'expenses', 'net'] : ['payments'] },
    };
  }

  if (group === 'type') {
    const between = (qb: any, col: string) => qb.where(col, '>=', p.from).where(col, '<=', p.to); // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
    const pay: Row[] = await db('payments as pay').leftJoin('quotes as q', 'q.id', 'pay.quote_id').leftJoin('patients as pt', 'pt.id', 'q.patient_id').whereNull('pay.deleted_at')
      .whereRaw("(pay.type = 'commission' OR (pay.type = 'clinic' AND q.deleted_at IS NULL AND pt.deleted_at IS NULL))").modify((qb) => between(qb, 'pay.date'))
      .modify((qb) => { if (mine !== null) qb.where('pay.type', 'clinic').where('pt.doctor_id', mine); else if (!scope.all) qb.whereRaw('1 = 0'); })
      .select('pay.type').sum({ total: 'pay.amount' }).count({ n: '*' }).groupBy('pay.type');
    const exp: Row[] = scope.all
      ? await db('expenses as e').whereNull('e.deleted_at').modify((qb) => between(qb, 'e.date')).select('e.type').sum({ total: 'e.amount' }).count({ n: '*' }).groupBy('e.type')
      : [];
    const PAY = { clinic: 'From patients', commission: 'Commission received' } as Record<string, string>;
    return {
      title: 'Revenue and expenses by type', subtitle,
      columns: [{ key: 'kind', header: 'Kind', type: 'text', width: 14 }, { key: 'type', header: 'Type', type: 'text', width: 24 }, { key: 'count', header: 'Count', type: 'int', width: 10 }, { key: 'amount', header: 'Amount', type: 'money', width: 16 }],
      rows: [
        ...pay.map((r) => ({ kind: 'Payments', type: PAY[r.type] ?? r.type, count: Number(r.n), amount: round2(Number(r.total)) })),
        ...exp.map((r) => ({ kind: 'Expenses', type: String(r.type), count: Number(r.n), amount: round2(Number(r.total)) })),
      ],
    };
  }

  // by doctor: who collected what (admin only)
  const rows: Row[] = await db('payments as pay').leftJoin('doctors as d', 'd.id', 'pay.collected_by_doctor_id').leftJoin('quotes as q', 'q.id', 'pay.quote_id').leftJoin('patients as pt', 'pt.id', 'q.patient_id')
    .whereNull('pay.deleted_at').whereRaw("(pay.type = 'commission' OR (pay.type = 'clinic' AND q.deleted_at IS NULL AND pt.deleted_at IS NULL))")
    .where('pay.date', '>=', p.from).where('pay.date', '<=', p.to).select('d.id', 'd.fname', 'd.lname', 'pay.type').sum({ total: 'pay.amount' }).count({ n: '*' }).groupBy('d.id', 'd.fname', 'd.lname', 'pay.type');
  const byDoctor = new Map<string, { doctor: string; collected: number; commission: number; count: number }>();
  for (const r of rows) {
    const key = String(r.id ?? 'none');
    const cur = byDoctor.get(key) ?? { doctor: r.id ? `Dr ${name(r.fname, r.lname)}` : 'No collecting doctor', collected: 0, commission: 0, count: 0 };
    if (r.type === 'commission') cur.commission = round2(cur.commission + Number(r.total)); else cur.collected = round2(cur.collected + Number(r.total));
    cur.count += Number(r.n);
    byDoctor.set(key, cur);
  }
  return {
    title: 'Payments by doctor', subtitle,
    columns: [{ key: 'doctor', header: 'Doctor', type: 'text', width: 26 }, { key: 'count', header: 'Payments', type: 'int', width: 10 }, { key: 'collected', header: 'From patients', type: 'money', width: 16 }, { key: 'commission', header: 'Commission received', type: 'money', width: 20 }, { key: 'total', header: 'Total', type: 'money', width: 16 }],
    rows: [...byDoctor.values()].sort((a, b) => b.collected + b.commission - (a.collected + a.commission)).map((r) => ({ ...r, total: round2(r.collected + r.commission) })),
    totals: { label: 'Total', sum: ['count', 'collected', 'commission', 'total'] },
  };
}

/** Who owes what on open quotes, biggest balance first. Admin: all; a doctor: his own patients'. */
export async function outstandingBalances(ctx: AppContext, user: AuthUser): Promise<ReportTable> {
  const { db } = ctx;
  const scope = await moneyScope(db, user);
  const qb = offerQuery(db).whereIn('q.status', OWING);
  limitToScope(qb, scope);
  const rows: Row[] = await qb;
  const open = rows.map((r): Row & { remaining: number } => ({ ...r, remaining: round2(Number(r.price) - Number(r.paid)) })).filter((r) => r.remaining > 0).sort((a, b) => b.remaining - a.remaining);
  return {
    title: 'Outstanding balances', subtitle: `As of ${clinicNow(ctx.env, ctx.clock()).date}${scope.all ? '' : ' · your patients'}`,
    columns: [
      { key: 'patient', header: 'Patient', type: 'text', width: 24 }, { key: 'quote', header: 'Quote', type: 'text', width: 26 }, { key: 'status', header: 'Status', type: 'text', width: 14 },
      { key: 'price', header: 'Price', type: 'money', width: 14 }, { key: 'paid', header: 'Paid', type: 'money', width: 14 }, { key: 'remaining', header: 'Remaining', type: 'money', width: 14 },
    ],
    rows: open.map((r) => ({ patient: name(r.p_fname, r.p_lname), quote: r.title, status: String(r.status).replace('_', ' '), price: round2(Number(r.price)), paid: round2(Number(r.paid)), remaining: r.remaining })),
    totals: { label: 'Total', sum: ['price', 'paid', 'remaining'] },
  };
}

/** The patients' own doctor filter shared by the analytic lists: admin all; a doctor his own patients; none for an unlinked login. */
async function ownPatients(ctx: AppContext, user: AuthUser, qb: any): Promise<void> { // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
  limitToScope(qb, await moneyScope(ctx.db, user));
}

export async function appointmentsList(ctx: AppContext, user: AuthUser, p: Period, filters: { doctorId?: number; status?: string }, max = REPORT_LIMITS.sync): Promise<ReportTable> {
  const qb = appointmentQuery(ctx.db).where('a.date', '>=', p.from).where('a.date', '<=', p.to);
  if (filters.doctorId) qb.where('a.doctor_id', filters.doctorId);
  if (filters.status) qb.whereIn('a.status', filters.status.split(','));
  await ownPatients(ctx, user, qb);
  const rows: Row[] = await qb.orderBy('a.date').orderBy('a.time').limit(max + 1);
  const procedures = await proceduresOf(ctx.db, rows.map((r) => r.id));
  return {
    title: 'Appointments', subtitle: label(p),
    columns: [
      { key: 'date', header: 'Date', type: 'text', width: 12 }, { key: 'time', header: 'Time', type: 'text', width: 8 }, { key: 'patient', header: 'Patient', type: 'text', width: 24 }, { key: 'doctor', header: 'Doctor', type: 'text', width: 22 },
      { key: 'clinic', header: 'Clinic', type: 'text', width: 18 }, { key: 'unit', header: 'Dental unit', type: 'text', width: 18 }, { key: 'status', header: 'Status', type: 'text', width: 12 },
      { key: 'duration', header: 'Minutes', type: 'int', width: 9 }, { key: 'procedures', header: 'Procedures', type: 'text', width: 30 },
    ],
    rows: rows.map((r) => ({
      date: r.date, time: r.time, patient: name(r.p_fname, r.p_lname), doctor: `Dr ${name(r.d_fname, r.d_lname)}`, clinic: r.c_name ?? 'Deleted clinic', unit: r.u_name ?? '',
      status: String(r.status).replace('_', ' '), duration: r.duration_minutes, procedures: procedures.get(r.id) ?? '',
    })),
  };
}

export async function proceduresReport(ctx: AppContext, user: AuthUser, p: Period): Promise<ReportTable> {
  const qb = ctx.db('appointment_category as ac').join('appointments as a', 'a.id', 'ac.appointment_id').join('patients as p', 'p.id', 'a.patient_id').join('categories as c', 'c.id', 'ac.category_id')
    .whereNull('a.deleted_at').whereNull('p.deleted_at').where('a.date', '>=', p.from).where('a.date', '<=', p.to);
  await ownPatients(ctx, user, qb);
  const rows: Row[] = await qb.select('c.id', 'c.name', 'a.status').count({ n: '*' }).groupBy('c.id', 'c.name', 'a.status');
  const byProc = new Map<number, { name: string; booked: number; completed: number; lost: number }>();
  for (const r of rows) {
    const cur = byProc.get(r.id) ?? { name: r.name, booked: 0, completed: 0, lost: 0 };
    const n = Number(r.n);
    if (r.status === 'completed') cur.completed += n;
    if (r.status === 'cancelled' || r.status === 'no_show') cur.lost += n;
    else cur.booked += n;
    byProc.set(r.id, cur);
  }
  return {
    title: 'Procedures', subtitle: `${label(p)} · cancelled and no-show visits are counted apart`,
    columns: [{ key: 'name', header: 'Procedure', type: 'text', width: 30 }, { key: 'booked', header: 'Booked or done', type: 'int', width: 16 }, { key: 'completed', header: 'Completed', type: 'int', width: 12 }, { key: 'lost', header: 'Cancelled or no-show', type: 'int', width: 20 }],
    rows: [...byProc.values()].sort((a, b) => b.booked - a.booked || a.name.localeCompare(b.name)),
    totals: { label: 'Total', sum: ['booked', 'completed', 'lost'] },
  };
}

/** New patients in a period, with when they were last seen (no phone numbers or notes). */
export async function patientsReport(ctx: AppContext, user: AuthUser, p: Period, max = REPORT_LIMITS.sync): Promise<ReportTable> {
  const qb = ctx.db('patients as p').leftJoin('doctors as d', 'd.id', 'p.doctor_id').whereNull('p.deleted_at')
    .whereRaw('substr(p.created_at, 1, 10) >= ?', [p.from]).whereRaw('substr(p.created_at, 1, 10) <= ?', [p.to]);
  await ownPatients(ctx, user, qb);
  const rows: Row[] = await qb.orderBy('p.created_at').select('p.patient_identifier', 'p.fname', 'p.lname', 'p.gender', 'p.date_of_birth', 'p.created_at', 'p.last_visit', 'd.fname as d_fname', 'd.lname as d_lname').limit(max + 1);
  return {
    title: 'New patients', subtitle: label(p),
    columns: [
      { key: 'id', header: 'Patient no.', type: 'text', width: 14 }, { key: 'patient', header: 'Name', type: 'text', width: 26 }, { key: 'gender', header: 'Gender', type: 'text', width: 10 }, { key: 'dob', header: 'Date of birth', type: 'text', width: 14 },
      { key: 'doctor', header: 'Primary doctor', type: 'text', width: 22 }, { key: 'added', header: 'Added', type: 'text', width: 12 }, { key: 'last', header: 'Last visit', type: 'text', width: 12 },
    ],
    rows: rows.map((r) => ({
      id: r.patient_identifier, patient: name(r.fname, r.lname), gender: r.gender ?? '', dob: r.date_of_birth ?? '', doctor: r.d_fname ? `Dr ${name(r.d_fname, r.d_lname)}` : '',
      added: String(r.created_at ?? '').slice(0, 10), last: String(r.last_visit ?? '').slice(0, 10),
    })),
  };
}

/** Lab orders, with the cost for admins and staff only. A doctor gets his own patients' orders without it. */
export async function labOrdersReport(ctx: AppContext, user: AuthUser, p: Period, status?: string, max = REPORT_LIMITS.sync): Promise<ReportTable> {
  const today = clinicNow(ctx.env, ctx.clock()).date;
  const withCost = user.role !== 'doctor';
  const qb = ctx.db('lab_orders as o').join('labs as l', 'l.id', 'o.lab_id').join('patients as p', 'p.id', 'o.patient_id').leftJoin('teeth as t', 't.id', 'o.tooth_id')
    .whereNull('o.deleted_at').whereNull('p.deleted_at').where((w) => w.whereBetween('o.due_at', [p.from, p.to]).orWhere((x) => x.whereNull('o.due_at').whereRaw('substr(o.created_at, 1, 10) >= ?', [p.from]).whereRaw('substr(o.created_at, 1, 10) <= ?', [p.to])));
  if (status) qb.whereIn('o.status', status.split(','));
  if (user.role === 'doctor') await ownPatients(ctx, user, qb);
  const rows: Row[] = await qb.orderBy('o.due_at').select('o.*', 'l.name as l_name', 'p.fname', 'p.lname', 't.index as t_index').limit(max + 1);
  const columns: ReportTable['columns'] = [
    { key: 'lab', header: 'Lab', type: 'text', width: 18 }, { key: 'patient', header: 'Patient', type: 'text', width: 24 }, { key: 'item', header: 'Item', type: 'text', width: 26 }, { key: 'tooth', header: 'Tooth', type: 'text', width: 8 },
    { key: 'status', header: 'Status', type: 'text', width: 11 }, { key: 'sent', header: 'Sent', type: 'text', width: 12 }, { key: 'due', header: 'Due', type: 'text', width: 12 }, { key: 'received', header: 'Received', type: 'text', width: 12 },
    { key: 'overdue', header: 'Overdue', type: 'text', width: 9 },
  ];
  if (withCost) columns.push({ key: 'cost', header: 'Cost', type: 'money', width: 12 });
  return {
    title: 'Lab orders', subtitle: `${label(p)} · by due date`, columns,
    rows: rows.map((r) => ({
      lab: r.l_name, patient: name(r.fname, r.lname), item: r.item, tooth: r.t_index ?? '', status: r.status, sent: r.sent_at ?? '', due: r.due_at ?? '', received: r.received_at ?? '',
      overdue: r.due_at && r.due_at < today && (r.status === 'draft' || r.status === 'sent') ? 'Yes' : 'No', ...(withCost ? { cost: round2(Number(r.cost ?? 0)) } : {}),
    })),
    ...(withCost ? { totals: { label: 'Total', sum: ['cost'] } } : {}),
  };
}
