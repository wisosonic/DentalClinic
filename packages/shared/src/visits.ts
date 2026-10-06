import { z } from 'zod';
import { idSchema, type AppointmentStatus } from './clinical';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(max).nullable().optional());

// ---------------------------------------------------------------------------
// Medications (prescribing catalog: no stock)
// ---------------------------------------------------------------------------

export const medicationInputSchema = z.object({
  name: text(255).min(1, 'Name is required'),
  /** Free text such as tablet, capsule, syrup, cream. */
  type: optionalText(50),
});
export const medicationUpdateSchema = medicationInputSchema.partial();

export interface MedicationDto {
  id: number;
  name: string;
  type: string | null;
}

// ---------------------------------------------------------------------------
// Procedures (categories)
// ---------------------------------------------------------------------------

const price = z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0, 'Cannot be negative').max(1_000_000));

const categoryFields = {
  name: text(255).min(1, 'Name is required'),
  priceMin: price,
  priceMax: price,
  /** Optional extras with a price each, e.g. "Large composite" at 20. Same length as `featurePrices`. */
  features: z.array(text(255).min(1)).max(50).default([]),
  featurePrices: z.array(z.coerce.number().min(0)).max(50).default([]),
};

const categoryRules = (v: { priceMin?: number; priceMax?: number; features?: string[]; featurePrices?: number[] }, ctx: z.RefinementCtx) => {
  if (v.priceMin !== undefined && v.priceMax !== undefined && v.priceMin > v.priceMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceMax'], message: 'Must be at least the minimum price' });
  }
  if (v.features && v.featurePrices && v.features.length !== v.featurePrices.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['featurePrices'], message: 'Each extra needs a price' });
  }
};

export const categoryInputSchema = z.object(categoryFields).superRefine(categoryRules);
export const categoryUpdateSchema = z.object(categoryFields).partial().superRefine(categoryRules);

// ---------------------------------------------------------------------------
// Visit reports
// ---------------------------------------------------------------------------

export const SURFACES = ['labial', 'buccal', 'lingual', 'mesial', 'distal', 'occlusal'] as const;
export type Surface = (typeof SURFACES)[number];

export const reportSummarySchema = z.object({ summary: text(10_000) });

const surfaceNotes = Object.fromEntries(SURFACES.map((s) => [s, optionalText(2000)])) as Record<Surface, ReturnType<typeof optionalText>>;

export const reportTeethSchema = z.object({
  teeth: z
    .array(z.object({ toothId: idSchema, ...surfaceNotes }))
    .max(32)
    .refine((t) => new Set(t.map((x) => x.toothId)).size === t.length, 'Duplicate tooth'),
});

export const MEDICATION_TIME_UNITS = ['hour', 'day', 'week', 'month'] as const;

/** "500 mg, 3 times per day". `frequency` is how many times, `timeUnit` is the period. */
export const prescriptionSchema = z.object({
  medicationId: idSchema,
  dose: text(100).min(1, 'Dose is required'),
  frequency: z.coerce.number().int().min(1, 'At least once').max(24, 'At most 24 times'),
  timeUnit: z.enum(MEDICATION_TIME_UNITS),
  notes: optionalText(1000),
});
export const reportMedicationsSchema = z.object({ medications: z.array(prescriptionSchema).max(30) });

export interface PrescriptionDto {
  id: number;
  medicationId: number;
  name: string;
  type: string | null;
  dose: string;
  frequency: number;
  timeUnit: string;
  notes: string | null;
}

export interface ToothNoteDto {
  toothId: number;
  index: string;
  name: string;
  date: string;
  labial: string | null;
  buccal: string | null;
  lingual: string | null;
  mesial: string | null;
  distal: string | null;
  occlusal: string | null;
}

export interface ReportDto {
  id: number;
  appointmentId: number;
  summary: string | null;
  medications: PrescriptionDto[];
  /** Clinic-only: never sent to a patient. */
  teeth?: ToothNoteDto[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReportResponse {
  report: ReportDto | null;
  /** The treating doctor and admins may write it. */
  canEdit: boolean;
}

export interface TimelineEntryDto {
  appointment: {
    id: number;
    date: string;
    time: string;
    endTime: string;
    durationMinutes: number;
    status: AppointmentStatus;
    doctor: { id: number; fname: string; lname: string };
    clinic: { id: number; name: string } | null;
    categories: string[];
  };
  hasReport: boolean;
  /** Present only when the viewer may read it. A patient gets the summary and prescriptions only. */
  report: ReportDto | null;
}

export interface ChartEntryDto {
  appointmentId: number;
  date: string;
  doctor: { id: number; fname: string; lname: string };
  labial: string | null;
  buccal: string | null;
  lingual: string | null;
  mesial: string | null;
  distal: string | null;
  occlusal: string | null;
}

export interface ChartToothDto {
  toothId: number;
  index: string;
  name: string;
  entries: ChartEntryDto[];
}
