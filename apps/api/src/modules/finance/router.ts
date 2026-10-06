import { Router } from 'express';
import { z } from 'zod';
import { paymentInputSchema, paymentUpdateSchema, type OpenOfferDto, type Paginated, type PaymentDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { badRequest, notFound } from '../../lib/errors';
import { whereWords } from '../../lib/search';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { PAYABLE, offerQuery, recalcOffer } from '../offers/service';
import { paymentRecorded } from '../notifications/events';
import { clinicLetterhead } from './letterhead';
import { renderReceiptPdf } from './pdf';
import { doctorShare, limitToScope, moneyScope, notOpen, paymentQuery, round2, toPaymentDto, type MoneyScope } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const paymentList = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  offerId: z.coerce.number().int().positive().optional(),
  patientId: z.coerce.number().int().positive().optional(),
  method: z.enum(['cash', 'card', 'bank_transfer', 'other']).optional(),
  from: date.optional(),
  to: date.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['date', 'patient', 'amount', 'method', 'offer']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/** Who may do what with an offer's patient: admin anyone's, a doctor only his own patients'. */
const mayWriteFor = (scope: MoneyScope, patientDoctorId: number | null) =>
  scope.all || (scope.doctorId !== null && patientDoctorId === scope.doctorId);

// ---------------------------------------------------------------------------
// Payments: admins, doctors (own patients) and staff (record, and fix their own entries)
// ---------------------------------------------------------------------------

const PAYMENT_ORDER: Record<string, string[]> = {
  date: ['pay.date'], patient: ['p.lname', 'p.fname'], amount: ['pay.amount'], method: ['pay.method'], offer: ['q.title'],
};

export function paymentsRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin', 'doctor', 'staff'));

  const today = () => clinicNow(env, ctx.clock()).date;

  /** Finds a payable offer this person may record a payment on. Staff may use any patient's; a doctor only his own patients'. */
  async function payableOffer(user: AuthUser, offerId: number, scope: MoneyScope): Promise<Row> {
    const row = await offerQuery(db).where('q.id', offerId).first();
    if (!row) throw notFound('Treatment offer not found');
    if (user.role === 'doctor' && !mayWriteFor(scope, row.p_doctor_id)) throw notFound('Treatment offer not found');
    if (!PAYABLE.includes(row.status)) throw notOpen();
    return row;
  }

  /** Staff only touch what they entered themselves; doctors only their own patients' payments. */
  async function loadPayment(user: AuthUser, id: number, scope: MoneyScope): Promise<Row> {
    const row = await paymentQuery(db).where('pay.id', id).first();
    if (!row) throw notFound('Payment not found');
    if (user.role === 'staff' && row.created_by !== user.id) throw notFound('Payment not found');
    if (user.role === 'doctor' && !mayWriteFor(scope, row.p_doctor_id)) throw notFound('Payment not found');
    return row;
  }

  router.get('/', requirePermission('payments:read'), requireRole('admin', 'doctor'), async (req, res) => {
    const user = requireUser(req);
    const q = paymentList.parse(req.query);
    const scope = await moneyScope(db, user);
    const base = paymentQuery(db).modify((qb) => {
      limitToScope(qb, scope);
      qb.where('pay.type', 'clinic');
      if (q.offerId) qb.where('pay.quote_id', q.offerId);
      if (q.patientId) qb.where('q.patient_id', q.patientId);
      if (q.method) qb.where('pay.method', q.method);
      if (q.from) qb.where('pay.date', '>=', q.from);
      if (q.to) qb.where('pay.date', '<=', q.to);
      whereWords(qb, ['p.fname', 'p.lname', 'q.title'], q.q);
    });
    const total = Number((await base.clone().clearSelect().count({ n: '*' }).first())?.n ?? 0);
    const rows = await base.clone()
      .orderBy([...PAYMENT_ORDER[q.sort]!, 'pay.id'].map((column) => ({ column, order: q.order })))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const body: Paginated<PaymentDto> = { data: rows.map((r: Row) => toPaymentDto(r, user)), meta: { page: q.page, pageSize: q.pageSize, total } };
    res.json(body);
  });

  // The payments this person entered recently: all a staff member can look back at.
  router.get('/mine', async (req, res) => {
    const user = requireUser(req);
    const days = z.coerce.number().int().min(1).max(60).default(14).parse(req.query.days);
    const since = new Date(ctx.clock().getTime() - days * 86_400_000);
    const rows = await paymentQuery(db).where('pay.created_by', user.id).where('pay.created_at', '>=', sqlNow(since)).orderBy([{ column: 'pay.id', order: 'desc' }]).limit(100);
    res.json({ data: rows.map((r: Row) => toPaymentDto(r, user)) });
  });

  // Staff pick an offer to pay from this narrow list: title, price and what is left, nothing more.
  router.get('/open-offers', requirePermission('payments:create'), async (req, res) => {
    const user = requireUser(req);
    const patientId = idParam.parse(req.query.patientId);
    const scope = await moneyScope(db, user);
    const rows = await offerQuery(db).where('q.patient_id', patientId).whereIn('q.status', PAYABLE).orderBy('q.id', 'desc')
      .modify((qb) => { if (user.role === 'doctor') limitToScope(qb, scope); });
    const data: OpenOfferDto[] = rows
      .map((r: Row) => ({ id: r.id, title: r.title, price: round2(Number(r.price)), paid: round2(Number(r.paid)), remaining: round2(Number(r.price) - Number(r.paid)) }))
      .filter((r: OpenOfferDto) => r.remaining > 0);
    res.json({ data });
  });

  router.post('/', requirePermission('payments:create'), async (req, res) => {
    const user = requireUser(req);
    const input = paymentInputSchema.parse(req.body);
    if (input.date > today()) throw badRequest('FUTURE_DATE', 'A payment cannot be dated in the future');
    const scope = await moneyScope(db, user);
    const offer = await payableOffer(user, input.offerId, scope);

    const id = await db.transaction(async (trx) => {
      // Paying more than the price is allowed (a generous client): the offer simply counts as paid.
      const now = sqlNow();
      const [newId] = await trx('payments').insert({
        date: input.date, type: 'clinic', amount: input.amount, remaining: null, currency: offer.currency, description: input.description ?? null,
        method: input.method, quote_id: offer.id, collected_by_doctor_id: offer.p_doctor_id ?? null,
        dr_part: await doctorShare(trx, offer.p_doctor_id ?? null, offer.patient_id), created_by: user.id, created_at: now, updated_at: now,
      });
      await recalcOffer(trx, offer.id);
      return newId as number;
    });
    await audit(ctx, req, { userId: user.id, action: 'payment.create', entity: 'payment', entityId: id, diff: { offerId: offer.id, amount: input.amount, method: input.method } });
    await paymentRecorded(ctx, id, user.id);
    res.status(201).json({ payment: toPaymentDto((await paymentQuery(db).where('pay.id', id).first())!, user) });
  });

  // The receipt handed over with a payment. Staff can print the ones they entered themselves.
  router.get('/:id/receipt', requirePermission('payments:create'), async (req, res) => {
    const user = requireUser(req);
    const row = await loadPayment(user, idParam.parse(req.params.id), await moneyScope(db, user));
    const patient = await db('patients').where({ id: row.patient_id }).first('patient_identifier');
    const pdf = await renderReceiptPdf(
      {
        clinic: await clinicLetterhead(db, row.patient_id), number: row.id, date: row.date,
        patient: { name: `${row.p_fname} ${row.p_lname}`.trim(), number: patient?.patient_identifier ?? '' },
        offerTitle: row.q_title, amount: round2(Number(row.amount)), method: row.method ?? null,
        remaining: row.remaining == null ? null : round2(Number(row.remaining)),
        receivedBy: row.d_fname ? `${row.d_fname} ${row.d_lname}`.trim() : null, note: row.description ?? null,
      },
      { compress: env.NODE_ENV !== 'test' },
    );
    await audit(ctx, req, { userId: user.id, action: 'payment.receipt', entity: 'payment', entityId: row.id });
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="receipt-${row.id}.pdf"`, 'Cache-Control': 'private, no-store' }).send(pdf);
  });

  router.patch('/:id', requirePermission('payments:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = paymentUpdateSchema.parse(req.body);
    const scope = await moneyScope(db, user);
    const row = await loadPayment(user, id, scope);
    if (input.date && input.date > today()) throw badRequest('FUTURE_DATE', 'A payment cannot be dated in the future');

    await db.transaction(async (trx) => {
      const update: Record<string, unknown> = { updated_at: sqlNow() };
      if (input.amount !== undefined) update.amount = input.amount;
      if (input.date !== undefined) update.date = input.date;
      if (input.method !== undefined) update.method = input.method;
      if (input.description !== undefined) update.description = input.description;
      await trx('payments').where({ id }).update(update);
      await recalcOffer(trx, row.quote_id);
    });
    await audit(ctx, req, { userId: user.id, action: 'payment.update', entity: 'payment', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ payment: toPaymentDto((await paymentQuery(db).where('pay.id', id).first())!, user) });
  });

  // Soft delete: to the Trash. The balance is worked out again without it.
  router.delete('/:id', requirePermission('payments:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const row = await loadPayment(user, id, await moneyScope(db, user));
    await db.transaction(async (trx) => {
      const now = sqlNow();
      await trx('payments').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
      await recalcOffer(trx, row.quote_id);
    });
    await audit(ctx, req, { userId: user.id, action: 'payment.delete', entity: 'payment', entityId: id });
    res.status(204).end();
  });

  return router;
}
