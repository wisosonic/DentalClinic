import type { AppContext } from '../../context';
import { adminUserIds, doctorUserIds, emitEvent, primaryDoctorUserIds, staffUserIds } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const money = (n: unknown) => `$${Number(n).toFixed(2)}`;

async function appointmentFacts(ctx: AppContext, id: number): Promise<Row | undefined> {
  return ctx.db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').join('doctors as d', 'd.id', 'a.doctor_id').where('a.id', id)
    .first('a.id', 'a.date', 'a.time', 'a.doctor_id', 'p.fname', 'p.lname', 'd.fname as d_fname', 'd.lname as d_lname');
}

/** A booked appointment: the staff and the doctor it is booked with (not the person who booked it). */
export async function appointmentBooked(ctx: AppContext, id: number, actorId: number | null): Promise<void> {
  const a = await appointmentFacts(ctx, id);
  if (!a) return;
  await emitEvent(ctx, {
    type: 'appointment.booked', actorId, title: 'New appointment', content: `${a.fname} ${a.lname} with Dr ${a.d_fname} ${a.d_lname} on ${a.date} at ${a.time}.`,
    link: '/appointments', appointmentId: id, dedupeKey: `event:booked:${id}:${a.date}T${a.time}`,
    recipients: async () => [...(await staffUserIds(ctx.db)), ...(await doctorUserIds(ctx.db, a.doctor_id))],
  });
}

/** A cancelled appointment: the same people. */
export async function appointmentCancelled(ctx: AppContext, id: number, actorId: number | null): Promise<void> {
  const a = await appointmentFacts(ctx, id);
  if (!a) return;
  await emitEvent(ctx, {
    type: 'appointment.cancelled', actorId, title: 'Appointment cancelled', content: `${a.fname} ${a.lname} with Dr ${a.d_fname} ${a.d_lname} on ${a.date} at ${a.time} was cancelled.`,
    link: '/appointments', appointmentId: id, dedupeKey: `event:cancelled:${id}`,
    recipients: async () => [...(await staffUserIds(ctx.db)), ...(await doctorUserIds(ctx.db, a.doctor_id))],
  });
}

/** A missed appointment: the same people as for a booking. */
export async function appointmentNoShow(ctx: AppContext, id: number, actorId: number | null): Promise<void> {
  const a = await appointmentFacts(ctx, id);
  if (!a) return;
  await emitEvent(ctx, {
    type: 'appointment.no_show', actorId, title: 'Patient did not come', content: `${a.fname} ${a.lname} missed the appointment with Dr ${a.d_fname} ${a.d_lname} on ${a.date} at ${a.time}.`,
    link: '/appointments', appointmentId: id, dedupeKey: `event:no-show:${id}`,
    recipients: async () => [...(await staffUserIds(ctx.db)), ...(await doctorUserIds(ctx.db, a.doctor_id))],
  });
}

/** An offer sent to or accepted by the patient: admins, the staff (who book its visits) and the patient's primary doctor. */
export async function offerChanged(ctx: AppContext, offerId: number, status: 'sent' | 'accepted', actorId: number | null): Promise<void> {
  const q: Row | undefined = await ctx.db('quotes as q').join('patients as p', 'p.id', 'q.patient_id').where('q.id', offerId).first('q.title', 'q.price', 'q.patient_id', 'p.fname', 'p.lname');
  if (!q) return;
  await emitEvent(ctx, {
    type: status === 'sent' ? 'offer.sent' : 'offer.accepted', actorId, title: status === 'sent' ? 'Offer sent' : 'Offer accepted',
    content: status === 'sent' ? `${q.title} (${money(q.price)}) for ${q.fname} ${q.lname}.` : `${q.fname} ${q.lname} accepted “${q.title}” (${money(q.price)}). Its visits can be booked.`,
    link: `/treatment-offers/${offerId}`, dedupeKey: `event:offer:${offerId}:${status}`,
    recipients: async () => [...(await adminUserIds(ctx.db)), ...(status === 'accepted' ? await staffUserIds(ctx.db) : []), ...(await primaryDoctorUserIds(ctx.db, q.patient_id))],
  });
}

/** A payment recorded: admins and the patient's primary doctor. */
export async function paymentRecorded(ctx: AppContext, paymentId: number, actorId: number | null): Promise<void> {
  const p: Row | undefined = await ctx.db('payments as pay').join('quotes as q', 'q.id', 'pay.quote_id').join('patients as pt', 'pt.id', 'q.patient_id').where('pay.id', paymentId)
    .first('pay.amount', 'q.patient_id', 'q.title', 'pt.fname', 'pt.lname');
  if (!p) return;
  await emitEvent(ctx, {
    type: 'payment.received', actorId, title: 'Payment received', content: `${money(p.amount)} from ${p.fname} ${p.lname} for ${p.title}.`,
    link: `/payments?patientId=${p.patient_id}`, dedupeKey: `event:payment:${paymentId}`,
    recipients: async () => [...(await adminUserIds(ctx.db)), ...(await primaryDoctorUserIds(ctx.db, p.patient_id))],
  });
}
