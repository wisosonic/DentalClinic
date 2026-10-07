import { Router } from 'express';
import { z } from 'zod';
import type { PortalAppointmentDto, PortalDocumentDto, PortalOfferDto, PortalOverviewDto, PortalPaymentDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { clinicNow, fromMinutes, hoursUntil, toMinutes } from '../../lib/time';
import { requireAuth, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { sendDocumentFile, sendDocumentThumbnail } from '../documents/router';
import { clinicLetterhead } from '../finance/letterhead';
import { renderOfferPdf, renderReceiptPdf } from '../finance/pdf';
import { offerQuery, toOfferDtos } from '../offers/service';
import { appointmentQuery } from '../appointments/service';
import { HttpError } from '../../lib/errors';
import { assertPortalOn, operating } from '../settings/operating';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The patient portal (phase 8). Every route is for a patient login and reads only the record linked to it
 * (`patients.user_id`); nobody else's id can be asked for. View only: the one thing a patient may change is to
 * cancel an appointment with notice, which is the appointments route itself. What is shown is a deliberate
 * subset: never internal notes, the clinic's costs, a doctor's share or another person's details.
 */
export function portalRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('patient'));
  // The clinic may switch the portal off (Settings > Patient portal); nothing in it then answers.
  router.use((_req, _res, next) => { assertPortalOn(ctx).then(() => next(), next); });
  /** Payments, receipts and balances are shown only when the clinic wants patients to see them. */
  const showsPayments = async () => (await operating(ctx)).portal.showPayments;
  const assertShowsPayments = async () => {
    if (!(await showsPayments())) throw new HttpError(403, 'PAYMENTS_HIDDEN', 'The clinic does not show payments in the patient portal.');
  };

  async function ownRecord(user: AuthUser): Promise<Row> {
    const row = await db('patients').where({ user_id: user.id }).whereNull('deleted_at').first();
    if (!row) throw notFound('No patient record is linked to this account');
    return row;
  }

  /** The patient's upcoming appointments that are still on (pending or confirmed), soonest first. */
  async function upcoming(patientId: number): Promise<PortalAppointmentDto[]> {
    const now = clinicNow(env, ctx.clock());
    const cancelMinHours = (await operating(ctx)).appointments.cancelMinHours;
    const rows: Row[] = await appointmentQuery(db).where('a.patient_id', patientId).whereIn('a.status', ['pending', 'confirmed']).where('a.date', '>=', now.date)
      .orderBy([{ column: 'a.date' }, { column: 'a.time' }, { column: 'a.id' }]);
    const started = rows.filter((r) => hoursUntil(now, r.date, r.time) >= 0);
    if (!started.length) return [];
    const ids = started.map((r) => r.id);
    const procedures: Row[] = await db('appointment_category as ac').join('categories as c', 'c.id', 'ac.category_id').whereIn('ac.appointment_id', ids).select('ac.appointment_id', 'c.name').orderBy('c.name');
    const clinicIds = [...new Set(started.map((r) => r.clinic_id).filter(Boolean))];
    const clinics: Row[] = clinicIds.length ? await db('clinics').whereIn('id', clinicIds).select('id', 'name', 'address', 'phone') : [];
    return started.map((r) => {
      const hours = hoursUntil(now, r.date, r.time);
      const clinic = clinics.find((c) => c.id === r.clinic_id);
      const until = new Date(Date.parse(`${r.date}T${r.time}:00Z`) - cancelMinHours * 3_600_000).toISOString();
      return {
        id: r.id, date: r.date, time: r.time, endTime: fromMinutes(toMinutes(r.time) + r.duration_minutes), durationMinutes: r.duration_minutes,
        status: r.status as 'pending' | 'confirmed', doctor: { fname: r.d_fname, lname: r.d_lname },
        clinic: clinic ? { name: clinic.name, address: clinic.address ?? null, phone: clinic.phone ?? null } : null,
        procedures: procedures.filter((p) => p.appointment_id === r.id).map((p) => p.name as string),
        canCancel: hours >= cancelMinHours, cancelUntil: `${until.slice(0, 10)} ${until.slice(11, 16)}`,
      };
    });
  }

  /** The treatment offers the patient has agreed to (accepted), with their items. A draft is not binding and not shown. */
  async function acceptedOffers(user: AuthUser, patientId: number, id?: number) {
    const rows: Row[] = await offerQuery(db).where('q.patient_id', patientId).where('q.status', 'accepted').modify((qb) => { if (id) qb.where('q.id', id); }).orderBy([{ column: 'q.created_at', order: 'desc' }, { column: 'q.id', order: 'desc' }]);
    return toOfferDtos(db, rows, user, true);
  }

  const visibleDocuments = (patientId: number) => db('patient_documents').where({ patient_id: patientId, patient_visible: true }).whereNull('deleted_at');

  router.get('/overview', async (req, res) => {
    const user = requireUser(req);
    const patient = await ownRecord(user);
    const coming = await upcoming(patient.id);
    const offers = await acceptedOffers(user, patient.id);
    const doctor: Row | undefined = patient.doctor_id ? await db('doctors').where({ id: patient.doctor_id }).first('fname', 'lname') : undefined;
    const documents = Number((await visibleDocuments(patient.id).count({ n: '*' }).first())?.n ?? 0);
    const settings = await operating(ctx);
    const body: PortalOverviewDto = {
      patient: { id: patient.id, fname: patient.fname, lname: patient.lname, patientIdentifier: patient.patient_identifier, username: patient.username ?? null, doctor: doctor ? { fname: doctor.fname, lname: doctor.lname } : null },
      next: coming[0] ?? null,
      upcomingCount: coming.length,
      balance: settings.portal.showPayments ? {
        price: round2(offers.reduce((s, o) => s + o.price, 0)), paid: round2(offers.reduce((s, o) => s + o.paid, 0)),
        remaining: round2(offers.reduce((s, o) => s + o.remaining, 0)), currency: '$',
      } : null,
      showPayments: settings.portal.showPayments,
      documentsCount: documents,
      cancelMinHours: settings.appointments.cancelMinHours,
    };
    res.json(body);
  });

  router.get('/upcoming', async (req, res) => {
    const patient = await ownRecord(requireUser(req));
    res.json({ data: await upcoming(patient.id) });
  });

  // ----- treatment offers -----------------------------------------------------------------------------------------
  const toPortalOffer = (o: Awaited<ReturnType<typeof acceptedOffers>>[number], money: boolean): PortalOfferDto => ({
    id: o.id, title: o.title, description: o.description, price: o.price, ...(money && { paid: o.paid, remaining: o.remaining, paymentState: o.paymentState }), currency: o.currency,
    workState: o.workState, progress: o.progress,
    doctor: o.doctor ? { fname: o.doctor.fname, lname: o.doctor.lname } : null,
    items: (o.items ?? []).map((i) => ({
      id: i.id, sequence: i.sequence, description: i.description, tooth: i.tooth?.index ?? null, price: i.price, status: i.status,
      visit: i.appointment ? { date: i.appointment.date, time: i.appointment.time } : null,
    })),
    createdAt: o.createdAt,
  });

  router.get('/offers', async (req, res) => {
    const user = requireUser(req);
    const patient = await ownRecord(user);
    const money = await showsPayments();
    res.json({ data: (await acceptedOffers(user, patient.id)).map((o) => toPortalOffer(o, money)) });
  });

  router.get('/offers/:id/pdf', async (req, res) => {
    const user = requireUser(req);
    const patient = await ownRecord(user);
    const offer = (await acceptedOffers(user, patient.id, idParam.parse(req.params.id)))[0];
    if (!offer) throw notFound('Treatment offer not found');
    const pdf = await renderOfferPdf(
      {
        clinic: await clinicLetterhead(db, patient.id), number: offer.id, date: (offer.createdAt ?? '').slice(0, 10), status: offer.status,
        patient: { name: `${patient.fname} ${patient.lname}`.trim(), number: patient.patient_identifier },
        doctor: offer.doctor ? `${offer.doctor.fname} ${offer.doctor.lname}`.trim() : null,
        title: offer.title, description: offer.description, notes: null, // internal notes are the clinic's
        items: (offer.items ?? []).map((i) => ({ description: i.description, tooth: i.tooth?.index ?? null, price: i.price })),
        price: offer.price, paid: (await showsPayments()) ? offer.paid : 0, // 0 prints only the total
      },
      { compress: env.NODE_ENV !== 'test' },
    );
    await audit(ctx, req, { userId: user.id, action: 'offer.pdf', entity: 'offer', entityId: offer.id });
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="treatment-offer-${offer.id}.pdf"`, 'Cache-Control': 'private, no-store' }).send(pdf);
  });

  // ----- payments ---------------------------------------------------------------------------------------------------
  const ownPayments = (patientId: number) =>
    db('payments as pay').join('treatment_offers as q', 'q.id', 'pay.offer_id')
      .where('q.patient_id', patientId).where('pay.type', 'clinic').whereNull('pay.deleted_at').whereNull('q.deleted_at');

  router.get('/payments', async (req, res) => {
    await assertShowsPayments();
    const patient = await ownRecord(requireUser(req));
    const rows: Row[] = await ownPayments(patient.id).select('pay.*', 'q.title as q_title').orderBy([{ column: 'pay.date', order: 'desc' }, { column: 'pay.id', order: 'desc' }]);
    const data: PortalPaymentDto[] = rows.map((r) => ({
      id: r.id, date: r.date, amount: round2(Number(r.amount)), currency: r.currency, method: r.method ?? null, offerId: r.offer_id, offerTitle: r.q_title,
      remaining: r.remaining == null ? null : Math.max(0, round2(Number(r.remaining))),
    }));
    res.json({ data });
  });

  router.get('/payments/:id/receipt', async (req, res) => {
    await assertShowsPayments();
    const user = requireUser(req);
    const patient = await ownRecord(user);
    const row: Row | undefined = await ownPayments(patient.id).where('pay.id', idParam.parse(req.params.id)).select('pay.*', 'q.title as q_title').first();
    if (!row) throw notFound('Payment not found');
    const pdf = await renderReceiptPdf(
      {
        clinic: await clinicLetterhead(db, patient.id), number: row.id, date: row.date,
        patient: { name: `${patient.fname} ${patient.lname}`.trim(), number: patient.patient_identifier },
        offerTitle: row.q_title, amount: round2(Number(row.amount)), method: row.method ?? null,
        remaining: row.remaining == null ? null : Math.max(0, round2(Number(row.remaining))),
        receivedBy: null, note: null, // who took it and the clinic's note stay inside
      },
      { compress: env.NODE_ENV !== 'test' },
    );
    await audit(ctx, req, { userId: user.id, action: 'payment.receipt', entity: 'payment', entityId: row.id });
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="receipt-${row.id}.pdf"`, 'Cache-Control': 'private, no-store' }).send(pdf);
  });

  // ----- documents the clinic has marked as visible to the patient ----------------------------------------------------
  router.get('/documents', async (req, res) => {
    const patient = await ownRecord(requireUser(req));
    const rows: Row[] = await visibleDocuments(patient.id).orderBy([{ column: 'taken_on', order: 'desc' }, { column: 'id', order: 'desc' }]);
    const data: PortalDocumentDto[] = rows.map((r) => ({
      id: r.id, category: r.category, title: r.title, takenOn: r.taken_on ?? null, mime: r.mime, sizeBytes: r.size_bytes, isImage: String(r.mime).startsWith('image/'),
    }));
    res.json({ data });
  });

  async function ownDocument(user: AuthUser, id: number): Promise<Row> {
    const patient = await ownRecord(user);
    const row: Row | undefined = await visibleDocuments(patient.id).where({ id }).first();
    if (!row) throw notFound('Document not found'); // someone else's, one not shared, and one that does not exist look alike
    return row;
  }

  router.get('/documents/:id/file', async (req, res) => {
    const row = await ownDocument(requireUser(req), idParam.parse(req.params.id)); // a patient looking at their own record is not logged
    sendDocumentFile(res, env, row);
  });

  router.get('/documents/:id/thumbnail', async (req, res) => {
    const row = await ownDocument(requireUser(req), idParam.parse(req.params.id));
    await sendDocumentThumbnail(res, env, row);
  });

  return router;
}
