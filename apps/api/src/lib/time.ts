import type { Env } from '../config/env';

export const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes since midnight as 'HH:MM'. 1440 is shown as '24:00' (an appointment ending at midnight). */
export const fromMinutes = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface ClinicNow {
  /** 'YYYY-MM-DD' at the clinic. */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
}

/** The current date and time of day in the clinic's timezone, not the server's. */
export function clinicNow(env: Pick<Env, 'CLINIC_TIMEZONE'>, now: Date): ClinicNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.CLINIC_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Hours between "now" (at the clinic) and a local date/time; negative if in the past. */
export function hoursUntil(now: ClinicNow, date: string, time: string): number {
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${now.date}T00:00:00Z`)) / 86_400_000;
  return (days * 1440 + toMinutes(time) - now.minutes) / 60;
}
