import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, IconButton, InputAdornment, MenuItem, Paper, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead,
  TablePagination, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { EXPENSE_TYPES, type ExpenseDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { EXPENSE_TYPE_LABEL, formatMoney } from '../../lib/money';
import { useDebounce } from '../../lib/useDebounce';
import { useDeleteExpenseMutation, useListExpensesQuery } from './financeApi';
import { ExpenseFormDialog } from './ExpenseFormDialog';

type SortKey = 'date' | 'type' | 'amount' | 'description';

/** What an expense was for: the lab or supplier, or the specialist and visit, otherwise its note. */
function Details({ e }: { e: ExpenseDto }) {
  const parts = [
    e.lab?.name, e.supplier?.name, e.doctor && fullName(e.doctor),
    e.appointment && `${formatDate(e.appointment.date)} · ${fullName(e.appointment.patient)}`, e.description,
  ].filter(Boolean);
  return <>{parts.length ? parts.join(' · ') : '—'}</>;
}

/** Money paid out. Admins see every type; staff everything except the owners' personal expenses. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  const sort = useSort<SortKey>('date', 'desc');
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim());
  const [params] = useSearchParams();
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [form, setForm] = useState<'new' | ExpenseDto | null>(null);
  const [deleting, setDeleting] = useState<ExpenseDto | null>(null);
  const [remove, removeState] = useDeleteExpenseMutation();

  const { data, isFetching, error } = useListExpensesQuery({
    page: page + 1, pageSize, type: type || undefined, q: q || undefined, from: from || undefined, to: to || undefined, sort: sort.key, order: sort.order,
  });
  useEffect(() => setPage(0), [type, q, from, to, sort.key, sort.order]);
  const rows = data?.data ?? [];
  const types = EXPENSE_TYPES.filter((x) => isAdmin || x !== 'personal');

  return (
    <>
      <PageHeader
        title={t('Expenses')}
        subtitle={data ? t('{{count}} shown, {{amount}} in total', { count: data.meta.total, amount: formatMoney(data.sum) }) : undefined}
        actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setForm('new')}>{t('New expense')}</Button>}
      />
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search the notes')} margin="none" sx={{ maxWidth: 300 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t('Search expenses') } }}
        />
        <TextField select label={t('Type')} value={type} onChange={(e) => setType(e.target.value)} margin="none" sx={{ maxWidth: 200 }}>
          <MenuItem value="">{t('All')}</MenuItem>
          {types.map((x) => <MenuItem key={x} value={x}>{t(EXPENSE_TYPE_LABEL[x])}</MenuItem>)}
        </TextField>
        <TextField type="date" label={t('From')} value={from} onChange={(e) => setFrom(e.target.value)} margin="none" slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} />
        <TextField type="date" label={t('To')} value={to} onChange={(e) => setTo(e.target.value)} margin="none" slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} />
      </Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {removeState.error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(removeState.error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={140} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('No expenses match.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="date" sort={sort}>{t('Date')}</SortCell>
                <SortCell field="type" sort={sort}>{t('Type')}</SortCell>
                <SortCell field="description" sort={sort}>{t('Details')}</SortCell>
                <SortCell field="amount" sort={sort} align="right">{t('Amount')}</SortCell>
                <TableCell align="right">{t('Actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(e.date)}</TableCell>
                  <TableCell><Chip size="small" label={t(EXPENSE_TYPE_LABEL[e.type])} color={e.type === 'personal' ? 'warning' : 'default'} /></TableCell>
                  <TableCell><Details e={e} /></TableCell>
                  <TableCell align="right">{formatMoney(e.amount)}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit expense of {{amount}}', { amount: formatMoney(e.amount) })} onClick={() => setForm(e)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete expense of {{amount}}', { amount: formatMoney(e.amount) })} onClick={() => { removeState.reset(); setDeleting(e); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                  </TableCell>
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
          labelDisplayedRows={({ from: f, to: tt, count }) => t('{{from}}–{{to}} of {{count}}', { from: f, to: tt, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        />
      )}

      <ExpenseFormDialog open={!!form} onClose={() => setForm(null)} expense={form && form !== 'new' ? form : undefined} />
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete this expense?')}
        message={t('The expense goes to the Trash. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete expense')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </>
  );
}
