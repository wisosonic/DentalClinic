import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, FormControlLabel, InputAdornment, LinearProgress, MenuItem, Paper, Skeleton, Switch, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { OFFER_STATUSES, PAYMENT_STATES } from '@aya/shared';
import { BackToPatientButton } from '../../components/BackToPatientButton';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { formatMoney } from '../../lib/money';
import { useDebounce } from '../../lib/useDebounce';
import { useGetPatientQuery } from '../clinical/clinicalApi';
import { OfferStatusChip, PaymentStateChip } from './OfferChips';
import { OFFER_STATUS_LABEL, PAYMENT_STATE_LABEL } from './labels';
import { OfferFormDialog } from './OfferFormDialog';
import { useListOffersQuery } from './offersApi';

type SortKey = 'patient' | 'title' | 'status' | 'paid' | 'progress' | 'price' | 'remaining' | 'created';

/**
 * Treatment offers: what will be done, what it costs and what was paid. A doctor sees those of his own patients, an
 * admin and the staff all of them (staff never see the cost); only an admin and the patient's doctor write.
 */
export function OffersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { role, unlinkedDoctor } = useRole();
  const canWrite = role === 'admin' || (role === 'doctor' && !unlinkedDoctor);
  const [params, setParams] = useSearchParams();
  const patientId = Number(params.get('patientId')) || undefined;
  const debt = params.get('debt') === '1' ? '1' : undefined;
  const { data: patient } = useGetPatientQuery(patientId!, { skip: !patientId });
  const sort = useSort<SortKey>('created', 'desc');
  const [status, setStatus] = useState('');
  const [paymentState, setPaymentState] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [creating, setCreating] = useState(false);

  const { data, isFetching, error } = useListOffersQuery({
    page: page + 1, pageSize, patientId, debt, status: status || undefined, paymentState: paymentState || undefined, q: q || undefined, sort: sort.key, order: sort.order,
  });
  useEffect(() => setPage(0), [status, paymentState, q, patientId, debt, sort.key, sort.order]);
  const rows = data?.data ?? [];
  const setDebt = (on: boolean) => { const next = new URLSearchParams(params); if (on) next.set('debt', '1'); else next.delete('debt'); setParams(next); };

  return (
    <>
      <PageHeader
        title={t('Treatment offers')}
        subtitle={data ? (data.meta.total === 1 ? t('1 offer') : t('{{n}} offers', { n: data.meta.total })) : undefined}
        actions={(
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {patientId && <BackToPatientButton patientId={patientId} />}
            {canWrite && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)}>{t('New treatment offer')}</Button>}
          </Box>
        )}
      />
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2, alignItems: 'center' }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search by title or patient')} margin="none" sx={{ maxWidth: 360 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t('Search treatment offers') } }}
        />
        <TextField select label={t('Status')} value={status} onChange={(e) => setStatus(e.target.value)} margin="none" sx={{ minWidth: 170 }}>
          <MenuItem value="">{t('All')}</MenuItem>
          {OFFER_STATUSES.map((s) => <MenuItem key={s} value={s}>{t(OFFER_STATUS_LABEL[s])}</MenuItem>)}
        </TextField>
        <TextField select label={t('Payment')} value={paymentState} onChange={(e) => setPaymentState(e.target.value)} margin="none" sx={{ minWidth: 170 }}>
          <MenuItem value="">{t('All')}</MenuItem>
          {PAYMENT_STATES.map((s) => <MenuItem key={s} value={s}>{t(PAYMENT_STATE_LABEL[s])}</MenuItem>)}
        </TextField>
        <FormControlLabel control={<Switch checked={!!debt} onChange={(e) => setDebt(e.target.checked)} />} label={t('Only with a balance owed')} />
      </Box>
      {patientId && (
        <Chip sx={{ mb: 2 }} color="primary" variant="outlined" label={t('Only {{name}}', { name: patient ? fullName(patient) : `#${patientId}` })} onDelete={() => { const next = new URLSearchParams(params); next.delete('patientId'); setParams(next); }} />
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={140} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('No treatment offers match.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="patient" sort={sort}>{t('Patient')}</SortCell>
                <SortCell field="title" sort={sort}>{t('Title')}</SortCell>
                <SortCell field="status" sort={sort}>{t('Status')}</SortCell>
                <SortCell field="paid" sort={sort}>{t('Payment')}</SortCell>
                <SortCell field="progress" sort={sort}>{t('Work')}</SortCell>
                <SortCell field="price" sort={sort} align="right">{t('Total')}</SortCell>
                <SortCell field="remaining" sort={sort} align="right">{t('Remaining')}</SortCell>
                <SortCell field="created" sort={sort}>{t('Created')}</SortCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((o) => (
                <TableRow
                  key={o.id} hover tabIndex={0} sx={{ cursor: 'pointer' }} onClick={() => navigate(`/treatment-offers/${o.id}`)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && navigate(`/treatment-offers/${o.id}`)}
                >
                  <TableCell>{fullName(o.patient)}</TableCell>
                  <TableCell>{o.title}</TableCell>
                  <TableCell><OfferStatusChip status={o.status} /></TableCell>
                  <TableCell><PaymentStateChip state={o.paymentState} /></TableCell>
                  <TableCell sx={{ minWidth: 140 }}>
                    <LinearProgress variant="determinate" value={o.progress.percent} aria-label={t('Progress of {{title}}', { title: o.title })} sx={{ height: 6, borderRadius: 3, mb: 0.5 }} />
                    <Typography variant="caption" color="text.secondary">{t('{{done}} of {{total}} done', { done: o.progress.done, total: o.progress.total })}</Typography>
                  </TableCell>
                  <TableCell align="right">{formatMoney(o.price)}</TableCell>
                  <TableCell align="right">{formatMoney(o.remaining)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{o.createdAt ? formatDate(o.createdAt.slice(0, 10)) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {data && data.meta.total > 0 && (
        <TablePagination
          component="div" count={data.meta.total} page={page} rowsPerPage={pageSize} rowsPerPageOptions={[10, 25, 50, 100]}
          labelRowsPerPage={t('Rows per page:')}
          labelDisplayedRows={({ from, to, count }) => t('{{from}}–{{to}} of {{count}}', { from, to, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        />
      )}

      <OfferFormDialog open={creating} onClose={() => setCreating(false)} patient={patient ?? null} onSaved={(offer) => navigate(`/treatment-offers/${offer.id}`)} />
    </>
  );
}
