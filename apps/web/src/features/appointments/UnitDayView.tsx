import { useMemo, useState } from 'react';
import { Alert, Box, Button, IconButton, LinearProgress, Stack, TextField, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTranslation } from 'react-i18next';
import type { AppointmentDto } from '@aya/shared';
import { useLanguage } from '../../i18n';
import { errorMessage } from '../../lib/baseQuery';
import { STATUS_HEX, addDays, formatDate, fullName, statusLabel } from '../../lib/format';
import { useGetConfigQuery, useGetUnitsQuery, useListAppointmentsQuery } from '../clinical/clinicalApi';
import { useTimeFormat } from '../../lib/useTime';

interface Props {
  showCancelled: boolean;
  onSelect: (appointmentId: number) => void;
  onCreateAt: (date: string, time: string, unitId: number) => void;
}

const PX_PER_MIN = 1.1; // 66 px per hour
const SNAP = 15;
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * One column per dental unit for a single day, so the whole clinic's chairs can be seen at once.
 * (FullCalendar's resource views are a paid add-on, so this is a small purpose-built view.)
 * The time runs top to bottom, so only the order of the columns follows the language direction.
 */
export default function UnitDayView({ showCancelled, onSelect, onCreateAt }: Props) {
  const { t } = useTranslation();
  const fmtTime = useTimeFormat();
  const { dir } = useLanguage();
  const { data: config } = useGetConfigQuery();
  const { data: units = [], isLoading: loadingUnits } = useGetUnitsQuery();
  const [chosen, setChosen] = useState<string | null>(null);
  const date = chosen ?? config?.today ?? '';

  const { data, isFetching, error } = useListAppointmentsQuery(
    date
      ? { from: date, to: date, pageSize: 500, status: showCancelled ? undefined : 'pending,confirmed,completed,no_show' }
      : undefined,
    { skip: !date },
  );
  const appointments = useMemo(() => data?.data ?? [], [data]);

  // The visible hours default to 08:00 to 20:00 and stretch to include anything outside them.
  const { start, end } = useMemo(() => {
    let lo = 8 * 60;
    let hi = 20 * 60;
    for (const a of appointments) {
      lo = Math.min(lo, Math.floor(toMinutes(a.time) / 60) * 60);
      hi = Math.max(hi, Math.ceil(toMinutes(a.endTime === '24:00' ? '23:59' : a.endTime) / 60) * 60);
    }
    return { start: lo, end: hi };
  }, [appointments]);

  const hours = Array.from({ length: (end - start) / 60 }, (_, i) => start + i * 60);
  const height = (end - start) * PX_PER_MIN;
  const byUnit = (unitId: number): AppointmentDto[] => appointments.filter((a) => a.unitId === unitId);
  const unplaced = appointments.filter((a) => !a.unitId || !units.some((u) => u.id === a.unitId));

  const clickColumn = (unitId: number) => (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = start + Math.round((e.clientY - rect.top) / PX_PER_MIN / SNAP) * SNAP;
    onCreateAt(date, hhmm(Math.max(start, Math.min(minutes, end - SNAP))), unitId);
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" sx={{ mb: 2 }}>
        {/* "Previous" points to the start of the line, which is on the right in Arabic. */}
        <IconButton aria-label={t('Previous day')} onClick={() => setChosen(addDays(date, -1))} disabled={!date}>
          {dir === 'rtl' ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </IconButton>
        <TextField
          type="date" size="small" label={t('Day')} margin="none" value={date}
          onChange={(e) => e.target.value && setChosen(e.target.value)} slotProps={{ inputLabel: { shrink: true } }}
        />
        <IconButton aria-label={t('Next day')} onClick={() => setChosen(addDays(date, 1))} disabled={!date}>
          {dir === 'rtl' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        </IconButton>
        <Button onClick={() => setChosen(null)} disabled={!config || date === config.today}>{t('Today')}</Button>
        <Typography color="text.secondary" sx={{ marginInlineStart: 1 }}>{formatDate(date)}</Typography>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 1 }}>{errorMessage(error)}</Alert>}
      {(isFetching || loadingUnits) && <LinearProgress sx={{ mb: 1 }} />}
      {!loadingUnits && units.length === 0 && (
        <Alert severity="info">{t('There are no dental units yet. An admin can add them under Clinics.')}</Alert>
      )}
      {unplaced.length > 0 && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {unplaced.length === 1
            ? t("1 appointment has no dental unit and can't be shown here. Open it from the list to assign one.")
            : t("{{n}} appointments have no dental unit and can't be shown here. Open them from the list to assign one.", { n: unplaced.length })}
        </Alert>
      )}

      {units.length > 0 && (
        <Box sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', minWidth: 56 + units.length * 190 }}>
            <Box sx={{ width: 56, flexShrink: 0, borderInlineEnd: 1, borderColor: 'divider' }}>
              <Box sx={{ height: 52, borderBottom: 1, borderColor: 'divider' }} />
              <Box sx={{ position: 'relative', height }}>
                {hours.map((h) => (
                  <Typography key={h} variant="caption" color="text.secondary" dir="ltr" sx={{ position: 'absolute', top: (h - start) * PX_PER_MIN - 8, insetInlineEnd: 6 }}>
                    {fmtTime(hhmm(h))}
                  </Typography>
                ))}
              </Box>
            </Box>

            {units.map((u) => (
              <Box key={u.id} role="group" aria-label={u.name} sx={{ flex: 1, minWidth: 190, borderInlineEnd: 1, borderColor: 'divider' }}>
                <Box sx={{ height: 52, px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
                  <Typography variant="subtitle2" noWrap>{u.name}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap display="block">{t('Dr {{name}}', { name: u.ownerName })}</Typography>
                </Box>
                <Box
                  onClick={clickColumn(u.id)}
                  sx={{
                    position: 'relative', height, cursor: 'pointer',
                    backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0.08) 1px, transparent 1px)',
                    backgroundSize: `100% ${60 * PX_PER_MIN}px`,
                  }}
                >
                  {byUnit(u.id).map((a) => {
                    const top = (toMinutes(a.time) - start) * PX_PER_MIN;
                    const blockHeight = Math.max(a.durationMinutes * PX_PER_MIN - 2, 18);
                    const cancelled = a.status === 'cancelled';
                    return (
                      <Box
                        key={a.id}
                        component="button"
                        type="button"
                        aria-label={t('{{start}} to {{end}}, {{name}}, {{status}}', { start: fmtTime(a.time), end: fmtTime(a.endTime), name: fullName(a.patient), status: statusLabel(a.status) })}
                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onSelect(a.id); }}
                        sx={{
                          position: 'absolute', top, insetInlineStart: cancelled ? '40%' : 4, insetInlineEnd: 4, height: blockHeight, overflow: 'hidden',
                          textAlign: 'start', px: 0.75, py: 0.25, border: 0, borderRadius: 1, cursor: 'pointer', color: '#fff',
                          bgcolor: STATUS_HEX[a.status], opacity: cancelled ? 0.5 : 1, font: 'inherit', fontSize: 12, lineHeight: 1.25,
                          textDecoration: cancelled ? 'line-through' : 'none', '&:hover, &:focus-visible': { filter: 'brightness(0.92)', outline: '2px solid #000' },
                        }}
                      >
                        <strong dir="ltr">{fmtTime(a.time)}–{fmtTime(a.endTime)}</strong> {fullName(a.patient)}
                        {blockHeight > 40 && <><br />{t('Dr {{name}}', { name: `${a.doctor.fname} ${a.doctor.lname}` })}</>}
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
        {t('Click an empty spot to book that time on that unit.')}
      </Typography>
    </Box>
  );
}
