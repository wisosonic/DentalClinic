import { z } from 'zod';
import { emailSchema } from './common';

/** Interface languages the app offers. */
export const LANGUAGES = ['en', 'ar'] as const;
export type SettingsLanguage = (typeof LANGUAGES)[number];

/** Light or dark, for the whole clinic. */
export const COLOR_MODES = ['light', 'dark'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

/** Text size of the whole interface, as the size of one rem in pixels. */
export const TEXT_SIZES = ['small', 'medium', 'large'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SIZE_PX: Record<TextSize, number> = { small: 13, medium: 14, large: 16 };

/** Is this a timezone name the platform knows (for example Asia/Beirut)? */
export const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const optionalText = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional());

export const generalSettingsSchema = z.object({
  /** The language people see until they pick their own with the language button. */
  language: z.enum(LANGUAGES, { errorMap: () => ({ message: 'Choose a language' }) }),
  /** Where "today" and every appointment time are worked out. */
  timezone: z.string().trim().refine(isTimeZone, 'Choose a valid timezone'),
  clinic: z.object({
    address: optionalText(255),
    phone: optionalText(30),
    email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), emailSchema.nullable().optional()),
  }),
  /** Left out, the switches stay as they are. */
  notifications: z.object({ reminders: z.boolean(), events: z.boolean() }).optional(),
});
export type GeneralSettingsInput = z.input<typeof generalSettingsSchema>;

export interface GeneralSettingsDto {
  language: SettingsLanguage;
  timezone: string;
  /** The clinic's contact details, printed on offers, receipts and visit summaries. Null while not set. */
  clinic: { address: string | null; phone: string | null; email: string | null };
  /** Appointment reminders, and the other events (bookings, offers, payments, lab orders). Both on until switched off. */
  notifications: { reminders: boolean; events: boolean };
}

export const appearanceSettingsSchema = z.object({
  mode: z.enum(COLOR_MODES, { errorMap: () => ({ message: 'Choose light or dark' }) }),
  textSize: z.enum(TEXT_SIZES, { errorMap: () => ({ message: 'Choose a text size' }) }),
});
export type AppearanceSettingsInput = z.input<typeof appearanceSettingsSchema>;
export type AppearanceSettingsDto = z.output<typeof appearanceSettingsSchema>;

/** What anyone may fetch before signing in: how the app should look and which language to start in. */
export interface PublicSettingsDto {
  language: SettingsLanguage;
  mode: ColorMode;
  textSize: TextSize;
}

// ---------------------------------------------------------------------------
// Notifications (in-app only)
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'appointment.reminder', 'appointment.booked', 'appointment.cancelled', 'offer.accepted', 'payment.received', 'lab.overdue',
  'appointment.no_show', 'report.ready',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationDto {
  id: number;
  type: string | null;
  title: string;
  content: string;
  /** Where clicking it goes, inside the app. */
  link: string | null;
  status: 'unread' | 'read';
  createdAt: string | null;
  readAt: string | null;
}

/** On and off switches for the two kinds of notification (Settings > General). */
export const notificationSwitchesSchema = z.object({ reminders: z.boolean(), events: z.boolean() });
export type NotificationSwitches = z.infer<typeof notificationSwitchesSchema>;
