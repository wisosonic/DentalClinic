import type { PaymentDto, PaymentMethod } from '@aya/shared';
import type { Db } from '../../db/connection';
import { HttpError } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import { doctorIdFor } from '../visits/access';

export { doctorIdFor };

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row
export type Conn = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** What each signed-in person may reach in the money tables. */
export interface MoneyScope {
  /** An admin sees everything. */
  all: boolean;
  /** A doctor sees only his own patients' offers and payments; null when the login isn't linked to a doctor. */
  doctorId: number | null;
}

export async function moneyScope(db: Db, user: AuthUser): Promise<MoneyScope> {
  if (user.role === 'admin') return { all: true, doctorId: null };
  return { all: false, doctorId: user.role === 'doctor' ? await doctorIdFor(db, user.id) : null };
}

/** Restricts a query that has `p` (patients) joined to what this person may see. */
export function limitToScope(qb: any, scope: MoneyScope): void { // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
  if (scope.all) return;
  if (scope.doctorId === null) qb.whereRaw('1 = 0');
  else qb.where('p.doctor_id', scope.doctorId);
}

/** The sum of an offer's payments, as a correlated sub-select (rounded to cents). */
export const PAID_SQL = '(SELECT COALESCE(ROUND(SUM(pm.amount), 2), 0) FROM payments pm WHERE pm.quote_id = q.id AND pm.deleted_at IS NULL)';

export function toPaymentDto(r: Row, user: AuthUser): PaymentDto {
  const dto: PaymentDto = {
    id: r.id, offerId: r.quote_id ?? null,
    offer: r.quote_id ? { id: r.quote_id, title: r.q_title } : null,
    patient: r.patient_id ? { id: r.patient_id, fname: r.p_fname, lname: r.p_lname } : null,
    date: r.date, amount: round2(Number(r.amount)), remaining: r.remaining == null ? null : round2(Number(r.remaining)),
    currency: r.currency, method: (r.method as PaymentMethod | null) ?? null, description: r.description ?? null,
    type: r.type === 'commission' ? 'commission' : 'clinic',
    collectedBy: r.collected_by_doctor_id ? { id: r.collected_by_doctor_id, fname: r.d_fname, lname: r.d_lname } : null,
    createdAt: r.created_at ?? null,
  };
  // The doctor's share is a financial figure between the owner and the doctor: admins only.
  if (user.role === 'admin') dto.drPart = r.dr_part == null ? null : Number(r.dr_part);
  return dto;
}

/** Payments joined with their offer, patient and collecting doctor; deleted ones and those of deleted offers or patients are left out. */
export function paymentQuery(db: Db | Conn) {
  return (db as Db)('payments as pay')
    .join('quotes as q', 'q.id', 'pay.quote_id')
    .join('patients as p', 'p.id', 'q.patient_id')
    .leftJoin('doctors as d', 'd.id', 'pay.collected_by_doctor_id')
    .whereNull('pay.deleted_at')
    .whereNull('q.deleted_at')
    .whereNull('p.deleted_at')
    .select(
      'pay.*', 'q.title as q_title', 'q.patient_id as patient_id', 'p.fname as p_fname', 'p.lname as p_lname', 'p.doctor_id as p_doctor_id',
      'd.fname as d_fname', 'd.lname as d_lname',
    );
}

/** The doctor's share (a percentage) when a payment is made: the setting at the clinic where he works, 100 if none. */
export async function doctorShare(db: Conn, doctorId: number | null, patientId: number): Promise<number> {
  if (!doctorId) return 100;
  const rows: Row[] = await db('clinic_doctor').where({ doctor_id: doctorId }).select('clinic_id', 'dr_part');
  if (!rows.length) return 100;
  if (rows.length > 1) {
    // The clinic of the patient's latest visit, when the doctor works at several.
    const last = await db('appointments').where({ patient_id: patientId }).whereNull('deleted_at').orderBy([{ column: 'date', order: 'desc' }, { column: 'time', order: 'desc' }]).first('clinic_id');
    const match = rows.find((r) => r.clinic_id === last?.clinic_id);
    if (match) return Number(match.dr_part);
  }
  return Number(rows[0]!.dr_part);
}

export const notOpen = () => new HttpError(409, 'OFFER_NOT_OPEN', 'This offer cannot take payments (it is a draft, or was rejected, expired or cancelled)');
