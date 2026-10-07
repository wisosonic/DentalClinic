import { z } from 'zod';
import { DURATION_STEP, MAX_DURATION, MIN_DURATION } from './clinical';

// ---------------------------------------------------------------------------
// Operating settings (owner decision 2026-10-07): the numbers and switches an admin may change under Settings,
// which used to be fixed in the code or in the server's environment. Each group has its own page, and the values
// that came from the environment start there (the environment is now only the starting value).
// ---------------------------------------------------------------------------

const whole = (min: number, max: number, message?: string) =>
  z.coerce.number({ invalid_type_error: message ?? 'Enter a number' }).int(message ?? 'Enter a whole number').min(min, `At least ${min}`).max(max, `At most ${max}`);

/** Appointments: how long a visit is by default, how late a patient may cancel online, and when reminders go out. */
export const appointmentsSettingsSchema = z.object({
  /** Minutes, in steps of 15: what a new appointment is given when nothing else is chosen. */
  defaultDuration: whole(MIN_DURATION, MAX_DURATION).refine((v) => v % DURATION_STEP === 0, `Use steps of ${DURATION_STEP} minutes`),
  /** A patient may cancel online only at least this many hours before the appointment. */
  cancelMinHours: whole(0, 720),
  /** The doctor and the staff are reminded this many minutes before a confirmed appointment. */
  staffReminderMinutes: whole(15, 1440),
  /** The patient is reminded this many hours before it. */
  patientReminderHours: whole(1, 168),
});
export type AppointmentsSettings = z.output<typeof appointmentsSettingsSchema>;

/** Security: locking after failed sign-ins, how short a password may be, how long "keep me signed in" lasts. */
export const securitySettingsSchema = z.object({
  maxFailedLogins: whole(3, 20),
  lockoutMinutes: whole(1, 1440),
  passwordMinLength: whole(8, 32),
  /** Days a sign-in is kept when the person ticked "keep me signed in". */
  rememberDays: whole(1, 90),
});
export type SecuritySettings = z.output<typeof securitySettingsSchema>;

/** The patient portal: on or off, whether patients see money, and whether new documents are shared with them. */
export const portalSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Payments, receipts and balances. */
  showPayments: z.boolean(),
  /** What the "visible to the patient" box starts as when a document is added. */
  documentsVisibleByDefault: z.boolean(),
});
export type PortalSettings = z.output<typeof portalSettingsSchema>;

/** The waiting room: the screen's chime, a letter for the dental unit, and how long a finished call stays up. */
export const waitingSettingsSchema = z.object({
  /** Offer the chime on the waiting-room screen. */
  chime: z.boolean(),
  /** Show the dental unit's letter before the number (A12): only the way it is written; the numbers stay the day's order. */
  unitLetters: z.boolean(),
  /** Seconds a call stays on the screen after the doctor finishes with the patient; 0 takes it off at once. */
  finishedCallSeconds: whole(0, 600),
});
export type WaitingSettings = z.output<typeof waitingSettingsSchema>;

/** Uploads: the biggest document and how many one patient may have. */
export const uploadsSettingsSchema = z.object({
  maxDocumentMb: whole(1, 100),
  maxDocumentsPerPatient: whole(1, 1000),
});
export type UploadsSettings = z.output<typeof uploadsSettingsSchema>;

/**
 * Trash and activity log: how long things are kept. 0 means "never remove by itself" (the starting value, since
 * erasing is permanent): the Trash is then emptied by an admin only, and the log kept until cleared by hand.
 */
export const TRASH_MIN_DAYS = 7;
export const AUDIT_MIN_DAYS = 30;
export const retentionSettingsSchema = z.object({
  /** Days a deleted item stays in the Trash before it is erased for good, or 0 for never. */
  trashDays: whole(0, 3650).refine((v) => v === 0 || v >= TRASH_MIN_DAYS, `Use 0 for never, or at least ${TRASH_MIN_DAYS} days`),
  /** Days an activity-log entry is kept before it is removed, or 0 for never. */
  auditDays: whole(0, 3650).refine((v) => v === 0 || v >= AUDIT_MIN_DAYS, `Use 0 for never, or at least ${AUDIT_MIN_DAYS} days`),
});
export type RetentionSettings = z.output<typeof retentionSettingsSchema>;

/** How dates and times are shown. */
export const WEEK_STARTS = ['monday', 'sunday', 'saturday'] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];
export const TIME_FORMATS = ['24h', '12h'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];
export const displaySettingsSchema = z.object({
  weekStart: z.enum(WEEK_STARTS, { errorMap: () => ({ message: 'Choose the first day of the week' }) }),
  timeFormat: z.enum(TIME_FORMATS, { errorMap: () => ({ message: 'Choose how times are shown' }) }),
});
export type DisplaySettings = z.output<typeof displaySettingsSchema>;

/** The groups, by the name used in the address `/settings/<group>`. */
export const OPERATING_SCHEMAS = {
  appointments: appointmentsSettingsSchema,
  security: securitySettingsSchema,
  portal: portalSettingsSchema,
  waiting: waitingSettingsSchema,
  uploads: uploadsSettingsSchema,
  display: displaySettingsSchema,
  retention: retentionSettingsSchema,
} as const;
export type OperatingGroup = keyof typeof OPERATING_SCHEMAS;
export const OPERATING_GROUPS = Object.keys(OPERATING_SCHEMAS) as OperatingGroup[];

export interface OperatingSettings {
  appointments: AppointmentsSettings;
  security: SecuritySettings;
  portal: PortalSettings;
  waiting: WaitingSettings;
  uploads: UploadsSettings;
  display: DisplaySettings;
  retention: RetentionSettings;
}
