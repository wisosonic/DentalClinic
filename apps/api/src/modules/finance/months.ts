import type { FinanceSummaryDto } from '@aya/shared';
import type { Db } from '../../db/connection';
import { round2 } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row
type Month = FinanceSummaryDto['byMonth'][number];

export interface MonthlyOptions {
  from?: string;
  to?: string;
  /** Only payments of this doctor's own patients (a doctor's view). Expenses are left out when set. */
  doctorId?: number | null;
}

/**
 * Money in and out, month by month, with the empty months in between so a chart has no gaps. Payments
 * are those from patients (of quotes and patients that still exist) plus commission received. Used by
 * the Summary page and the dashboard.
 */
export async function monthlyTotals(db: Db, { from, to, doctorId = null }: MonthlyOptions): Promise<Month[]> {
  const between = (qb: any, column: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
    if (from) qb.where(column, '>=', from);
    if (to) qb.where(column, '<=', to);
  };
  const monthly = new Map<string, { payments: number; expenses: number }>();
  const bucket = (m: string) => monthly.get(m) ?? { payments: 0, expenses: 0 };
  const inMonths = async (table: string, column: string, field: 'payments' | 'expenses', extra: (qb: any) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
    const rows: Row[] = await db(table).modify(extra).modify((qb) => between(qb, column)).select(db.raw(`substr(${column}, 1, 7) as month`)).sum({ total: `${column.split('.')[0]}.amount` }).groupByRaw(`substr(${column}, 1, 7)`);
    for (const r of rows) monthly.set(r.month, { ...bucket(r.month), [field]: round2(bucket(r.month)[field] + Number(r.total)) });
  };
  await inMonths('payments as pay', 'pay.date', 'payments', (qb) => {
    qb.leftJoin('treatment_offers as q', 'q.id', 'pay.offer_id').leftJoin('patients as p', 'p.id', 'q.patient_id').whereNull('pay.deleted_at');
    if (doctorId !== null) qb.where('pay.type', 'clinic').where('q.deleted_at', null).where('p.deleted_at', null).where('p.doctor_id', doctorId);
    else qb.whereRaw("(pay.type = 'commission' OR (pay.type = 'clinic' AND q.deleted_at IS NULL AND p.deleted_at IS NULL))");
  });
  if (doctorId === null) await inMonths('expenses as e', 'e.date', 'expenses', (qb) => qb.whereNull('e.deleted_at'));

  const sorted = [...monthly.keys()].sort();
  const firstMonth = from?.slice(0, 7) ?? sorted[0];
  const lastMonth = to?.slice(0, 7) ?? sorted.at(-1);
  const out: Month[] = [];
  if (firstMonth && lastMonth) {
    for (let [y, m] = firstMonth.split('-').map(Number) as [number, number]; `${y}-${String(m).padStart(2, '0')}` <= lastMonth && out.length < 120; m === 12 ? (y++, (m = 1)) : m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      out.push({ month: key, ...bucket(key) });
    }
  }
  return out;
}
