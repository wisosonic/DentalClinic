import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, FormControlLabel, IconButton, InputAdornment, MenuItem, Paper, Skeleton, Switch, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { LAB_STATUSES, type LabAction, type LabOrderDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { BackToPatientButton } from '../../components/BackToPatientButton';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { formatMoney } from '../../lib/money';
import { useDebounce } from '../../lib/useDebounce';
import { useGetPatientQuery } from '../clinical/clinicalApi';
import { useLabsQuery } from '../finance/financeApi';
import { LAB_STATUS_COLOR, LAB_STATUS_LABEL } from './labels';
import { useDeleteLabOrderMutation, useLabOrderActionMutation, useListLabOrdersQuery } from './labsApi';
import { LabOrderFormDialog } from './LabOrderFormDialog';

type SortKey = 'patient' | 'lab' | 'item' | 'tooth' | 'status' | 'sent' | 'due' | 'received' | 'cost';

/** The next step of an order, with the button that takes it. */
const NEXT: Partial<Record<LabOrderDto['status'], { action: LabAction; label: string }>> = {
  draft: { action: 'send', label: 'Mark sent' },
  sent: { action: 'receive', label: 'Mark received' },
  received: { action: 'fit', label: 'Mark fitted' },
};

/**
 * Work sent to the dental labs. Staff and admins create and move orders along; a doctor sees the orders
 * of his own patients, without what they cost.
 */
export function LabOrdersPage() {
  const { t } = useTranslation();
  const { role } = useRole();
  const canEdit = role === 'admin' || role === 'staff';
  const [params, setParams] = useSearchParams();
  const patientId = Number(params.get('patientId')) || undefined;
  const { data: patient } = useGetPatientQuery(patientId!, { skip: !patientId });
  const { data: labs = [] } = useLabsQuery(undefined, { skip: !canEdit });
  const sort = useSort<SortKey>('due');
  const [status, setStatus] = useState('');
  const [labId, setLabId] = useState('');
  const [overdue, setOverdue] = useState(params.get('overdue') === '1');
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [form, setForm] = useState<'new' | LabOrderDto | null>(null);
  const [deleting, setDeleting] = useState<LabOrderDto | null>(null);
  const [remove, removeState] = useDeleteLabOrderMutation();
  const [act, actState] = useLabOrderActionMutation();

  const { data, isFetching, error } = useListLabOrdersQuery({
    page: page + 1, pageSize, patientId, status: status || undefined, labId: Number(labId) || undefined, overdue, q: q || undefined,
  });
  useEffect(() => setPage(0), [status, labId, overdue, q, patientId]);

  const value: Record<SortKey, (o: LabOrderDto) => string | number | null> = {
    patient: (o) => fullName(o.patient), lab: (o) => o.lab.name, item: (o) => o.item, tooth: (o) => o.tooth?.index ?? null,
    status: (o) => LAB_STATUSES.indexOf(o.status), sent: (o) => o.sentAt, due: (o) => o.dueAt, received: (o) => o.receivedAt, cost: (o) => o.cost ?? null,
  };
  const rows = sortRows(data?.data ?? [], value[sort.key], sort.order);
  const showCost = canEdit;

  return (
    <>
      <PageHeader
        title={t('Lab orders')}
        subtitle={data ? (data.meta.total === 1 ? t('1 order') : t('{{n}} orders', { n: data.meta.total })) : undefined}
        actions={(
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {patientId && <BackToPatientButton patientId={patientId} />}
            {canEdit && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setForm('new')}>{t('New lab order')}</Button>}
          </Box>
        )}
      />
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2, alignItems: 'center' }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search by item, lab or patient')} margin="none" sx={{ maxWidth: 340 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t('Search lab orders') } }}
        />
        <TextField select label={t('Status')} value={status} onChange={(e) => setStatus(e.target.value)} margin="none" sx={{ minWidth: 150 }}>
          <MenuItem value="">{t('All')}</MenuItem>
          {LAB_STATUSES.map((s) => <MenuItem key={s} value={s}>{t(LAB_STATUS_LABEL[s])}</MenuItem>)}
        </TextField>
        {canEdit && (
          <TextField select label={t('Lab')} value={labId} onChange={(e) => setLabId(e.target.value)} margin="none" sx={{ minWidth: 170 }}>
            <MenuItem value="">{t('All')}</MenuItem>
            {labs.map((l) => <MenuItem key={l.id} value={String(l.id)}>{l.name}</MenuItem>)}
          </TextField>
        )}
        <FormControlLabel control={<Switch checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />} label={t('Overdue only')} />
      </Box>
      {patientId && (
        <Chip sx={{ mb: 2 }} color="primary" variant="outlined" label={t('Only {{name}}', { name: patient ? fullName(patient) : `#${patientId}` })} onDelete={() => setParams({})} />
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {(removeState.error ?? actState.error) != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(removeState.error ?? actState.error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={140} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('No lab orders match.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="patient" sort={sort}>{t('Patient')}</SortCell>
                <SortCell field="lab" sort={sort}>{t('Lab')}</SortCell>
                <SortCell field="item" sort={sort}>{t('Item')}</SortCell>
                <SortCell field="tooth" sort={sort}>{t('Tooth')}</SortCell>
                <SortCell field="status" sort={sort}>{t('Status')}</SortCell>
                <SortCell field="sent" sort={sort}>{t('Sent')}</SortCell>
                <SortCell field="due" sort={sort}>{t('Due')}</SortCell>
                <SortCell field="received" sort={sort}>{t('Received')}</SortCell>
                {showCost && <SortCell field="cost" sort={sort} align="right">{t('Cost')}</SortCell>}
                {canEdit && <TableCell align="right">{t('Actions')}</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((o) => {
                const next = NEXT[o.status];
                return (
                  <TableRow key={o.id}>
                    <TableCell><RouterLink to={`/patients/${o.patient.id}`}>{fullName(o.patient)}</RouterLink></TableCell>
                    <TableCell>{o.lab.name}</TableCell>
                    <TableCell>{o.item}</TableCell>
                    <TableCell>{o.tooth ? <bdi dir="ltr">{o.tooth.index}</bdi> : '—'}</TableCell>
                    <TableCell><Chip size="small" label={t(LAB_STATUS_LABEL[o.status])} color={LAB_STATUS_COLOR[o.status]} /></TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{o.sentAt ? formatDate(o.sentAt) : '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {o.dueAt ? formatDate(o.dueAt) : '—'}
                      {o.overdue && <Chip size="small" color="error" label={t('Overdue')} sx={{ marginInlineStart: 1 }} />}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{o.receivedAt ? formatDate(o.receivedAt) : '—'}</TableCell>
                    {showCost && <TableCell align="right">{formatMoney(o.cost)}</TableCell>}
                    {canEdit && (
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        {next && (
                          <Button size="small" variant="outlined" disabled={actState.isLoading} onClick={() => { actState.reset(); act({ id: o.id, action: next.action }); }} sx={{ marginInlineEnd: 0.5 }}>
                            {t(next.label)}
                          </Button>
                        )}
                        {o.status !== 'fitted' && (
                          <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit order {{item}}', { item: o.item })} onClick={() => setForm(o)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                        )}
                        <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete order {{item}}', { item: o.item })} onClick={() => { removeState.reset(); setDeleting(o); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {data && data.meta.total > 0 && (
        <TablePagination
          component="div" count={data.meta.total} page={page} rowsPerPage={pageSize} rowsPerPageOptions={[25, 50, 100]}
          labelRowsPerPage={t('Rows per page:')}
          labelDisplayedRows={({ from, to, count }) => t('{{from}}–{{to}} of {{count}}', { from, to, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        />
      )}

      <LabOrderFormDialog open={!!form} onClose={() => setForm(null)} order={form && form !== 'new' ? form : undefined} patient={patient} />
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete this lab order?')}
        message={t('The order goes to the Trash. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete order')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </>
  );
}
