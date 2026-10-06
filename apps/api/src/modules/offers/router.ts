import { Router } from 'express';
import { z } from 'zod';
import {
  OFFER_ACTIONS, OFFER_STATUSES, PAYMENT_STATES, WORK_STATES, appointmentInputSchema, offerInputSchema, offerItemsSchema, offerUpdateSchema,
  type OfferDto, type OfferInput, type OfferItemInput, type OfferStatus, type Paginated,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { doctorScope } from '../../lib/scope';
import { whereWords } from '../../lib/search';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';
import { assertBookable } from '../appointments/service';
import { PAID_SQL, limitToScope, round2, type MoneyScope } from '../finance/service';
import { clinicLetterhead } from '../finance/letterhead';
import { renderOfferPdf } from '../finance/pdf';
import { appointmentBooked, offerChanged } from '../notifications/events';
import { CLOSED, OWING, mayWrite, offerQuery, offerScope, recalcOffer, syncOffer, toOfferDtos } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  patientId: z.coerce.number().int().positive().optional(),
  status: z.string().optional().transform((v) => (v ? v.split(',') : undefined)).pipe(z.array(z.enum(OFFER_STATUSES)).optional()),
  paymentState: z.enum(PAYMENT_STATES).optional(),
  workState: z.enum(WORK_STATES).optional(),
  /** Only offers the patient still owes money on. */
  debt: z.enum(['1']).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['patient', 'title', 'price', 'paid', 'remaining', 'status', 'created']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const ORDER: Record<string, string[]> = {
  patient: ['p.lname', 'p.fname'], title: ['q.title'], price: ['q.price'], paid: ['paid'], remaining: ['remaining'], status: ['q.status'], created: ['q.created_at'],
};

/** When one of the offer's visits is booked it takes these from the usual booking rules. */
const scheduleSchema = appointmentInputSchema.pick({ doctorId: true, clinicId: true, unitId: true, date: true, time: true, durationMinutes: true });

const safeName = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'document';

/**
 * Treatment offers: what will be done, what it costs, what the patient agreed to and what was paid (plans and
 * quotes used to be two things). An admin and the staff see all of them, a doctor only those of patients whose
 * primary doctor he is (another doctor's is a 404, never a 403). Staff never see the clinic's cost and cannot
 * create or change an offer, but they book its visits.
 */
export function offersRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin', 'doctor', 'staff'));

  async function load(user: AuthUser, id: number, scope?: MoneyScope): Promise<Row> {
    const qb = offerQuery(db).where('q.id', id);
    limitToScope(qb, scope ?? (await offerScope(db, user)));
    const row: Row | undefined = await qb.first();
    if (!row) throw notFound('Treatment offer not found'); // another doctor's offer looks exactly like one that doesn't exist
    return row;
  }

  /** The offer with its items, for a response. */
  const show = async (user: AuthUser, id: number): Promise<OfferDto> => (await toOfferDtos(db, [await load(user, id)], user, true))[0]!;

  async function writable(user: AuthUser, id: number): Promise<Row> {
    const scope = await offerScope(db, user);
    const row = await load(user, id, scope);
    if (!mayWrite(user, row.p_doctor_id, scope)) throw forbidden('Only the patient’s doctor can change a treatment offer');
    return row;
  }

  const notClosed = (row: Row) => {
    if (CLOSED.includes(row.status)) throw new HttpError(409, 'NOT_EDITABLE', `A ${row.status} treatment offer cannot be changed`, { status: row.status });
  };

  /** Checks the references the items make. */
  async function checkItems(items: OfferItemInput[]) {
    const toothIds = [...new Set(items.map((i) => i.toothId).filter(Boolean) as number[])];
    const categoryIds = [...new Set(items.map((i) => i.categoryId).filter(Boolean) as number[])];
    if (toothIds.length && Number(((await db('teeth').whereIn('id', toothIds).count({ n: '*' }).first()) as Row).n) !== toothIds.length) throw badRequest('UNKNOWN_TOOTH', 'Unknown tooth');
    if (categoryIds.length && Number(((await db('categories').whereIn('id', categoryIds).count({ n: '*' }).first()) as Row).n) !== categoryIds.length) throw badRequest('UNKNOWN_CATEGORY', 'Unknown procedure');
  }

  router.get('/', requirePermission('offers:read'), async (req, res) => {
    const user = requireUser(req);
    const q = listQuery.parse(req.query);
    const scope = await offerScope(db, user);
    const filtered = offerQuery(db).modify((qb) => {
      limitToScope(qb, scope);
      if (q.patientId) qb.where('q.patient_id', q.patientId);
      if (q.status?.length) qb.whereIn('q.status', q.status);
      if (q.debt) qb.whereIn('q.status', OWING).whereRaw(`q.price - ${PAID_SQL} > 0.004`);
      if (q.paymentState === 'unpaid') qb.whereRaw(`${PAID_SQL} <= 0.004`);
      if (q.paymentState === 'partly_paid') qb.whereRaw(`${PAID_SQL} > 0.004`).whereRaw(`q.price - ${PAID_SQL} > 0.004`);
      if (q.paymentState === 'paid') qb.whereRaw(`${PAID_SQL} > 0.004`).whereRaw(`q.price - ${PAID_SQL} <= 0.004`);
      if (q.workState === 'completed') qb.whereExists((s) => s.select(db.raw('1')).from('offer_items as w').whereRaw('w.offer_id = q.id')).whereNotExists((s) => s.select(db.raw('1')).from('offer_items as w').whereRaw('w.offer_id = q.id').whereNot('w.status', 'done'));
      if (q.workState === 'in_progress') qb.whereExists((s) => s.select(db.raw('1')).from('offer_items as w').whereRaw('w.offer_id = q.id').whereIn('w.status', ['scheduled', 'done'])).whereExists((s) => s.select(db.raw('1')).from('offer_items as w').whereRaw('w.offer_id = q.id').whereNot('w.status', 'done'));
      if (q.workState === 'not_started') qb.whereNotExists((s) => s.select(db.raw('1')).from('offer_items as w').whereRaw('w.offer_id = q.id').whereIn('w.status', ['scheduled', 'done']));
      whereWords(qb, ['q.title', 'p.fname', 'p.lname'], q.q);
    });
    const total = Number((await filtered.clone().clearSelect().count({ n: '*' }).first())?.n ?? 0);
    const rows: Row[] = await filtered.clone()
      .select(db.raw(`(q.price - ${PAID_SQL}) as remaining`))
      .orderBy([...ORDER[q.sort]!, 'q.id'].map((column) => ({ column, order: q.order })))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const body: Paginated<OfferDto> = { data: await toOfferDtos(db, rows, user, false), meta: { page: q.page, pageSize: q.pageSize, total } };
    res.json(body);
  });

  // The offer as a PDF for the patient: items with prices, the total and what is paid, never the clinic's cost.
  router.get('/:id/pdf', requirePermission('offers:read'), async (req, res) => {
    const user = requireUser(req);
    const offer = (await toOfferDtos(db, [await load(user, idParam.parse(req.params.id))], user, true))[0]!;
    const patient = await db('patients').where({ id: offer.patientId }).first('patient_identifier');
    const pdf = await renderOfferPdf(
      {
        clinic: await clinicLetterhead(db, offer.patientId), number: offer.id, date: (offer.createdAt ?? '').slice(0, 10), status: offer.status,
        patient: { name: `${offer.patient.fname} ${offer.patient.lname}`.trim(), number: patient?.patient_identifier ?? '' },
        doctor: offer.doctor ? `${offer.doctor.fname} ${offer.doctor.lname}`.trim() : null,
        title: offer.title, description: offer.description, notes: offer.notes,
        items: (offer.items ?? []).map((i) => ({ description: i.description, tooth: i.tooth?.index ?? null, price: i.price })),
        price: offer.price, paid: offer.paid,
      },
      { compress: env.NODE_ENV !== 'test' },
    );
    await audit(ctx, req, { userId: user.id, action: 'offer.pdf', entity: 'offer', entityId: offer.id });
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="offer-${offer.id}-${safeName(offer.patient.lname)}.pdf"`, 'Cache-Control': 'private, no-store' }).send(pdf);
  });

  router.get('/:id', requirePermission('offers:read'), async (req, res) => {
    const user = requireUser(req);
    const offer = await show(user, idParam.parse(req.params.id));
    await auditView(ctx, req, { user, action: 'offer.view', patientId: offer.patientId });
    res.json({ offer });
  });

  router.post('/', requirePermission('offers:create'), async (req, res) => {
    const user = requireUser(req);
    const input: OfferInput = offerInputSchema.parse(req.body);
    const scope = await offerScope(db, user);
    const patient = await db('patients').where({ id: input.patientId }).whereNull('deleted_at').first('id', 'doctor_id');
    // Another doctor's patient looks like no patient at all.
    if (!patient || !mayWrite(user, patient.doctor_id, scope)) throw badRequest('UNKNOWN_PATIENT', 'Unknown patient');
    const items = input.items ?? [];
    await checkItems(items);
    const now = sqlNow();
    const id = await db.transaction(async (trx) => {
      const [offerId] = await trx('quotes').insert({
        title: input.title, description: input.description ?? null, type: 'clinic', price: 0, cost: 0, currency: '$', status: 'draft', patient_id: patient.id,
        doctor_id: patient.doctor_id ?? null, start_date: input.startDate ?? null, notes: input.notes ?? null, created_at: now, updated_at: now,
      });
      if (items.length) {
        await trx('offer_items').insert(items.map((i, n) => ({
          offer_id: offerId, description: i.description, tooth_id: i.toothId ?? null, category_id: i.categoryId ?? null, price: round2(Number(i.price)),
          cost: i.cost == null ? null : round2(Number(i.cost)), sequence: n + 1, status: 'pending', created_at: now, updated_at: now,
        })));
      }
      await recalcOffer(trx, offerId as number, { fromItems: true });
      return offerId as number;
    });
    await audit(ctx, req, { userId: user.id, action: 'offer.create', entity: 'offer', entityId: id, diff: { patientId: patient.id, items: items.length } });
    res.status(201).json({ offer: await show(user, id) });
  });

  router.patch('/:id', requirePermission('offers:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = offerUpdateSchema.parse(req.body);
    notClosed(await writable(user, id));
    await db('quotes').where({ id }).update({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.startDate !== undefined && { start_date: input.startDate }),
      ...(input.notes !== undefined && { notes: input.notes }),
      updated_at: sqlNow(),
    });
    await audit(ctx, req, { userId: user.id, action: 'offer.update', entity: 'offer', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ offer: await show(user, id) });
  });

  /**
   * Replaces the list of items. Items sent with their id keep their visit and progress; the rest are new. The
   * offer's price and cost become the sums of the items; the price can never fall below what has been paid.
   */
  router.put('/:id/items', requirePermission('offers:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const { items } = offerItemsSchema.parse(req.body);
    const offer = await writable(user, id);
    notClosed(offer);
    await checkItems(items);
    const existing: Row[] = await db('offer_items').where({ offer_id: id });
    const byId = new Map(existing.map((i) => [i.id as number, i]));
    for (const i of items) if (i.id !== undefined && !byId.has(i.id)) throw badRequest('UNKNOWN_ITEM', 'That item is not part of this offer');
    const kept = new Set(items.map((i) => i.id).filter((v): v is number => v !== undefined));
    // an item with a booked or finished visit cannot just disappear
    if (existing.find((i) => !kept.has(i.id) && i.status !== 'pending')) throw conflict('ITEM_IN_USE', 'An item that is booked or done cannot be removed');
    const total = round2(items.reduce((s, i) => s + Number(i.price), 0));
    const paid = round2(Number(offer.paid ?? 0));
    if (total < paid - 0.004) throw new HttpError(409, 'PRICE_BELOW_PAID', 'The total cannot be lower than what has already been paid', { paid });
    const now = sqlNow();
    await db.transaction(async (trx) => {
      const gone = existing.filter((i) => !kept.has(i.id)).map((i) => i.id as number);
      if (gone.length) await trx('offer_items').whereIn('id', gone).del();
      for (const [n, i] of items.entries()) {
        const fields = {
          description: i.description, tooth_id: i.toothId ?? null, category_id: i.categoryId ?? null, price: round2(Number(i.price)),
          cost: i.cost == null ? null : round2(Number(i.cost)), sequence: n + 1, updated_at: now,
        };
        if (i.id !== undefined) await trx('offer_items').where({ id: i.id }).update(fields);
        else await trx('offer_items').insert({ ...fields, offer_id: id, status: 'pending', created_at: now });
      }
      await syncOffer(trx, id);
      await recalcOffer(trx, id, { fromItems: true });
    });
    await audit(ctx, req, { userId: user.id, action: 'offer.items', entity: 'offer', entityId: id, diff: { items: items.length } });
    res.json({ offer: await show(user, id) });
  });

  router.post('/:id/items/:itemId/schedule', requirePermission('appointments:create'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const itemId = idParam.parse(req.params.itemId);
    const body = scheduleSchema.parse(req.body);
    const offer = await load(user, id); // staff may book, a doctor only for his own patients (404 otherwise)
    if (offer.status !== 'accepted') throw new HttpError(409, 'OFFER_NOT_ACCEPTED', 'Visits can be booked once the patient has accepted the offer', { status: offer.status });
    const item: Row | undefined = await db('offer_items').where({ id: itemId, offer_id: id }).first();
    if (!item) throw notFound('Treatment offer item not found');
    if (item.status !== 'pending') throw new HttpError(409, 'ITEM_NOT_PENDING', 'This item already has a visit or is done', { status: item.status });
    const scope = await doctorScope(db, user);
    if (scope.restricted && body.doctorId !== scope.doctorId) throw forbidden('You can only book appointments for yourself');
    if (!(await db('doctors').where({ id: body.doctorId }).first('id'))) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    if (!(await db('clinics').where({ id: body.clinicId }).first('id'))) throw badRequest('UNKNOWN_CLINIC', 'Unknown clinic');
    const now = sqlNow();
    const appointmentId = await db.transaction(async (trx) => {
      await assertBookable(ctx, trx, { doctorId: body.doctorId, clinicId: body.clinicId, unitId: body.unitId, date: body.date, time: body.time, durationMinutes: body.durationMinutes });
      const [newId] = await trx('appointments').insert({
        date: body.date, time: body.time, duration_minutes: body.durationMinutes, status: 'confirmed', intended: String(item.description).slice(0, 255),
        patient_id: offer.patient_id, doctor_id: body.doctorId, clinic_id: body.clinicId, unit_id: body.unitId, created_at: now, updated_at: now,
      });
      if (item.category_id) await trx('appointment_category').insert({ appointment_id: newId, category_id: item.category_id, created_at: now, updated_at: now });
      if (item.tooth_id) await trx('appointment_tooth').insert({ appointment_id: newId, tooth_id: item.tooth_id, created_at: now, updated_at: now });
      await trx('offer_items').where({ id: itemId }).update({ appointment_id: newId, status: 'scheduled', updated_at: now });
      await syncOffer(trx, id);
      return newId as number;
    });
    await audit(ctx, req, { userId: user.id, action: 'appointment.create', entity: 'appointment', entityId: appointmentId, diff: { offerId: id, itemId, date: body.date, time: body.time } });
    await appointmentBooked(ctx, appointmentId, user.id);
    res.status(201).json({ offer: await show(user, id), appointmentId });
  });

  /** Marks an item done without a visit behind it (work finished elsewhere or recorded late). */
  router.post('/:id/items/:itemId/done', requirePermission('offers:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const itemId = idParam.parse(req.params.itemId);
    const offer = await writable(user, id);
    if (offer.status !== 'accepted') throw new HttpError(409, 'OFFER_NOT_ACCEPTED', 'Work can be marked done once the patient has accepted the offer', { status: offer.status });
    const item: Row | undefined = await db('offer_items').where({ id: itemId, offer_id: id }).first();
    if (!item) throw notFound('Treatment offer item not found');
    if (item.status !== 'pending') throw new HttpError(409, 'ITEM_NOT_PENDING', 'This item already has a visit or is done', { status: item.status });
    const now = sqlNow();
    await db('offer_items').where({ id: itemId }).update({ status: 'done', completed_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'offer.item_done', entity: 'offer', entityId: id, diff: { itemId } });
    res.json({ offer: await show(user, id) });
  });

  // send / accept / reject / expire / cancel: set by hand by the doctor or admin. Paid and the work state follow the payments and items.
  const RULES: Record<(typeof OFFER_ACTIONS)[number], { from: OfferStatus[]; to: OfferStatus; said: string }> = {
    send: { from: ['draft'], to: 'sent', said: 'sent' },
    accept: { from: ['draft', 'sent'], to: 'accepted', said: 'accepted' },
    reject: { from: ['draft', 'sent', 'accepted'], to: 'rejected', said: 'rejected' },
    expire: { from: ['sent'], to: 'expired', said: 'marked as expired' },
    cancel: { from: ['draft', 'sent', 'accepted'], to: 'cancelled', said: 'cancelled' },
  };

  router.post('/:id/:action', requirePermission('offers:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const action = z.enum(OFFER_ACTIONS).safeParse(req.params.action);
    if (!action.success) throw notFound('Unknown action');
    const rule = RULES[action.data];
    const offer = await writable(user, id);
    if (!rule.from.includes(offer.status)) {
      throw new HttpError(409, 'INVALID_OFFER_TRANSITION', `A ${String(offer.status).replace('_', ' ')} offer cannot be ${rule.said}`, { status: offer.status, action: action.data });
    }
    const items: Row[] = await db('offer_items').where({ offer_id: id }).select('status');
    if ((action.data === 'send' || action.data === 'accept') && !items.length) throw new HttpError(409, 'EMPTY_OFFER', 'Add at least one item first');
    if ((action.data === 'reject' || action.data === 'cancel') && round2(Number(offer.paid)) > 0) {
      throw new HttpError(409, 'HAS_PAYMENTS', `An offer with payments cannot be ${rule.said}`);
    }
    if ((action.data === 'reject' || action.data === 'cancel') && items.some((i) => i.status !== 'pending')) {
      throw new HttpError(409, 'WORK_STARTED', `An offer with visits booked or work done cannot be ${rule.said}`);
    }
    await db.transaction(async (trx) => {
      const changed = await trx('quotes').where({ id }).whereIn('status', rule.from).update({ status: rule.to, updated_at: sqlNow() });
      if (!changed) throw new HttpError(409, 'INVALID_OFFER_TRANSITION', 'The offer was just changed by someone else');
    });
    await audit(ctx, req, { userId: user.id, action: `offer.${action.data}`, entity: 'offer', entityId: id, diff: { from: offer.status, to: rule.to } });
    if (action.data === 'send' || action.data === 'accept') await offerChanged(ctx, id, action.data === 'send' ? 'sent' : 'accepted', user.id);
    res.json({ offer: await show(user, id) });
  });

  // Soft delete: the offer goes to the Trash (admin only restores or erases), its payments with it.
  router.delete('/:id', requirePermission('offers:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await writable(user, id);
    const now = sqlNow();
    await db('quotes').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'offer.delete', entity: 'offer', entityId: id });
    res.status(204).end();
  });

  return router;
}
