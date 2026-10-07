import { useGetConfigQuery } from '../features/clinical/clinicalApi';

/** '14:30' as "2:30 PM", or untouched; "24:00" (the end of the day) stays as it is in 24-hour time and is "12:00 AM" in 12-hour time. */
export function formatClockTime(hhmm: string, format: '24h' | '12h'): string {
  if (format === '24h' || !/^\d{1,2}:\d{2}/.test(hhmm)) return hhmm;
  const h = Number(hhmm.slice(0, hhmm.indexOf(':')));
  const m = hhmm.slice(hhmm.indexOf(':') + 1, hhmm.indexOf(':') + 3);
  const hour = h % 24;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** How the clinic shows times (Settings > Date and time): a function that writes 'HH:MM' that way. */
export function useTimeFormat(): (hhmm: string) => string {
  const format = useGetConfigQuery().data?.timeFormat ?? '24h';
  return (hhmm) => formatClockTime(hhmm, format);
}

/** A time, or a time range, written the clinic's way, kept left-to-right inside right-to-left text. */
export function TimeText({ value, end }: { value: string; end?: string }) {
  const fmt = useTimeFormat();
  return <bdi dir="ltr">{fmt(value)}{end ? `–${fmt(end)}` : ''}</bdi>;
}
