import type { AppointmentStatus } from '@aya/shared';
import { dateLocale, translate } from '../i18n';

/** '2026-10-05' -> 'Mon, 5 Oct 2026'. Parsed as UTC so the day never shifts with the browser's timezone. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '';
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

export const formatDateTime = (dt: string | null | undefined) => (dt ? `${formatDate(dt)}, ${dt.slice(11, 16)}` : '');

/** A file size in plain words: 800 B, 1.4 MB. */
export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

export const fullName = (p: { fname: string; lname: string }) => `${p.fname} ${p.lname}`.trim();

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

/** The status in the current language. (STATUS_LABEL holds the English keys.) */
export const statusLabel = (status: AppointmentStatus): string => translate(STATUS_LABEL[status] ?? status);

export const STATUS_COLOR: Record<AppointmentStatus, 'warning' | 'primary' | 'success' | 'default' | 'error'> = {
  pending: 'warning',
  confirmed: 'primary',
  completed: 'success',
  cancelled: 'default',
  no_show: 'error',
};

/** Hex colours for the calendar, which can't use MUI's palette names. */
export const STATUS_HEX: Record<AppointmentStatus, string> = {
  pending: '#ed6c02',
  confirmed: '#0b7a75',
  completed: '#2e7d32',
  cancelled: '#9e9e9e',
  no_show: '#d32f2f',
};

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
