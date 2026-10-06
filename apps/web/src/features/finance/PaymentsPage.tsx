import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, IconButton, InputAdornment, MenuItem, Paper, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination,
  TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import AssignmentIcon from '@mui/icons-material/Assignment';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { PAYMENT_METHODS, type PaymentDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { BackToPatientButton } from '../../components/BackToPatientButton';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { METHOD_LABEL, formatMoney } from '../../lib/money';
import { useDebounce } from '../../lib/useDebounce';
import { useGetPatientQuery } from '../clinical/clinicalApi';
import { useDeletePaymentMutation, useListPaymentsQuery, useMyPaymentsQuery } from './financeApi';
import { PaymentFormDialog } from './PaymentFormDialog';

type SortKey = 'date' | 'patient' | 'amount' | 'method' | 'offer';

/**
 * Payments. Staff record them and can look back only at what they entered themselves. Doctors see
 * the payments of their own patients and admins all of them.
 */
export function PaymentsPage() {
  const { t } = useTranslation();
  const { role } = useRole();
  const staff = role === 'staff';
  const sort = useSort<SortKey>('date', 'desc');
  const [method, setMethod] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim());
  const [params, setParams] = useSearchParams();
  const patientId = Number(params.get('patientId')) || undefined;
  const { data: patient } = useGetPatientQuery(patientId!, { skip: !patientId || staff });
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [form, setForm] = useState<'new' | PaymentDto | null>(null);
  const [deleting, setDeleting] = useState<PaymentDto | null>(null);
  const [remove, removeState] = useDeletePaymentMutation();

  const list = useListPaymentsQuery(
    { page: page + 1, pageSize, patientId, method: method || undefined, q: q || undefined, from: from || undefined, to: to || undefined, sort: sort.key, order: sort.order },
    { skip: staff },
  );
  const mine = useMyPaymentsQuery(undefined, { skip: !staff });
  useEffect(() => setPage(0), [method, q, from, to, patientId, sort.key, sort.order]);

  const rows = staff ? (mine.data ?? []) : (list.data?.data ?? []);
  const loading = staff ? mine.isLoading : !list.data && list.isFetching;
  const error = staff ? mine.error : list.error;
  const total = list.data?.meta.total ?? 0;

  return (
    <>
      <PageHeader
        title={t('Payments')}
        subtitle={staff ? t('Record a payment. Below are the payments you entered in the last two weeks.') : total ? (total === 1 ? t('1 payment') : t('{{n}} payments', { n: total })) : undefined}
        actions={(
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {patientId && !staff && <BackToPatientButton patientId={patientId} />}
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setForm('new')}>{t('Record payment')}</Button>
          </Box>
        )}
      />

      {!staff && (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
          <TextField
            value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search by patient or treatment offer')} margin="none" sx={{ maxWidth: 320 }}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t('Search payments') } }}
          />
          <TextField select label={t('Paid by')} value={method} onChange={(e) => setMethod(e.target.value)} margin="none" sx={{ maxWidth: 200 }}>
            <MenuItem value="">{t('All')}</MenuItem>
            {PAYMENT_METHODS.map((m) => <MenuItem key={m} value={m}>{t(METHOD_LABEL[m])}</MenuItem>)}
          </TextField>
          <TextField type="date" label={t('From')} value={from} onChange={(e) => setFrom(e.target.value)} margin="none" slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} />
          <TextField type="date" label={t('To')} value={to} onChange={(e) => setTo(e.target.value)} margin="none" slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} />
        </Box>
      )}
      {patientId && !staff && (
        <Chip sx={{ mb: 2 }} color="primary" variant="outlined" label={t('Only {{name}}', { name: patient ? fullName(patient) : `#${patientId}` })} onDelete={() => { const next = new URLSearchParams(params); next.delete('patientId'); setParams(next); }} />
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {removeState.error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(removeState.error)}</Alert>}

      {loading ? (
        <Skeleton variant="rounded" height={120} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{staff ? t('You have not entered any payment recently.') : t('No payments match.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: !staff && list.isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {staff ? (
                  <>
                    <TableCell>{t('Date')}</TableCell><TableCell>{t('Patient')}</TableCell><TableCell>{t('Treatment offer')}</TableCell>
                    <TableCell align="right">{t('Amount')}</TableCell><TableCell>{t('Paid by')}</TableCell>
                  </>
                ) : (
                  <>
                    <SortCell field="date" sort={sort}>{t('Date')}</SortCell><SortCell field="patient" sort={sort}>{t('Patient')}</SortCell>
                    <SortCell field="offer" sort={sort}>{t('Treatment offer')}</SortCell><SortCell field="amount" sort={sort} align="right">{t('Amount')}</SortCell>
                    <SortCell field="method" sort={sort}>{t('Paid by')}</SortCell>
                  </>
                )}
                <TableCell align="right">{t('Left after')}</TableCell>
                <TableCell align="right">{t('Actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{formatDate(p.date)}</TableCell>
                  <TableCell>{p.patient ? fullName(p.patient) : '—'}</TableCell>
                  <TableCell>{p.offer?.title ?? '—'}</TableCell>
                  <TableCell align="right">{formatMoney(p.amount)}</TableCell>
                  <TableCell>{p.method ? t(METHOD_LABEL[p.method]) : '—'}</TableCell>
                  <TableCell align="right">{formatMoney(p.remaining)}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {p.offerId && (
                      <Tooltip title={t('Open the treatment offer')}>
                        <IconButton size="small" component={RouterLink} to={`/treatment-offers/${p.offerId}`} aria-label={t('Open the treatment offer of the payment of {{amount}}', { amount: formatMoney(p.amount) })}><AssignmentIcon fontSize="small" /></IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title={t('Receipt (PDF)')}>
                      <IconButton
                        size="small" component="a" href={`/api/v1/payments/${p.id}/receipt`} target="_blank" rel="noopener"
                        aria-label={t('Receipt for payment of {{amount}}', { amount: formatMoney(p.amount) })}
                      ><PictureAsPdfIcon fontSize="small" /></IconButton>
                    </Tooltip>
                    <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit payment of {{amount}}', { amount: formatMoney(p.amount) })} onClick={() => setForm(p)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete payment of {{amount}}', { amount: formatMoney(p.amount) })} onClick={() => { removeState.reset(); setDeleting(p); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {!staff && list.data && total > 0 && (
        <TablePagination
          component="div" count={total} page={page} rowsPerPage={pageSize} rowsPerPageOptions={[10, 25, 50, 100]}
          labelRowsPerPage={t('Rows per page:')}
          labelDisplayedRows={({ from: f, to: tt, count }) => t('{{from}}–{{to}} of {{count}}', { from: f, to: tt, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        />
      )}

      <PaymentFormDialog open={!!form} onClose={() => setForm(null)} payment={form && form !== 'new' ? form : undefined} />
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete this payment?')}
        message={t('The payment goes to the Trash and the balance of the treatment offer is worked out again. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete payment')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </>
  );
}
