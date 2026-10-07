import { useMemo, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import arLocale from '@fullcalendar/core/locales/ar';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import timeGridPlugin from '@fullcalendar/timegrid';
import type { DatesSetArg, EventClickArg } from '@fullcalendar/core';
import { Alert, Box, LinearProgress, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '../../i18n';
import { errorMessage } from '../../lib/baseQuery';
import { STATUS_HEX, fullName, statusLabel } from '../../lib/format';
import { useListAppointmentsQuery } from '../clinical/clinicalApi';
import { useGetConfigQuery } from '../clinical/clinicalApi';

interface Props {
  doctorId?: number;
  unitId?: number;
  showCancelled: boolean;
  onSelect: (appointmentId: number) => void;
  onCreateAt: (date: string, time?: string) => void;
}

const toLocalIso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function addMinutes(date: string, time: string, minutes: number): string {
  const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
  const h = Math.min(Math.floor(total / 60), 23);
  const m = total >= 1440 ? 59 : total % 60;
  return `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

// FullCalendar's Arabic locale, but formatting numbers with Western digits like the rest of the app.
const arabicLocale = { ...arLocale, code: 'ar-LB-u-nu-latn', direction: 'rtl' as const };

/** Loaded lazily by AppointmentsPage so the calendar library stays out of the main bundle. */
export default function CalendarView({ doctorId, unitId, showCancelled, onSelect, onCreateAt }: Props) {
  const { t } = useTranslation();
  const { lang, dir } = useLanguage();
  const mobile = useMediaQuery(useTheme().breakpoints.down('sm'));
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const { data: config } = useGetConfigQuery();
  const hour12 = config?.timeFormat === '12h';
  const firstDay = { monday: 1, sunday: 0, saturday: 6 }[config?.weekStart ?? 'monday'];

  const { data, isFetching, error } = useListAppointmentsQuery(
    range
      ? {
          from: range.from, to: range.to, pageSize: 500, doctorId, unitId,
          status: showCancelled ? undefined : 'pending,confirmed,completed,no_show',
        }
      : undefined,
    { skip: !range },
  );

  const events = useMemo(
    () =>
      (data?.data ?? []).map((a) => ({
        id: String(a.id),
        title: `${fullName(a.patient)} · ${t('Dr {{name}}', { name: a.doctor.fname })}${a.unit ? ` · ${a.unit.name}` : ''}`,
        start: `${a.date}T${a.time}:00`,
        end: addMinutes(a.date, a.time, a.durationMinutes),
        backgroundColor: STATUS_HEX[a.status],
        borderColor: STATUS_HEX[a.status],
        classNames: a.status === 'cancelled' ? ['fc-event-cancelled'] : [],
        extendedProps: { status: statusLabel(a.status) },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, lang],
  );

  const onDatesSet = (arg: DatesSetArg) => {
    // The visible range is [start, end); the last day is the day before `end`.
    const last = new Date(arg.end.getTime() - 1);
    const from = toLocalIso(arg.start);
    const to = toLocalIso(last);
    // FullCalendar reports the range again when any option object changes identity; ignore repeats.
    setRange((current) => (current && current.from === from && current.to === to ? current : { from, to }));
  };

  return (
    <Box
      sx={{
        position: 'relative',
        '--fc-border-color': 'rgba(0,0,0,0.12)',
        '--fc-button-bg-color': '#0b7a75',
        '--fc-button-border-color': '#0b7a75',
        '--fc-button-hover-bg-color': '#095f5b',
        '--fc-button-hover-border-color': '#095f5b',
        '--fc-button-active-bg-color': '#074744',
        '--fc-button-active-border-color': '#074744',
        '.fc-event': { cursor: 'pointer' },
        '.fc-event-cancelled': { opacity: 0.55, textDecoration: 'line-through' },
        '.fc .fc-toolbar': { flexWrap: 'wrap', gap: 1 },
        '.fc .fc-toolbar-title': { fontSize: { xs: '1.1rem', sm: '1.5rem' } },
        '.fc .fc-button': { minHeight: 40 },
      }}
    >
      {isFetching && <LinearProgress sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5 }} />}
      {error && <Alert severity="error" sx={{ mb: 1 }}>{errorMessage(error)}</Alert>}
      <FullCalendar
        key={`${mobile ? 'mobile' : 'desktop'}-${lang}-${firstDay}-${hour12}`} // re-create when the breakpoint or language changes
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
        locales={[arabicLocale]}
        locale={lang === 'ar' ? arabicLocale.code : 'en'}
        direction={dir}
        initialView={mobile ? 'listWeek' : 'timeGridWeek'}
        headerToolbar={
          mobile
            ? { left: 'prev,next', center: 'title', right: 'listWeek,dayGridMonth' }
            : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' }
        }
        buttonText={{ today: t('Today'), month: t('Month'), week: t('Week'), day: t('Day'), list: t('List') }}
        firstDay={firstDay}
        nowIndicator
        allDaySlot={false}
        height="auto"
        slotMinTime="07:00:00"
        slotMaxTime="21:00:00"
        slotDuration="00:15:00"
        slotLabelFormat={{ hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 }}
        eventTimeFormat={{ hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12 }}
        events={events}
        datesSet={onDatesSet}
        eventClick={(arg: EventClickArg) => onSelect(Number(arg.event.id))}
        dateClick={(arg) => {
          // Month view gives a date only; the time grid gives date and time.
          const [date, time] = arg.dateStr.split('T');
          onCreateAt(date!, time?.slice(0, 5));
        }}
        noEventsContent={t('No appointments in this period')}
      />
    </Box>
  );
}
