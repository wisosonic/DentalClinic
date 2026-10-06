import { createHash, randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import {
  DOCUMENT_MAX_BYTES, DOCUMENT_MAX_PER_PATIENT, DOCUMENT_MIME_TYPES, DOCUMENT_CATEGORIES, documentUpdateSchema, documentUploadSchema,
  type Paginated, type PatientDocumentDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { sniffDocument } from '../../lib/files';
import { doctorScope, ownsPatient } from '../../lib/scope';
import { clinicNow } from '../../lib/time';
import { whereWords } from '../../lib/search';
import { limiter } from '../../middleware/rateLimit';
import { requireAuth, requirePermission, requireUser, type AuthUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();
const listQuery = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
  q: z.string().trim().max(100).optional(),
});

/** What the server names a stored file; checked before any path is built from it. */
const STORED_NAME = /^doc-[a-f0-9]{12}\.(png|jpg|webp|pdf)$/;

/** The name a person is offered when saving: what it is and when, never the original file name (it may name the patient). */
const downloadName = (r: Row, ext: string) => `${r.category}-${String(r.taken_on ?? r.created_at ?? '').slice(0, 10) || 'document'}.${ext}`;

export function documentDir(env: { UPLOAD_DIR: string }): string {
  return path.resolve(env.UPLOAD_DIR, 'documents');
}

/** Deletes stored files, ignoring any that are already gone. Run it after the database change has been committed. */
export async function removeDocumentFiles(env: { UPLOAD_DIR: string }, names: (string | null | undefined)[]): Promise<void> {
  for (const name of names) if (name && STORED_NAME.test(name)) await unlink(path.join(documentDir(env), name)).catch(() => undefined);
}

/**
 * Patient documents (x-ray, panoramic, CBCT report, blood analysis, anything else): images and PDF, 25 MB each.
 * Admin, staff and doctors upload and read; a doctor only for patients he may see in full (an external specialist
 * treating another doctor's patient gets a 404, like the profile). The uploader and admin change or delete.
 * Patients see nothing here.
 */
export function documentRouters(ctx: AppContext): { forPatient: Router; byId: Router } {
  const { db, env } = ctx;

  async function visiblePatient(user: AuthUser, patientId: number): Promise<Row> {
    const row = await db('patients').where({ id: patientId }).whereNull('deleted_at').first('id', 'doctor_id');
    if (!row || !ownsPatient(await doctorScope(db, user), row.doctor_id)) throw notFound('Patient not found');
    return row;
  }

  const query = () =>
    db('patient_documents as d')
      .join('patients as p', 'p.id', 'd.patient_id')
      .leftJoin('users as u', 'u.id', 'd.uploaded_by')
      .leftJoin('appointments as a', function join() {
        this.on('a.id', 'd.appointment_id').andOnNull('a.deleted_at');
      })
      .whereNull('d.deleted_at')
      .whereNull('p.deleted_at')
      .select('d.*', 'p.doctor_id as p_doctor_id', 'u.name as u_name', 'a.date as a_date', 'a.time as a_time');

  const toDto = (r: Row, user: AuthUser): PatientDocumentDto => ({
    id: r.id, patientId: r.patient_id, category: r.category, title: r.title, takenOn: r.taken_on ?? null, note: r.note ?? null,
    fileName: r.original_name, mime: r.mime, sizeBytes: r.size_bytes, isImage: String(r.mime).startsWith('image/'),
    appointment: r.appointment_id && r.a_date ? { id: r.appointment_id, date: r.a_date, time: r.a_time } : null,
    uploadedBy: r.uploaded_by ? { id: r.uploaded_by, name: r.u_name ?? '' } : null,
    createdAt: r.created_at ?? null,
    canChange: user.role === 'admin' || r.uploaded_by === user.id,
  });

  /** A document this person may reach: its patient is not deleted and, for an external specialist, is his own. */
  async function load(user: AuthUser, id: number): Promise<Row> {
    const row: Row | undefined = await query().where('d.id', id).first();
    if (!row || !ownsPatient(await doctorScope(db, user), row.p_doctor_id)) throw notFound('Document not found'); // someone else's looks like none
    return row;
  }

  const mayChange = (user: AuthUser, row: Row) => {
    if (user.role !== 'admin' && row.uploaded_by !== user.id) throw forbidden('Only the person who uploaded a document, or an admin, can change it');
  };

  // ----- /patients/:id/documents -----------------------------------------------------------------------------------
  const forPatient = Router({ mergeParams: true });
  forPatient.use(requireAuth(ctx));

  forPatient.get('/', requirePermission('documents:read'), async (req, res) => {
    const user = requireUser(req);
    const patientId = idParam.parse((req.params as Record<string, string>).id);
    await visiblePatient(user, patientId);
    const q = listQuery.parse(req.query);
    const rows: Row[] = await query().where('d.patient_id', patientId)
      .modify((qb) => {
        if (q.category) qb.where('d.category', q.category);
        whereWords(qb, ['d.title', 'd.original_name', 'd.note'], q.q);
      })
      .orderBy([{ column: 'd.created_at', order: 'desc' }, { column: 'd.id', order: 'desc' }]);
    await auditView(ctx, req, { user, action: 'document.view', patientId });
    const body: Paginated<PatientDocumentDto> = { data: rows.map((r) => toDto(r, user)), meta: { page: 1, pageSize: DOCUMENT_MAX_PER_PATIENT, total: rows.length } };
    res.json(body);
  });

  // The file is the raw request body (the logo pattern, no extra dependency); the details travel in the query string.
  forPatient.post(
    '/', requirePermission('documents:create'), limiter(env, { windowMs: 60_000, limit: 60, message: 'Too many uploads. Please wait a minute.' }),
    express.raw({ type: [...DOCUMENT_MIME_TYPES], limit: DOCUMENT_MAX_BYTES }),
    async (req, res) => {
      const user = requireUser(req);
      const patientId = idParam.parse((req.params as Record<string, string>).id);
      await visiblePatient(user, patientId);
      const input = documentUploadSchema.parse(req.query);
      const body: unknown = req.body;
      const kind = Buffer.isBuffer(body) && body.length > 0 ? sniffDocument(body) : null;
      if (!kind || !Buffer.isBuffer(body)) throw badRequest('INVALID_FILE', 'Choose a PNG, JPEG or WebP picture, or a PDF');
      if (input.appointmentId && !(await db('appointments').where({ id: input.appointmentId, patient_id: patientId }).whereNull('deleted_at').first('id'))) {
        throw badRequest('UNKNOWN_APPOINTMENT', 'Unknown appointment');
      }
      const count = Number((await db('patient_documents').where({ patient_id: patientId }).whereNull('deleted_at').count({ n: '*' }).first())?.n ?? 0);
      if (count >= DOCUMENT_MAX_PER_PATIENT) throw new HttpError(409, 'TOO_MANY_DOCUMENTS', `A patient can have at most ${DOCUMENT_MAX_PER_PATIENT} documents`);
      const sha256 = createHash('sha256').update(body).digest('hex');
      if (!input.allowDuplicate && (await db('patient_documents').where({ patient_id: patientId, sha256 }).whereNull('deleted_at').first('id'))) {
        throw new HttpError(409, 'DUPLICATE_DOCUMENT', 'This patient already has exactly this file');
      }

      const name = `doc-${randomBytes(6).toString('hex')}.${kind.ext}`;
      await mkdir(documentDir(env), { recursive: true });
      await writeFile(path.join(documentDir(env), name), body);
      const now = sqlNow();
      let id: number;
      try {
        [id] = await db('patient_documents').insert({
          patient_id: patientId, appointment_id: input.appointmentId ?? null, category: input.category, title: input.title, taken_on: input.takenOn ?? clinicNow(env, ctx.clock()).date,
          note: input.note ?? null, file_name: name, original_name: (input.name || `${input.category}.${kind.ext}`).slice(0, 255), mime: kind.mime, size_bytes: body.length,
          sha256, uploaded_by: user.id, created_at: now, updated_at: now,
        });
      } catch (err) {
        await removeDocumentFiles(env, [name]); // never leave a file nobody knows about
        throw err;
      }
      await audit(ctx, req, { userId: user.id, action: 'document.upload', entity: 'document', entityId: id!, diff: { patientId, category: input.category, bytes: body.length } });
      res.status(201).json({ document: toDto(await query().where('d.id', id!).first(), user) });
    },
  );

  // ----- /documents/:id ---------------------------------------------------------------------------------------------
  const byId = Router();
  byId.use(requireAuth(ctx));

  byId.get('/:id/file', requirePermission('documents:read'), async (req, res) => {
    const user = requireUser(req);
    const row = await load(user, idParam.parse(req.params.id));
    if (!STORED_NAME.test(row.file_name)) throw notFound('Document not found');
    await auditView(ctx, req, { user, action: 'document.view', patientId: row.patient_id });
    const ext = row.file_name.split('.').pop() as string;
    const headers: Record<string, string> = {
      'Content-Type': row.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${downloadName(row, ext)}"`,
    };
    // A picture can never run anything; a PDF is shown by the browser's own viewer, which a sandbox policy would stop.
    if (row.mime !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    res.sendFile(row.file_name, { root: documentDir(env), dotfiles: 'deny', headers }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });
    });
  });

  byId.patch('/:id', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = documentUpdateSchema.parse(req.body);
    const row = await load(user, id);
    mayChange(user, row);
    if (input.appointmentId && !(await db('appointments').where({ id: input.appointmentId, patient_id: row.patient_id }).whereNull('deleted_at').first('id'))) {
      throw badRequest('UNKNOWN_APPOINTMENT', 'Unknown appointment');
    }
    await db('patient_documents').where({ id }).update({
      ...(input.category !== undefined && { category: input.category }),
      ...(input.title !== undefined && { title: input.title }),
      ...(input.takenOn !== undefined && { taken_on: input.takenOn }),
      ...(input.appointmentId !== undefined && { appointment_id: input.appointmentId }),
      ...(input.note !== undefined && { note: input.note }),
      updated_at: sqlNow(),
    });
    await audit(ctx, req, { userId: user.id, action: 'document.update', entity: 'document', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ document: toDto(await query().where('d.id', id).first(), user) });
  });

  // Soft delete: the document (and its file) goes to the Trash; only an admin restores it or erases it for good.
  byId.delete('/:id', requirePermission('documents:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const row = await load(user, id);
    mayChange(user, row);
    const now = sqlNow();
    await db('patient_documents').where({ id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: user.id, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'document.delete', entity: 'document', entityId: id, diff: { patientId: row.patient_id } });
    res.status(204).end();
  });

  return { forPatient, byId };
}
