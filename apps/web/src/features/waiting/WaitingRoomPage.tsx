import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import CampaignIcon from '@mui/icons-material/Campaign';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import { useTranslation } from 'react-i18next';
import type { WaitingAction, WaitingStatus, WaitingTicketDto } from '@aya/shared';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { useGetMeQuery } from '../auth/authApi';
import { CheckInDialog } from './CheckInDialog';
import { useGetWaitingListQuery, useWaitingActionMutation } from './waitingApi';
import { TimeText } from '../../lib/useTime';
import { useTimeFormat } from '../../lib/useTime';

export const STATUS_LABEL: Record<WaitingStatus, string> = { waiting: 'Waiting', called: 'Called', done: 'Done', left: 'Left' };
const STATUS_COLOR: Record<WaitingStatus, 'warning' | 'primary' | 'success' | 'default'> = { waiting: 'warning', called: 'primary', done: 'success', left: 'default' };

type SortKey = 'number' | 'patient' | 'doctor' | 'unit' | 'arrived' | 'status';
type Filter = 'active' | 'finished' | 'all';

/** Minutes from a server timestamp ("YYYY-MM-DD HH:MM:SS", UTC) to now. */
const minutesSince = (stamp: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(`${stamp.replace(' ', 'T')}Z`)) / 60_000));

/**
 * Today's waiting room. The desk gives an arriving patient a number and the doctor calls them by number: the
 * screen in the waiting room shows the number and the dental unit. A doctor sees the patients waiting for him; the
 * desk and admins see everyone's. Numbers start again at 1 every day. The list refreshes by itself.
 */
export function WaitingRoomPage() {
  const { t } = useTranslation();
  const fmtTime = useTimeFormat();
  const { isDoctor, unlinkedDoctor } = useRole();
  const permissions = useGetMeQuery().data?.permissions;
  const can = (p: string) => !permissions || permissions.includes(p);
  const { data, error, isLoading } = useGetWaitingListQuery(undefined, { pollingInterval: 5000, skipPollingIfUnfocused: true });
  const [act, actState] = useWaitingActionMutation();
  const [checkingIn, setCheckingIn] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');
  const sort = useSort<SortKey>('number');

  // minutes waited tick on their own
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);

  const tickets = useMemo(() => data?.data ?? [], [data]);
  const counts = useMemo(() => ({
    waiting: tickets.filter((x) => x.status === 'waiting').length,
    called: tickets.filter((x) => x.status === 'called').length,
    finished: tickets.filter((x) => x.status === 'done' || x.status === 'left').length,
  }), [tickets]);
  const shown = tickets.filter((x) => (filter === 'all' ? true : filter === 'active' ? x.status === 'waiting' || x.status === 'called' : x.status === 'done' || x.status === 'left'));
  const value: Record<SortKey, (x: WaitingTicketDto) => string | number | null> = {
    number: (x) => x.number, patient: (x) => fullName(x.patient), doctor: (x) => fullName(x.doctor), unit: (x) => x.unit?.name ?? null, arrived: (x) => x.arrivedAt, status: (x) => x.status,
  };
  const rows = sortRows(shown, value[sort.key], sort.order);
  const nextToCall = tickets.filter((x) => x.status === 'waiting').sort((a, b) => a.number - b.number)[0];
  const canUpdate = can('waiting:update');
  const run = (id: number, action: WaitingAction) => { actState.reset(); void act({ id, action }); };

  const buttons = (x: WaitingTicketDto) => {
    if (!canUpdate) return null;
    const name = x.label;
    return (
      <Stack direction="row" gap={0.5} justifyContent="flex-end" flexWrap="wrap">
        {x.status === 'waiting' && <Button size="small" variant="contained" startIcon={<CampaignIcon />} disabled={actState.isLoading} onClick={() => run(x.id, 'call')} aria-label={t('Call number {{n}}', { n: name })}>{t('Call')}</Button>}
        {x.status === 'called' && (
          <>
            <Button size="small" variant="outlined" startIcon={<CampaignIcon />} disabled={actState.isLoading} onClick={() => run(x.id, 'call')} aria-label={t('Call number {{n}} again', { n: name })}>{t('Call again')}</Button>
            <Button size="small" variant="contained" color="success" disabled={actState.isLoading} onClick={() => run(x.id, 'finish')} aria-label={t('Finish number {{n}}', { n: name })}>{t('Finish')}</Button>
            <Button size="small" disabled={actState.isLoading} onClick={() => run(x.id, 'requeue')} aria-label={t('Put number {{n}} back to waiting', { n: name })}>{t('Back to waiting')}</Button>
          </>
        )}
        {(x.status === 'waiting' || x.status === 'called') && <Button size="small" color="error" disabled={actState.isLoading} onClick={() => run(x.id, 'leave')} aria-label={t('Remove number {{n}}', { n: name })}>{x.status === 'called' ? t('Did not come') : t('Remove')}</Button>}
      </Stack>
    );
  };

  return (
    <>
      <PageHeader
        title={t('Waiting room')} subtitle={data ? t('Numbers of today, {{date}}. They start again at 1 tomorrow.', { date: data.date }) : undefined}
        actions={
          <>
            {isDoctor && nextToCall && canUpdate && (
              <Button variant="contained" startIcon={<CampaignIcon />} disabled={actState.isLoading} onClick={() => run(nextToCall.id, 'call')}>{t('Call the next patient (number {{n}})', { n: nextToCall.label })}</Button>
            )}
            {can('waiting:create') && <Button variant={isDoctor ? 'outlined' : 'contained'} startIcon={<PersonAddIcon />} onClick={() => setCheckingIn(true)}>{t('Give a number')}</Button>}
          </>
        }
      />
      {unlinkedDoctor && <Alert severity="warning" sx={{ mb: 2 }}>{t("Your login is not linked to a doctor profile yet, so you can't see patients or appointments. Ask an admin to link it.")}</Alert>}
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {actState.error != null && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{errorMessage(actState.error)}</Alert>}

      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', mb: 2 }}>
        <Chip color="warning" variant={counts.waiting ? 'filled' : 'outlined'} label={t('{{n}} waiting', { n: counts.waiting })} />
        <Chip color="primary" variant={counts.called ? 'filled' : 'outlined'} label={t('{{n}} being called', { n: counts.called })} />
        <Chip variant="outlined" label={t('{{n}} finished', { n: counts.finished })} />
        <Box sx={{ flexGrow: 1 }} />
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v: Filter | null) => v && setFilter(v)} aria-label={t('Show')}>
          <ToggleButton value="active">{t('Waiting and called')}</ToggleButton>
          <ToggleButton value="finished">{t('Finished')}</ToggleButton>
          <ToggleButton value="all">{t('All')}</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {isLoading ? <Skeleton variant="rounded" height={140} aria-label={t('Loading')} /> : rows.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">{tickets.length === 0 ? t('Nobody has been given a number today.') : t('Nothing to show here.')}</Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table aria-label={t('Waiting room')}>
            <TableHead>
              <TableRow>
                <SortCell field="number" sort={sort}>{t('Number')}</SortCell>
                <SortCell field="patient" sort={sort}>{t('Patient')}</SortCell>
                <SortCell field="doctor" sort={sort}>{t('Doctor')}</SortCell>
                <SortCell field="unit" sort={sort}>{t('Dental unit')}</SortCell>
                <SortCell field="arrived" sort={sort}>{t('Arrived')}</SortCell>
                <SortCell field="status" sort={sort}>{t('Status')}</SortCell>
                {canUpdate && <TableCell align="right">{t('Actions')}</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((x) => (
                <TableRow key={x.id} hover selected={x.status === 'called'}>
                  <TableCell><Typography component="span" variant="h6" fontWeight={800}>{x.label}</Typography></TableCell>
                  <TableCell>
                    {fullName(x.patient)}
                    {x.appointment && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        {t('Appointment at')} <TimeText value={x.appointment.time} />{x.appointment.procedures.length > 0 ? ` · ${x.appointment.procedures.join(', ')}` : ''}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{t('Dr. {{name}}', { name: fullName(x.doctor) })}</TableCell>
                  <TableCell>{x.unit?.name ?? '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <bdi dir="ltr">{fmtTime(new Date(`${x.arrivedAt.replace(' ', 'T')}Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }))}</bdi>
                    {(x.status === 'waiting' || x.status === 'called') && (
                      <Typography variant="caption" color="text.secondary" display="block">{t('{{n}} min', { n: minutesSince(x.arrivedAt, now) })}</Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" color={STATUS_COLOR[x.status]} label={t(STATUS_LABEL[x.status])} />
                    {x.callCount > 1 && <Typography variant="caption" color="text.secondary" display="block">{t('called {{n}} times', { n: x.callCount })}</Typography>}
                  </TableCell>
                  {canUpdate && <TableCell align="right">{buttons(x)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <CheckInDialog open={checkingIn} onClose={() => setCheckingIn(false)} />
    </>
  );
}
