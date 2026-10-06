import { z } from 'zod';
import { dateSchema } from './clinical';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(max).nullable().optional());
const optionalDate = z.preprocess((v) => (v === '' ? null : v), dateSchema.nullable().optional());
const optionalId = z.preprocess((v) => (v === '' || v === 0 || v === '0' ? null : v), z.coerce.number().int().positive().nullable().optional());

// ---------------------------------------------------------------------------
// Patient documents: x-rays, panoramas, CBCT reports and screenshots, blood analysis, anything else.
// Images and PDF only, 25 MB each, stored on the server (owner decision 2026-10-05).
// ---------------------------------------------------------------------------

export const DOCUMENT_CATEGORIES = ['xray', 'panoramic', 'cbct', 'blood_test', 'other'] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
/** What a person may choose to upload (the server checks the file's own bytes, never this). */
export const DOCUMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
/** More than this many documents for one patient is refused (runaway disk use). */
export const DOCUMENT_MAX_PER_PATIENT = 200;

/** The details sent with the file (in the query string: the body is the file itself). */
export const documentUploadSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES, { errorMap: () => ({ message: 'Choose what kind of document it is' }) }),
  title: text(120).min(1, 'Give the document a title'),
  takenOn: optionalDate,
  appointmentId: optionalId,
  note: optionalText(500),
  /** The file's name on the person's computer, for display. */
  name: z.preprocess((v) => (typeof v === 'string' ? v : ''), text(255)).optional(),
  /** Upload even if this patient already has exactly this file. */
  allowDuplicate: z.enum(['1']).optional(),
});
export type DocumentUploadInput = z.input<typeof documentUploadSchema>;

export const documentUpdateSchema = z
  .object({
    category: z.enum(DOCUMENT_CATEGORIES, { errorMap: () => ({ message: 'Choose what kind of document it is' }) }),
    title: text(120).min(1, 'Give the document a title'),
    takenOn: optionalDate,
    appointmentId: optionalId,
    note: optionalText(500),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface PatientDocumentDto {
  id: number;
  patientId: number;
  category: DocumentCategory;
  title: string;
  /** The day the picture or test was made. */
  takenOn: string | null;
  note: string | null;
  /** The file's original name, for display. */
  fileName: string;
  mime: string;
  sizeBytes: number;
  isImage: boolean;
  appointment: { id: number; date: string; time: string } | null;
  uploadedBy: { id: number; name: string } | null;
  createdAt: string | null;
  /** Whether the viewer may change or delete it (the uploader and admins). */
  canChange: boolean;
}
