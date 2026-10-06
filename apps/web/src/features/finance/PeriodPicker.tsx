import { useMemo, useState } from 'react';
import { Chip, Paper, Stack, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { addDays } from '../../lib/format';
import { useGetConfigQuery } from '../clinical/clinicalApi';

export interface Period {
  from: string;
  to: string;
}

const monthStart = (today: string) => `${today.slice(0, 8)}01`;

/**
 * A period of dates with shortcuts (this month, last month, this year, all time). Until the person
 * chooses, it is the current month. `ready` is false until the clinic's "today" is known.
 */
export function usePeriod(): { period: Period; setPeriod: (p: Period) => void; today: string; ready: boolean } {
  const { data: config } = useGetConfigQuery();
  const today = config?.today ?? '';
  const [custom, setCustom] = useState<Period | null>(null);
  const period = custom ?? { from: today ? monthStart(today) : '', to: today };
  return { period, setPeriod: setCustom, today, ready: !!today || !!custom };
}

export function PeriodPicker({ period, setPeriod, today }: { period: Period; setPeriod: (p: Period) => void; today: string }) {
  const { t } = useTranslation();
  const presets = useMemo(() => {
    if (!today) return [];
    const lastMonthEnd = addDays(monthStart(today), -1);
    return [
      { label: t('This month'), from: monthStart(today), to: today },
      { label: t('Last month'), from: monthStart(lastMonthEnd), to: lastMonthEnd },
      { label: t('This year'), from: `${today.slice(0, 4)}-01-01`, to: today },
      { label: t('All time'), from: '', to: '' },
    ];
  }, [today, t]);

  return (
    <Paper sx={{ p: 2, mb: 3 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} alignItems={{ md: 'center' }} flexWrap="wrap">
        <TextField type="date" label={t('From')} value={period.from} margin="none" sx={{ maxWidth: { md: 180 } }} slotProps={{ inputLabel: { shrink: true } }} onChange={(e) => setPeriod({ from: e.target.value, to: period.to })} />
        <TextField type="date" label={t('To')} value={period.to} margin="none" sx={{ maxWidth: { md: 180 } }} slotProps={{ inputLabel: { shrink: true } }} onChange={(e) => setPeriod({ from: period.from, to: e.target.value })} />
        <Stack direction="row" gap={1} flexWrap="wrap">
          {presets.map((p) => (
            <Chip key={p.label} label={p.label} clickable color={period.from === p.from && period.to === p.to ? 'primary' : 'default'} onClick={() => setPeriod({ from: p.from, to: p.to })} />
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
}
