import { z } from 'zod';
import { emailSchema } from './common';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function isValidDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** 'YYYY-MM-DD', a real calendar date. */
export const dateSchema = z.string().refine(isValidDate, 'Must be a valid date (YYYY-MM-DD)');
/** 'HH:MM', 24-hour. */
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a time (HH:MM, 24-hour)');
export const idSchema = z.number().int().positive();

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(max).nullable().optional());

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export const GENDERS = ['male', 'female', 'other'] as const;

export const patientInputSchema = z.object({
  fname: text(100).min(1, 'First name is required'),
  lname: text(100).min(1, 'Last name is required'),
  phone: text(30)
    .min(3, 'Phone is required')
    .regex(/^[+()\d\s.-]+$/, 'Phone may only contain digits, spaces and + ( ) - .'),
  dateOfBirth: z.preprocess((v) => (v === '' ? null : v), dateSchema.nullable().optional()),
  gender: z.preprocess((v) => (v === '' ? null : v), z.enum(GENDERS).nullable().optional()),
  email: z.preprocess((v) => (v === '' ? null : v), emailSchema.nullable().optional()),
  address: optionalText(255),
  description: optionalText(5000),
  doctorId: idSchema.nullable().optional(),
});
export type PatientInput = z.input<typeof patientInputSchema>;
export const patientUpdateSchema = patientInputSchema.partial();

export interface PatientDto {
  id: number;
  patientIdentifier: string;
  fname: string;
  lname: string;
  phone: string;
  dateOfBirth: string | null;
  gender: string | null;
  email: string | null;
  address: string | null;
  lastVisit: string | null;
  /** Internal notes. Never sent to patients. */
  description?: string | null;
  doctorId: number | null;
  /** Made from the name when the patient is registered; never changes. Null only for a record from before usernames. */
  username: string | null;
  hasAccount: boolean;
  /** Staff view only: no login yet, a login whose first password has not been changed yet, or a login in use. */
  loginState?: 'none' | 'waiting' | 'active';
  createdAt: string | null;
}

/** How much each of the patient page's sections holds, for the badges on its buttons. Null: this person has no such section. */
export interface PatientCountsDto {
  appointments: number;
  family: number;
  /** Null for staff, who cannot browse payments. */
  payments: number | null;
  offers: number | null;
  documents: number | null;
}

// ---------------------------------------------------------------------------
// Doctors, clinics and dental units
// ---------------------------------------------------------------------------

/** An owner doctor (Aya, Sara) owns a dental unit; an external doctor is a visiting specialist. */
export const DOCTOR_KINDS = ['owner', 'external'] as const;
export type DoctorKind = (typeof DOCTOR_KINDS)[number];

const percentage = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.number().min(0, 'Must be between 0 and 100').max(100, 'Must be between 0 and 100').nullable().optional(),
);

const doctorFields = {
  fname: text(100).min(1),
  lname: text(100).min(1),
  email: z.preprocess((v) => (v === '' ? null : v), emailSchema.nullable().optional()),
  speciality: optionalText(255),
  gender: z.preprocess((v) => (v === '' ? null : v), z.enum(GENDERS).nullable().optional()),
  phone: optionalText(30),
  address: optionalText(255),
  facebook: optionalText(255),
  instagram: optionalText(255),
  twitter: optionalText(255),
  /** Share of what an external doctor collects that he pays the owner of the dental unit he used. */
  commissionPercent: percentage,
};

export const COMMISSION_REQUIRED = 'The commission percentage is required for an external doctor';

/** Creating a doctor. An external doctor must have a commission percentage. */
export const doctorInputSchema = z
  .object({ ...doctorFields, kind: z.enum(DOCTOR_KINDS).default('external') })
  .superRefine((v, ctx) => {
    if (v.kind === 'external' && (v.commissionPercent === null || v.commissionPercent === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commissionPercent'], message: COMMISSION_REQUIRED });
    }
  });
/** `userId` links the doctor profile to a login (admin only); null removes the link. */
export const doctorUpdateSchema = z
  .object({
    ...doctorFields, kind: z.enum(DOCTOR_KINDS), userId: idSchema.nullable(),
    /** Admin only. */
    taxSpouse: z.boolean(), taxChildren: z.coerce.number().int('Enter a whole number').min(0, 'Cannot be negative').max(30, 'That is too many'),
  })
  .partial();

export interface DoctorDto {
  id: number;
  fname: string;
  lname: string;
  speciality: string | null;
  gender: string | null;
  kind: DoctorKind;
  /** Contact details are hidden from patients. */
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  twitter?: string | null;
  /** Financial: only admins and doctors see it. Null until set. */
  commissionPercent?: number | null;
  /** The login linked to this doctor (admin only). Null when none. */
  userId?: number | null;
  /** Family details for the income tax estimate (admin only): is the spouse eligible, and how many eligible children. */
  taxSpouse?: boolean;
  taxChildren?: number;
}

export const clinicInputSchema = z.object({
  name: text(255).min(1),
  phone: optionalText(30),
  address: optionalText(255),
  type: optionalText(50),
  latitude: optionalText(30),
  longitude: optionalText(30),
});
export const clinicUpdateSchema = clinicInputSchema.partial();

export interface ClinicDto {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  type: string | null;
  latitude: string | null;
  longitude: string | null;
  /** Where the clinic logo can be loaded from, or null when it has none. */
  logoUrl: string | null;
}

/** Assigning a doctor to a clinic. Doctors have no fixed working hours. */
export const clinicDoctorInputSchema = z.object({
  /** The doctor's share, as a percentage (100 = 100%). */
  drPart: z.coerce.number().min(0).max(100).default(100),
});

export interface ClinicDoctorDto {
  doctorId: number;
  clinicId: number;
  fname: string;
  lname: string;
  speciality: string | null;
  kind: DoctorKind;
  /** Admin only. */
  drPart?: number;
}

export const unitUpdateSchema = z.object({ name: text(100).min(1, 'Name is required') });

/** An admin adds a dental unit for an owner doctor who works at the clinic. */
export const unitCreateSchema = z.object({
  clinicId: idSchema,
  ownerDoctorId: idSchema,
  name: text(100).min(1, 'Name is required'),
});

export interface UnitDto {
  id: number;
  clinicId: number | null;
  name: string;
  ownerDoctorId: number;
  ownerName: string;
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
/** Statuses that occupy the doctor's and the unit's time. */
export const ACTIVE_STATUSES: AppointmentStatus[] = ['pending', 'confirmed', 'completed'];

export const DURATION_STEP = 15;
export const MIN_DURATION = 15;
export const MAX_DURATION = 480;
export const DEFAULT_DURATION = 30;

/** Minutes, in 15-minute steps. */
export const durationSchema = z
  .number()
  .int()
  .min(MIN_DURATION, `At least ${MIN_DURATION} minutes`)
  .max(MAX_DURATION, `At most ${MAX_DURATION} minutes`)
  .refine((v) => v % DURATION_STEP === 0, `Use steps of ${DURATION_STEP} minutes`);

/** Only doctors and staff (and admins) create appointments; patients cannot book online. */
export const appointmentInputSchema = z.object({
  patientId: idSchema,
  doctorId: idSchema,
  clinicId: idSchema,
  unitId: idSchema,
  date: dateSchema,
  time: timeSchema,
  /** Left out, the clinic's default length (Settings > Appointments) is used. */
  durationMinutes: durationSchema.optional(),
  intended: optionalText(2000),
  categoryIds: z.array(idSchema).max(20).optional(),
  toothIds: z.array(idSchema).max(32).optional(),
  /** Defaults to `confirmed`. */
  status: z.enum(['pending', 'confirmed']).optional(),
});
export type AppointmentInput = z.input<typeof appointmentInputSchema>;

export const appointmentUpdateSchema = z
  .object({
    doctorId: idSchema,
    clinicId: idSchema,
    unitId: idSchema,
    date: dateSchema,
    time: timeSchema,
    /** Only a doctor or an admin may change an existing appointment's length. */
    durationMinutes: durationSchema,
    intended: optionalText(2000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const appointmentCategoriesSchema = z.object({ categoryIds: z.array(idSchema).max(20) });
export const appointmentTeethSchema = z.object({
  teeth: z
    .array(z.object({ toothId: idSchema, description: optionalText(2000) }))
    .max(32)
    .refine((t) => new Set(t.map((x) => x.toothId)).size === t.length, 'Duplicate tooth'),
});

export interface AppointmentDto {
  id: number;
  date: string;
  time: string;
  durationMinutes: number;
  /** 'HH:MM'; '24:00' for an appointment ending at midnight. */
  endTime: string;
  status: AppointmentStatus;
  intended: string | null;
  patientId: number;
  doctorId: number;
  /** Null once the clinic was deleted: the appointment stays, for the payment and tax records, but is read-only. */
  clinicId: number | null;
  unitId: number | null;
  offerId: number | null;
  patient: { id: number; fname: string; lname: string; phone?: string };
  /**
   * False when the viewer is an external specialist treating another doctor's patient: he sees the
   * appointment and writes the report, but may not open the patient's profile or data.
   */
  patientVisible: boolean;
  doctor: { id: number; fname: string; lname: string };
  clinic: { id: number; name: string } | null;
  unit: { id: number; name: string; ownerDoctorId: number } | null;
  categories: { id: number; name: string }[];
  /** Whether a visit report has been written for this appointment (the report itself is read separately). */
  hasReport: boolean;
  teeth?: { toothId: number; index: string; name: string; description: string | null }[];
}

/** An existing appointment that occupies a doctor's or a unit's time on a day. */
export interface BusyPeriodDto {
  appointmentId: number;
  start: string;
  end: string;
  durationMinutes: number;
  status: AppointmentStatus;
  patientName: string;
}

export interface BusyDto {
  date: string;
  doctorBusy: BusyPeriodDto[];
  unitBusy: BusyPeriodDto[];
}

export interface ToothDto {
  id: number;
  index: string;
  name: string;
  type: string;
}

export interface CategoryDto {
  id: number;
  name: string;
  priceMin: number;
  priceMax: number;
  /** Optional priced extras, same length as `featurePrices`. */
  features: string[];
  featurePrices: number[];
}

export interface ClinicConfigDto {
  defaultDuration: number;
  durationStep: number;
  minDuration: number;
  maxDuration: number;
  cancelMinHours: number;
  timezone: string;
  /** Today's date at the clinic, 'YYYY-MM-DD'. */
  today: string;
  /** How dates and times are shown (Settings > Date and time). */
  weekStart: 'monday' | 'sunday' | 'saturday';
  timeFormat: '24h' | '12h';
  /** The shortest password the clinic accepts (Settings > Security). */
  passwordMinLength: number;
  /** Document limits and defaults (Settings > Uploads and Patient portal). */
  documents: { maxMb: number; maxPerPatient: number; visibleByDefault: boolean };
  /** The patient portal (Settings > Patient portal). */
  portal: { enabled: boolean; showPayments: boolean };
}

/** One line of the activity log (admin only). Only ids and field names are ever stored, never record content. */
export interface AuditEntryDto {
  id: number;
  userId: number | null;
  userName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  /** For a patient entry: the patient's name, so the log is readable. */
  entityLabel: string | null;
  diff: unknown;
  ip: string | null;
  createdAt: string;
}

/** An item in the Trash (admin only): deleted by staff or a doctor, not yet erased for good. */
export interface TrashItemDto {
  kind: 'patient' | 'appointment' | 'report' | 'offer' | 'payment' | 'commission' | 'expense' | 'lab_order' | 'document';
  id: number;
  /** The patient's name (also for an appointment or report, which belong to a patient). */
  label: string;
  /** Patient number, or the date and time of the appointment. */
  detail: string;
  /** What the admin must type to erase it for good. */
  confirmText: string;
  deletedAt: string;
  deletedBy: string | null;
  /** Set when it cannot be restored yet because its parent is also in the Trash. */
  blockedBy: 'patient' | 'appointment' | 'offer' | null;
}

/** What erasing an item for good would remove. */
export interface TrashImpactDto {
  counts: Record<'patients' | 'appointments' | 'reports' | 'reportToothNotes' | 'prescriptionLines' | 'offers' | 'payments' | 'expenses' | 'labOrders' | 'documents' | 'logins', number>;
}

/** What is left of deleted clinics: records that stay for the payment, commission and tax figures, read-only, for an admin to review or delete. */
export interface DeletedClinicDataDto {
  appointments: {
    id: number;
    date: string;
    time: string;
    status: AppointmentStatus;
    patient: { id: number; fname: string; lname: string };
    doctor: { id: number; fname: string; lname: string };
    unit: { id: number; name: string } | null;
    hasReport: boolean;
  }[];
  units: { id: number; name: string; ownerName: string; appointments: number }[];
}
