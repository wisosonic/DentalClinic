import type { OfferDto, OfferItemDto, OfferPaymentState, OfferStatus, OfferWorkState } from '@aya/shared';
import type { Db } from '../../db/connection';
import { sqlNow } from '../../db/connection';
import type { AuthUser } from '../../middleware/auth';
import { PAID_SQL, doctorIdFor, round2, type Conn, type MoneyScope } from '../finance/service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/** Offers that can take payments: accepted ones (a draft is not binding yet, a cancelled one is closed). */
export const PAYABLE: OfferStatus[] = ['accepted'];
/** Offers that still count as debt when something is left to pay. */
export const OWING: OfferStatus[] = ['accepted'];
/** Closed for good: nothing about them can be changed. */
export const CLOSED: OfferStatus[] = ['cancelled'];

/**
 * Who may SEE offers: an admin and the staff all of them (staff never see the cost), a doctor only those of the
 * patients whose primary doctor he is. Writing is narrower (`mayWrite`).
 */
export async function offerScope(db: Db, user: AuthUser): Promise<MoneyScope> {
  if (user.role === 'admin' || user.role === 'staff') return { all: true, doctorId: null };
  return { all: false, doctorId: user.role === 'doctor' ? await doctorIdFor(db, user.id) : null };
}

/** Who may write an offer: an admin, or the primary doctor of the patient. Staff read and book only. */
export const mayWrite = (user: AuthUser, patientDoctorId: number | null, scope: MoneyScope) =>
  user.role === 'admin' || (user.role === 'doctor' && scope.doctorId !== null && patientDoctorId === scope.doctorId);

/** Offers joined with their patient and the patient's primary doctor, with `paid` worked out; deleted offers and patients are left out. */
export function offerQuery(db: Db | Conn) {
  return (db as Db)('treatment_offers as q')
    .join('patients as p', 'p.id', 'q.patient_id')
    .leftJoin('doctors as d', 'd.id', 'p.doctor_id')
    .whereNull('q.deleted_at')
    .whereNull('p.deleted_at')
    .select('q.*', 'p.fname as p_fname', 'p.lname as p_lname', 'p.doctor_id as p_doctor_id', 'd.fname as d_fname', 'd.lname as d_lname', (db as Db).raw(`${PAID_SQL} as paid`));
}

export function itemQuery(db: Db | Conn) {
  return (db as Db)('offer_items as i')
    .leftJoin('teeth as t', 't.id', 'i.tooth_id')
    .leftJoin('categories as c', 'c.id', 'i.category_id')
    .leftJoin('appointments as a', function join() {
      this.on('a.id', 'i.appointment_id').andOnNull('a.deleted_at');
    })
    .select('i.*', 't.index as t_index', 'c.name as c_name', 'a.date as a_date', 'a.time as a_time', 'a.status as a_status')
    .orderBy('i.sequence')
    .orderBy('i.id');
}

/** The clinic's own cost is for admins and doctors, never staff or patients. */
const seesCost = (user: AuthUser) => user.role === 'admin' || user.role === 'doctor';

export const toItemDto = (r: Row, user: AuthUser): OfferItemDto => ({
  id: r.id, sequence: r.sequence, description: r.description,
  tooth: r.tooth_id ? { id: r.tooth_id, index: String(r.t_index) } : null,
  category: r.category_id ? { id: r.category_id, name: r.c_name } : null,
  price: round2(Number(r.price)), ...(seesCost(user) && { cost: r.cost == null ? null : round2(Number(r.cost)) }),
  status: r.status,
  appointment: r.appointment_id && r.a_date ? { id: r.appointment_id, date: r.a_date, time: r.a_time, status: r.a_status } : null,
  completedAt: r.completed_at ?? null,
});

/** Nothing paid, something paid, or everything (or more) paid. */
export function paymentStateOf(price: number, paid: number): OfferPaymentState {
  if (paid <= 0.004) return 'unpaid';
  return round2(price - paid) <= 0 ? 'paid' : 'partly_paid';
}

/** None started, some booked or done, all done. An offer with no items has no work. */
export function workStateOf(items: Row[]): OfferWorkState {
  if (!items.length) return 'not_started';
  if (items.every((i) => i.status === 'done')) return 'completed';
  return items.some((i) => i.status === 'scheduled' || i.status === 'done') ? 'in_progress' : 'not_started';
}

export async function toOfferDtos(db: Db | Conn, rows: Row[], user: AuthUser, withItems: boolean): Promise<OfferDto[]> {
  const ids = rows.map((r) => r.id as number);
  const items: Row[] = ids.length ? await itemQuery(db).whereIn('i.offer_id', ids) : [];
  return rows.map((r) => {
    const mine = items.filter((i) => i.offer_id === r.id);
    const done = mine.filter((i) => i.status === 'done').length;
    const price = round2(Number(r.price));
    const paid = round2(Number(r.paid ?? 0));
    return {
      id: r.id, patientId: r.patient_id, patient: { id: r.patient_id, fname: r.p_fname, lname: r.p_lname },
      doctor: r.p_doctor_id ? { id: r.p_doctor_id, fname: r.d_fname, lname: r.d_lname } : null,
      title: r.title, description: r.description ?? null, notes: r.notes ?? null, status: r.status as OfferStatus,
      price, ...(seesCost(user) && { cost: round2(Number(r.cost ?? 0)) }), currency: r.currency, paid, remaining: Math.max(0, round2(price - paid)),
      paymentState: paymentStateOf(price, paid), workState: workStateOf(mine),
      progress: { done, total: mine.length, percent: mine.length ? Math.round((done / mine.length) * 100) : 0 },
      ...(withItems && { items: mine.map((i) => toItemDto(i, user)) }),
      createdAt: r.created_at ?? null,
    };
  });
}

/**
 * Brings an offer's numbers in line with its items and payments, inside the caller's transaction: the price
 * and cost are the sums of the items, every payment shows the balance after it (oldest first, never below zero),
 * The server alone works these out.
 */
export async function recalcOffer(trx: Conn, offerId: number, opts: { fromItems?: boolean } = {}): Promise<{ price: number; paid: number; remaining: number }> {
  const offer = await trx('treatment_offers').where({ id: offerId }).first('id', 'price', 'cost', 'status');
  const sums: Row | undefined = await trx('offer_items').where({ offer_id: offerId }).sum({ price: 'price' }).sum({ cost: 'cost' }).first();
  // An offer with no items keeps the price it has (only changing the items themselves may bring it to zero).
  const noItems = Number((await trx('offer_items').where({ offer_id: offerId }).count({ n: '*' }).first())?.n ?? 0) === 0;
  const keep = noItems && !opts.fromItems;
  const price = keep ? round2(Number(offer!.price)) : round2(Number(sums?.price ?? 0));
  const cost = keep ? round2(Number(offer!.cost ?? 0)) : round2(Number(sums?.cost ?? 0));
  const payments: Row[] = await trx('payments').where({ offer_id: offerId }).whereNull('deleted_at').orderBy([{ column: 'date' }, { column: 'id' }]).select('id', 'amount', 'remaining');
  let paid = 0;
  for (const p of payments) {
    paid = round2(paid + Number(p.amount));
    const remaining = Math.max(0, round2(price - paid)); // never negative: paying more than the price counts as paid
    if (p.remaining == null || round2(Number(p.remaining)) !== remaining) await trx('payments').where({ id: p.id }).update({ remaining });
  }
  const update: Record<string, unknown> = {};
  if (round2(Number(offer!.price)) !== price) update.price = price;
  if (round2(Number(offer!.cost ?? 0)) !== cost) update.cost = cost;
  if (Object.keys(update).length) await trx('treatment_offers').where({ id: offerId }).update({ ...update, updated_at: sqlNow() });
  return { price, paid, remaining: Math.max(0, round2(price - paid)) };
}

/**
 * Brings an offer's items in line with the visits behind them. An item follows its visit: booked -> scheduled,
 * completed -> done, cancelled, no-show or deleted -> back to pending and free to book again. An item marked done
 * by hand (no visit) stays done. (How far the work has got is worked out from the items when asked for.)
 */
export async function syncOffer(db: Conn, offerId: number): Promise<void> {
  const now = sqlNow();
  const items: Row[] = await itemQuery(db).where('i.offer_id', offerId);
  for (const item of items) {
    let status: string = item.status;
    let appointmentId: number | null = item.appointment_id;
    let completedAt: string | null = item.completed_at;
    if (item.appointment_id && item.status !== 'done') { // done by hand stays done, whatever happens to the visit
      if (!item.a_status || item.a_status === 'cancelled' || item.a_status === 'no_show') {
        status = 'pending'; appointmentId = null; completedAt = null;
      } else if (item.a_status === 'completed') {
        status = 'done'; completedAt = completedAt ?? now;
      } else {
        status = 'scheduled'; completedAt = null;
      }
    }
    if (status !== item.status || appointmentId !== item.appointment_id || completedAt !== item.completed_at) {
      await (db as Db)('offer_items').where({ id: item.id }).update({ status, appointment_id: appointmentId, completed_at: completedAt, updated_at: now });
    }
  }
}

/** Called when a visit is completed, cancelled, marked no-show or deleted. */
export async function syncOffersForAppointment(db: Db, appointmentId: number): Promise<void> {
  const rows: Row[] = await db('offer_items').where({ appointment_id: appointmentId }).distinct('offer_id');
  for (const r of rows) await syncOffer(db, r.offer_id);
}
