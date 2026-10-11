import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(max).nullable().optional());
/** A blank choice means "not recorded". */
const optionalChoice = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.preprocess((v) => (v === '' ? null : v), z.enum(values, { errorMap: () => ({ message }) }).nullable().optional());

// ---------------------------------------------------------------------------
// Patient medical history (owner request 2026-10-10): what the dentist must know before treating someone.
// Clinic staff only (admin, doctors, staff): patients do not see it in the portal.
// ---------------------------------------------------------------------------

/** The four lists of a medical history. Item names are medical terms and stay English in both languages. */
export const MEDICAL_ITEM_KINDS = ['allergy', 'condition', 'medication', 'surgery'] as const;
export type MedicalItemKind = (typeof MEDICAL_ITEM_KINDS)[number];

export const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const PREGNANCY = ['yes', 'no'] as const;
export const SMOKING = ['never', 'former', 'current'] as const;
export const ALLERGY_SEVERITIES = ['mild', 'moderate', 'severe'] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];

/** More items than this for one patient is refused (a runaway list is a mistake). */
export const MAX_MEDICAL_ITEMS = 100;

/** What the dropdowns suggest for each list (the person may type anything else). Medical terms: English. */
export const MEDICAL_SUGGESTIONS: Record<MedicalItemKind, string[]> = {
  allergy: ['Penicillin', 'Amoxicillin', 'Local anesthetic', 'Latex', 'NSAIDs (ibuprofen, aspirin)', 'Codeine', 'Sulfa drugs', 'Iodine', 'Nickel', 'Acrylic'],
  condition: ['Diabetes', 'Hypertension', 'Heart disease', 'Bleeding disorder', 'Asthma', 'Epilepsy', 'Hepatitis', 'Kidney disease', 'Thyroid disorder', 'Osteoporosis', 'Cancer', 'HIV'],
  medication: ['Aspirin', 'Warfarin', 'Clopidogrel', 'Metformin', 'Insulin', 'Bisphosphonates', 'Antihypertensives', 'Corticosteroids'],
  surgery: ['Heart surgery', 'Joint replacement', 'Tonsillectomy', 'Appendectomy', 'Radiotherapy to the head or neck'],
};

/** The year, the month or the day: people often know only the year. */
const sinceSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Use a year (2019), a month (2019-04) or a date (2019-04-30)').refine((s) => Number(s.slice(0, 4)) >= 1900, 'Too far in the past').nullable().optional(),
);

export const medicalProfileSchema = z.object({
  bloodType: optionalChoice(BLOOD_TYPES, 'Choose a blood type'),
  pregnancy: optionalChoice(PREGNANCY, 'Choose yes or no'),
  smoking: optionalChoice(SMOKING, 'Choose a smoking status'),
  /** Anything else the dentist should know: free text, up to 2000 characters. */
  notes: optionalText(2000),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type MedicalProfileInput = z.input<typeof medicalProfileSchema>;

export const medicalItemSchema = z.object({
  kind: z.enum(MEDICAL_ITEM_KINDS),
  name: text(120).min(1, 'Write what it is'),
  /** Allergies only. */
  severity: optionalChoice(ALLERGY_SEVERITIES, 'Choose mild, moderate or severe'),
  note: optionalText(300),
  since: sinceSchema,
  /** A current allergy or condition or medication; off for one that is resolved or stopped. */
  active: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (v.severity && v.kind !== 'allergy') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Severity is for allergies only', path: ['severity'] });
});
export type MedicalItemInput = z.input<typeof medicalItemSchema>;

/** Changing an item: any of its details (its kind stays). */
export const medicalItemUpdateSchema = z.object({
  name: text(120).min(1, 'Write what it is'),
  severity: optionalChoice(ALLERGY_SEVERITIES, 'Choose mild, moderate or severe'),
  note: optionalText(300),
  since: sinceSchema,
  active: z.boolean(),
}).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface MedicalItemDto {
  id: number;
  kind: MedicalItemKind;
  name: string;
  severity: AllergySeverity | null;
  note: string | null;
  since: string | null;
  active: boolean;
  updatedBy: { id: number; name: string } | null;
  updatedAt: string | null;
}

export interface MedicalProfileDto {
  bloodType: (typeof BLOOD_TYPES)[number] | null;
  pregnancy: (typeof PREGNANCY)[number] | null;
  smoking: (typeof SMOKING)[number] | null;
  notes: string | null;
  /** When someone last went through the history with the patient. */
  reviewedAt: string | null;
  reviewedBy: { id: number; name: string } | null;
  updatedAt: string | null;
  updatedBy: { id: number; name: string } | null;
}

export interface MedicalHistoryDto {
  profile: MedicalProfileDto;
  items: MedicalItemDto[];
}

/** The short version for the warning on the patient page, the appointment and the report. */
export interface MedicalAlertsDto {
  /** Anything recorded at all: an empty history is itself worth saying. */
  recorded: boolean;
  allergies: { name: string; severity: AllergySeverity | null }[];
  conditions: string[];
  pregnant: boolean;
}
