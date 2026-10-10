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

export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024; // the ceiling: the clinic chooses its own limit up to this (Settings > Uploads)
/** What a person may choose to upload (the server checks the file's own bytes, never this). */
export const DOCUMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
/** More than this many documents for one patient is refused (runaway disk use). */
export const DOCUMENT_MAX_PER_PATIENT = 1000; // the ceiling: the clinic chooses its own limit up to this

/** The details sent with the file (in the query string: the body is the file itself). */
export const documentUploadSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES, { errorMap: () => ({ message: 'Choose what kind of document it is' }) }),
  title: text(120).min(1, 'Give the document a title'),
  takenOn: optionalDate,
  appointmentId: optionalId,
  note: optionalText(500),
  /** Mark it as one the patient may see in the portal (phase 8); off by default. */
  patientVisible: z.enum(['1', '0']).optional(),
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
    patientVisible: z.boolean(),
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
  /** Marked as one the patient may see in the portal (not shown to patients yet: phase 8). */
  patientVisible: boolean;
  appointment: { id: number; date: string; time: string } | null;
  uploadedBy: { id: number; name: string } | null;
  createdAt: string | null;
  /** Whether the viewer may change or delete it (the uploader and admins). */
  canChange: boolean;
  /** Labels for a picture (empty for a PDF), in the order they were added. */
  tags: string[];
  commentCount: number;
  /** Marks drawn on a picture. */
  annotationCount: number;
}

// ---------------------------------------------------------------------------
// Comments, tags and annotations on a document (owner request 2026-10-09). All clinic-internal: patients never see them.
// ---------------------------------------------------------------------------

export const COMMENT_MAX_LENGTH = 1000;
export const TAG_MAX_LENGTH = 30;
export const MAX_TAGS_PER_DOCUMENT = 10;
export const MAX_ANNOTATIONS_PER_DOCUMENT = 50;
export const ANNOTATION_LABEL_MAX_LENGTH = 200;
export const MIN_BOX_SIZE = 0.01; // a box is at least 1% of the picture each way

export const documentCommentSchema = z.object({ body: text(COMMENT_MAX_LENGTH).min(1, 'Write a comment') });

const tagSchema = text(TAG_MAX_LENGTH)
  .min(1, 'A tag cannot be empty')
  .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32), 'A tag cannot contain control characters');
/** The whole set of tags a picture should have (it replaces the old set). Case does not make a second tag. */
export const documentTagsSchema = z.object({
  tags: z.array(tagSchema).max(MAX_TAGS_PER_DOCUMENT, `At most ${MAX_TAGS_PER_DOCUMENT} tags`),
});
/** The key two tags are compared by. */
export const tagKey = (tag: string) => tag.trim().replace(/\s+/g, ' ').toLowerCase();

export const ANNOTATION_KINDS = ['pin', 'box'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];
const unit = z.coerce.number({ invalid_type_error: 'Enter a number' }).min(0, 'Outside the picture').max(1, 'Outside the picture');
const label = text(ANNOTATION_LABEL_MAX_LENGTH).min(1, 'Write what this mark is');

/** Where a mark sits, as fractions of the picture (0 to 1 from the top-left), so it stays right at any size. A pin has a point; a box also a width and height. */
export function annotationGeometryProblem(g: { kind: AnnotationKind; x: number; y: number; w?: number | null; h?: number | null }): string | null {
  if (g.kind === 'pin') return g.w != null || g.h != null ? 'A pin has no width or height' : null;
  if (g.w == null || g.h == null) return 'A box needs a width and a height';
  if (g.w < MIN_BOX_SIZE || g.h < MIN_BOX_SIZE) return 'The box is too small';
  if (g.x + g.w > 1.0001 || g.y + g.h > 1.0001) return 'The box goes outside the picture';
  return null;
}

export const documentAnnotationSchema = z
  .object({ kind: z.enum(ANNOTATION_KINDS), x: unit, y: unit, w: unit.nullish(), h: unit.nullish(), label })
  .superRefine((v, ctx) => {
    const problem = annotationGeometryProblem(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: [v.kind === 'pin' ? 'kind' : 'w'] });
  });
export type DocumentAnnotationInput = z.input<typeof documentAnnotationSchema>;

/** Changing a mark: its words, or where it sits (the kind stays). Checked against the stored mark by the server. */
export const documentAnnotationUpdateSchema = z
  .object({ label, x: unit, y: unit, w: unit, h: unit })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface DocumentCommentDto {
  id: number;
  body: string;
  author: { id: number; name: string } | null;
  createdAt: string | null;
  /** Edited after it was written. */
  edited: boolean;
  /** The author can edit it; the author and admins can delete it. */
  canEdit: boolean;
  canDelete: boolean;
}

export interface DocumentAnnotationDto {
  id: number;
  kind: AnnotationKind;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  label: string;
  author: { id: number; name: string } | null;
  createdAt: string | null;
  /** The author and admins can change or delete it. */
  canChange: boolean;
}
