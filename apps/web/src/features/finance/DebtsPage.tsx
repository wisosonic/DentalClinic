import { useMemo, useState } from 'react';
import { Alert, Box, IconButton, InputAdornment, Link, Paper, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography } from '@mui/material';
import AssignmentIcon from '@mui/icons-material/Assignment';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import type { DebtRowDto } from '@aya/shared';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { formatMoney } from '../../lib/money';
import { useListDebtsQuery } from './financeApi';

type SortKey = 'patient' | 'doctor' | 'offers' | 'price' | 'paid' | 'owed' | 'since' | 'last';

const value = (d: DebtRowDto, key: SortKey): string | number | null =>
  ({ patient: fullName(d.patient), doctor: d.doctor ? fullName(d.doctor) : null, offers: d.offers, price: d.price, paid: d.paid, owed: d.owed, since: d.since, last: d.lastPayment })[key];

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Paper sx={{ p: 2, flex: '1 1 180px' }}>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography variant="h5" component="p" fontWeight={800} dir="ltr" sx={{ textAlign: 'start' }}>{children}</Typography>
    </Paper>
  );
}

/**
 * Everyone who still owes money: one row for each patient, from their accepted treatment offers with a balance, as things
 * stand today. An admin sees every patient; a doctor only the patients whose primary doctor he is.
 */
export function DebtsPage() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  const { data, error, isFetching } = useListDebtsQuery();
  const sort = useSort<SortKey>('owed', 'desc');
  const [search, setSearch] = useState('');

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const found = (data?.data ?? []).filter((d) => !needle || `${fullName(d.patient)} ${d.patient.phone}`.toLowerCase().includes(needle));
    return sortRows(found, (d) => value(d, sort.key), sort.order);
  }, [data, search, sort.key, sort.order]);

  return (
    <>
      <PageHeader
        title={t('Debts')}
        subtitle={isAdmin ? t('What patients still owe on their accepted treatment offers, as things stand today.') : t('What your patients still owe on their accepted treatment offers, as things stand today.')}
      />
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {!data ? (
        <Skeleton variant="rounded" height={160} aria-label={t('Loading')} />
      ) : (
        <>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
            <Stat label={t('Total owed')}>{formatMoney(data.totals.owed)}</Stat>
            <Stat label={t('Patients owing')}>{data.totals.patients}</Stat>
            <Stat label={t('Open treatment offers')}>{data.totals.offers}</Stat>
          </Box>
          <TextField
            value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search patients')} margin="none" size="small" sx={{ mb: 2, maxWidth: 320 }}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }, htmlInput: { 'aria-label': t('Search patients') } }}
          />
          {rows.length === 0 ? (
            <Paper sx={{ p: 4, textAlign: 'center' }}><Typography>{data.data.length === 0 ? t('Nobody owes anything.') : t('No patient matches.')}</Typography></Paper>
          ) : (
            <TableContainer component={Paper} sx={{ opacity: isFetching ? 0.6 : 1 }}>
              <Table size="small" aria-label={t('Debts')}>
                <TableHead>
                  <TableRow>
                    <SortCell field="patient" sort={sort}>{t('Patient')}</SortCell>
                    {isAdmin && <SortCell field="doctor" sort={sort}>{t('Doctor')}</SortCell>}
                    <SortCell field="offers" sort={sort} align="right">{t('Offers')}</SortCell>
                    <SortCell field="price" sort={sort} align="right">{t('Offered')}</SortCell>
                    <SortCell field="paid" sort={sort} align="right">{t('Paid')}</SortCell>
                    <SortCell field="owed" sort={sort} align="right">{t('Owed')}</SortCell>
                    <SortCell field="since" sort={sort}>{t('Owing since')}</SortCell>
                    <SortCell field="last" sort={sort}>{t('Last payment')}</SortCell>
                    <TableCell align="right" sx={{ width: 56 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t('Actions')}</span></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.patient.id} hover>
                      <TableCell>
                        <Link component={RouterLink} to={`/patients/${d.patient.id}`} underline="hover" color="text.primary" sx={{ fontWeight: 600 }}>{fullName(d.patient)}</Link>
                        {d.patient.phone && <Typography variant="caption" color="text.secondary" display="block"><bdi dir="ltr">{d.patient.phone}</bdi></Typography>}
                      </TableCell>
                      {isAdmin && <TableCell>{d.doctor ? fullName(d.doctor) : '—'}</TableCell>}
                      <TableCell align="right">{d.offers}</TableCell>
                      <TableCell align="right">{formatMoney(d.price)}</TableCell>
                      <TableCell align="right">{formatMoney(d.paid)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>{formatMoney(d.owed)}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{d.since ? formatDate(d.since) : '—'}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{d.lastPayment ? formatDate(d.lastPayment) : t('No payment yet')}</TableCell>
                      <TableCell align="right">
                        <Tooltip title={t('Open the treatment offers that are owed')}>
                          <IconButton component={RouterLink} to={`/treatment-offers?patientId=${d.patient.id}&debt=1`} size="small" aria-label={t('Open the treatment offers of {{name}} that are owed', { name: fullName(d.patient) })}>
                            <AssignmentIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
    </>
  );
}
