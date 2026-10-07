import { Router } from 'express';
import { z } from 'zod';
import type { TrashItemDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { assertBookable } from '../appointments/service';
import { recalcOffer } from '../offers/service';
import { audit } from '../audit/audit';
import { removeDocumentFiles } from '../documents/router';
import { countsOf, erase, footprint, type TrashKind } from './purge';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();
const kindParam = z.enum(['patient', 'appointment', 'report', 'offer', 'payment', 'commission', 'expense', 'lab_order', 'document']);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  kind: kindParam.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['deletedAt', 'kind', 'label', 'deletedBy']).default('deletedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const TABLES = { patient: 'patients', appointment: 'appointments', report: 'reports', offer: 'treatment_offers', payment: 'payments', commission: 'payments', expense: 'expenses', lab_order: 'lab_orders', document: 'patient_documents' } as const;

const purgeBody = z.object({ confirm: z.string().trim().max(200) });

/**
 * The Trash: everything staff and doctors have deleted. Only an admin can see it, restore from it, or
 * erase from it for good. (Nothing can be erased without first being in the Trash.)
 */
export function trashRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin'));

  const name = (r: Row, prefix = '') => `${r[`${prefix}fname`]} ${r[`${prefix}lname`]}`.trim();

  /** Every item in the Trash. The Trash is small, so it is gathered and sorted here. */
  async function allItems(): Promise<TrashItemDto[]> {
    const who = (r: Row) => r.by_name ?? null;
    const patients: Row[] = await db('patients as p').leftJoin('users as u', 'u.id', 'p.deleted_by').whereNotNull('p.deleted_at')
      .select('p.id', 'p.fname', 'p.lname', 'p.patient_identifier', 'p.deleted_at', 'u.name as by_name');
    const appointments: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').leftJoin('users as u', 'u.id', 'a.deleted_by')
      .whereNotNull('a.deleted_at')
      .select('a.id', 'a.date', 'a.time', 'a.deleted_at', 'p.fname', 'p.lname', 'p.deleted_at as patient_deleted_at', 'u.name as by_name');
    const reports: Row[] = await db('reports as r').join('appointments as a', 'a.id', 'r.appointment_id').join('patients as p', 'p.id', 'a.patient_id')
      .leftJoin('users as u', 'u.id', 'r.deleted_by').whereNotNull('r.deleted_at')
      .select('r.id', 'a.date', 'a.time', 'r.deleted_at', 'p.fname', 'p.lname', 'a.deleted_at as appointment_deleted_at', 'u.name as by_name');
    const offers: Row[] = await db('treatment_offers as q').join('patients as p', 'p.id', 'q.patient_id').leftJoin('users as u', 'u.id', 'q.deleted_by')
      .whereNotNull('q.deleted_at')
      .select('q.id', 'q.title', 'q.price', 'q.deleted_at', 'p.fname', 'p.lname', 'p.deleted_at as patient_deleted_at', 'u.name as by_name');
    const payments: Row[] = await db('payments as pay').join('treatment_offers as q', 'q.id', 'pay.offer_id').join('patients as p', 'p.id', 'q.patient_id')
      .leftJoin('users as u', 'u.id', 'pay.deleted_by').whereNotNull('pay.deleted_at')
      .select('pay.id', 'pay.date', 'pay.amount', 'pay.deleted_at', 'p.fname', 'p.lname', 'q.deleted_at as offer_deleted_at', 'u.name as by_name');
    const commissions: Row[] = await db('payments as pay').leftJoin('doctors as sd', 'sd.id', 'pay.model_id').leftJoin('doctors as od', 'od.id', 'pay.collected_by_doctor_id')
      .leftJoin('users as u', 'u.id', 'pay.deleted_by').where('pay.type', 'commission').whereNotNull('pay.deleted_at')
      .select('pay.id', 'pay.date', 'pay.amount', 'pay.deleted_at', 'sd.fname as s_fname', 'sd.lname as s_lname', 'od.fname as o_fname', 'od.lname as o_lname', 'u.name as by_name');
    const expenses: Row[] = await db('expenses as e').leftJoin('users as u', 'u.id', 'e.deleted_by').whereNotNull('e.deleted_at')
      .select('e.id', 'e.date', 'e.type', 'e.amount', 'e.description', 'e.deleted_at', 'u.name as by_name');
    const documents: Row[] = await db('patient_documents as d').join('patients as p', 'p.id', 'd.patient_id').leftJoin('users as u', 'u.id', 'd.deleted_by').whereNotNull('d.deleted_at')
      .select('d.id', 'd.title', 'd.category', 'd.deleted_at', 'p.fname', 'p.lname', 'p.deleted_at as patient_deleted_at', 'u.name as by_name');
    const labOrders: Row[] = await db('lab_orders as o').join('patients as p', 'p.id', 'o.patient_id').join('labs as l', 'l.id', 'o.lab_id').leftJoin('users as u', 'u.id', 'o.deleted_by').whereNotNull('o.deleted_at')
      .select('o.id', 'o.item', 'l.name as lab', 'o.deleted_at', 'p.fname', 'p.lname', 'p.deleted_at as patient_deleted_at', 'u.name as by_name');
    return [
      ...documents.map((r): TrashItemDto => ({
        kind: 'document', id: r.id, label: name(r), detail: `${r.title} · ${r.category}`, confirmText: name(r), deletedAt: r.deleted_at, deletedBy: who(r), blockedBy: r.patient_deleted_at ? 'patient' : null,
      })),
      ...labOrders.map((r): TrashItemDto => ({
        kind: 'lab_order', id: r.id, label: name(r), detail: `${r.item} · ${r.lab}`, confirmText: name(r), deletedAt: r.deleted_at, deletedBy: who(r), blockedBy: r.patient_deleted_at ? 'patient' : null,
      })),
      ...commissions.map((r): TrashItemDto => {
        const label = `${name(r, 's_')} → ${name(r, 'o_')}`.trim();
        return { kind: 'commission', id: r.id, label, detail: `${r.date} · ${Number(r.amount).toFixed(2)}`, confirmText: name(r, 's_') || label, deletedAt: r.deleted_at, deletedBy: who(r), blockedBy: null };
      }),
      ...expenses.map((r): TrashItemDto => ({
        kind: 'expense', id: r.id, label: r.description || r.type, detail: `${r.date} · ${Number(r.amount).toFixed(2)}`, confirmText: Number(r.amount).toFixed(2), deletedAt: r.deleted_at, deletedBy: who(r), blockedBy: null,
      })),
      ...offers.map((r): TrashItemDto => ({
        kind: 'offer', id: r.id, label: name(r), detail: `${r.title} · ${Number(r.price).toFixed(2)}`, confirmText: name(r), deletedAt: r.deleted_at, deletedBy: who(r),
        blockedBy: r.patient_deleted_at ? 'patient' : null,
      })),
      ...payments.map((r): TrashItemDto => ({
        kind: 'payment', id: r.id, label: name(r), detail: `${r.date} · ${Number(r.amount).toFixed(2)}`, confirmText: name(r), deletedAt: r.deleted_at, deletedBy: who(r),
        blockedBy: r.offer_deleted_at ? 'offer' : null,
      })),
      ...patients.map((r): TrashItemDto => ({
        kind: 'patient', id: r.id, label: name(r), detail: `#${r.patient_identifier}`, confirmText: name(r), deletedAt: r.deleted_at, deletedBy: who(r), blockedBy: null,
      })),
      ...appointments.map((r): TrashItemDto => ({
        kind: 'appointment', id: r.id, label: name(r), detail: `${r.date} ${r.time}`, confirmText: name(r), deletedAt: r.deleted_at, deletedBy: who(r),
        blockedBy: r.patient_deleted_at ? 'patient' : null,
      })),
      ...reports.map((r): TrashItemDto => ({
        kind: 'report', id: r.id, label: name(r), detail: `${r.date} ${r.time}`, confirmText: name(r), deletedAt: r.deleted_at, deletedBy: who(r),
        blockedBy: r.appointment_deleted_at ? 'appointment' : null,
      })),
    ];
  }

  router.get('/', requirePermission('trash:read'), async (req, res) => {
    const q = listQuery.parse(req.query);
    const needle = q.q?.toLowerCase();
    let items = await allItems();
    if (q.kind) items = items.filter((i) => i.kind === q.kind);
    if (needle) items = items.filter((i) => `${i.label} ${i.detail}`.toLowerCase().includes(needle));
    const key = { deletedAt: (i: TrashItemDto) => i.deletedAt, kind: (i: TrashItemDto) => i.kind, label: (i: TrashItemDto) => i.label.toLowerCase(), deletedBy: (i: TrashItemDto) => (i.deletedBy ?? '').toLowerCase() }[q.sort];
    const sign = q.order === 'asc' ? 1 : -1;
    items.sort((a, b) => (key(a) < key(b) ? -sign : key(a) > key(b) ? sign : a.id - b.id));
    res.json({ data: items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), meta: { page: q.page, pageSize: q.pageSize, total: items.length } });
  });

  /** The patient an item belongs to (the admin types their name to erase it). */
  async function patientBehind(kind: TrashKind, row: Row): Promise<Row> {
    if (kind === 'patient') return row;
    // Money that is not a patient's: the admin types the specialist's name (commission) or the amount (an expense).
    if (kind === 'commission') {
      const s = await db('doctors').where({ id: row.model_id }).first('fname', 'lname');
      return { fname: s?.fname ?? '', lname: s?.lname ?? '' };
    }
    if (kind === 'expense') return { fname: Number(row.amount).toFixed(2), lname: '' };
    let patientId: number;
    if (kind === 'appointment' || kind === 'offer' || kind === 'lab_order' || kind === 'document') patientId = row.patient_id;
    else if (kind === 'report') patientId = (await db('appointments').where({ id: row.appointment_id }).first('patient_id')).patient_id;
    else patientId = (await db('treatment_offers').where({ id: row.offer_id }).first('patient_id')).patient_id;
    return db('patients').where({ id: patientId }).first('fname', 'lname');
  }

  /** Looks up an item that is in the Trash, or 404. */
  async function inTrash(kind: TrashKind, id: number): Promise<Row> {
    const table = TABLES[kind];
    const row = await db(table).where({ id }).whereNotNull('deleted_at').first();
    if (!row) throw notFound('This item is not in the Trash');
    return row;
  }

  // What erasing this would remove: shown in the warning before anything is done.
  router.get('/:kind/:id/impact', requirePermission('trash:read'), async (req, res) => {
    const kind = kindParam.parse(req.params.kind);
    const id = idParam.parse(req.params.id);
    await inTrash(kind, id);
    res.json({ counts: await countsOf(db, await footprint(db, kind, id)) });
  });

  router.post('/:kind/:id/restore', requirePermission('trash:update'), async (req, res) => {
    const user = requireUser(req);
    const kind = kindParam.parse(req.params.kind);
    const id = idParam.parse(req.params.id);
    const row = await inTrash(kind, id);

    if (kind === 'appointment') {
      const patient = await db('patients').where({ id: row.patient_id }).first('deleted_at');
      if (patient?.deleted_at) throw new HttpError(409, 'RESTORE_PATIENT_FIRST', 'Restore the patient first');
      // Its time may have been taken while it was in the Trash.
      if (['pending', 'confirmed', 'completed'].includes(row.status)) {
        await db.transaction(async (trx) => {
          await assertBookable(ctx, trx, {
            doctorId: row.doctor_id, clinicId: row.clinic_id, unitId: row.unit_id, date: row.date, time: row.time,
            durationMinutes: row.duration_minutes, excludeId: id,
          });
        });
      }
    }
    if (kind === 'report') {
      const appt = await db('appointments').where({ id: row.appointment_id }).first('deleted_at');
      if (appt?.deleted_at) throw new HttpError(409, 'RESTORE_APPOINTMENT_FIRST', 'Restore the appointment first');
    }

    if (kind === 'offer' || kind === 'lab_order' || kind === 'document') {
      const patient = await db('patients').where({ id: row.patient_id }).first('deleted_at');
      if (patient?.deleted_at) throw new HttpError(409, 'RESTORE_PATIENT_FIRST', 'Restore the patient first');
    }
    if (kind === 'payment') {
      const offer = await db('treatment_offers').where({ id: row.offer_id }).first('deleted_at');
      if (offer?.deleted_at) throw new HttpError(409, 'RESTORE_OFFER_FIRST', 'Restore the treatment offer first');
    }

    const table = TABLES[kind];
    await db.transaction(async (trx) => {
      await trx(table).where({ id }).update({ deleted_at: null, deleted_by: null, updated_at: sqlNow() });
      // A restored payment counts again, so the offer's balance is worked out afresh.
      if (kind === 'payment') {
        await recalcOffer(trx, row.offer_id);
      }
    });
    await audit(ctx, req, { userId: user.id, action: 'trash.restore', entity: kind, entityId: id });
    res.status(204).end();
  });

  router.delete('/:kind/:id', requirePermission('trash:delete'), async (req, res) => {
    const user = requireUser(req);
    const kind = kindParam.parse(req.params.kind);
    const id = idParam.parse(req.params.id);
    const { confirm } = purgeBody.parse(req.body ?? {});
    const row = await inTrash(kind, id);

    // The admin types the patient's name: a deliberate act, not a stray click.
    const patientRow = await patientBehind(kind, row);
    const expected = `${patientRow.fname} ${patientRow.lname}`.trim();
    if (confirm.toLowerCase() !== expected.toLowerCase()) throw badRequest('CONFIRM_MISMATCH', 'The name you typed does not match');

    let files: string[] = [];
    const counts = await db.transaction(async (trx) => {
      const f = await footprint(trx, kind, id);
      const c = await countsOf(trx, f);
      if (f.documents.length) files = (await trx('patient_documents').whereIn('id', f.documents).select('file_name')).map((r: Row) => r.file_name as string);
      const offerOfPayment = kind === 'payment' ? (await trx('payments').where({ id }).first('offer_id'))?.offer_id : null;
      await erase(trx, f);
      if (offerOfPayment) await recalcOffer(trx, offerOfPayment);
      return c;
    });
    await removeDocumentFiles(ctx.env, files); // only once the database change is safe
    // Who, what and how much: never the content, and the entry stays after the data is gone.
    await audit(ctx, req, { userId: user.id, action: 'trash.purge', entity: kind, entityId: id, diff: { counts } });
    res.status(204).end();
  });

  return router;
}
