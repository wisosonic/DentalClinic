import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, InputAdornment, MenuItem, Paper, Skeleton,
  Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RestoreFromTrashIcon from '@mui/icons-material/RestoreFromTrash';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import type { TrashImpactDto, TrashItemDto } from '@aya/shared';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { useDebounce } from '../../lib/useDebounce';
import { dateLocale } from '../../i18n';
import { useEmptyTrashMutation, useGetConfigQuery, useGetTrashImpactQuery, useGetTrashSummaryQuery, useListTrashQuery, usePurgeTrashMutation, useRestoreTrashMutation } from '../clinical/clinicalApi';

const KIND_LABEL = { patient: 'Patient', appointment: 'Appointment', report: 'Visit report', offer: 'Treatment offer', payment: 'Payment', commission: 'Commission payment', expense: 'Expense', lab_order: 'Lab order', document: 'Document' } as const;

/** The lines of the warning: only what will actually be erased. */
export const IMPACT_LINES: [keyof TrashImpactDto['counts'], string, string][] = [
  ['patients', '1 patient record', '{{n}} patient records'],
  ['appointments', '1 appointment', '{{n}} appointments'],
  ['reports', '1 visit report', '{{n}} visit reports'],
  ['reportToothNotes', '1 tooth note', '{{n}} tooth notes'],
  ['prescriptionLines', '1 prescription line', '{{n}} prescription lines'],
  ['offers', '1 treatment offer', '{{n}} treatment offers'],
  ['documents', '1 document', '{{n}} documents'],
  ['payments', '1 payment', '{{n}} payments'],
  ['expenses', '1 expense', '{{n}} expenses'],
  ['labOrders', '1 lab order', '{{n}} lab orders'],
  ['logins', '1 sign-in account', '{{n}} sign-in accounts'],
];

function EraseDialog({ item, onClose }: { item: TrashItemDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isFetching } = useGetTrashImpactQuery(item ? { kind: item.kind, id: item.id } : undefined as never, { skip: !item });
  const [purge, { isLoading, error, reset }] = usePurgeTrashMutation();
  const [typed, setTyped] = useState('');
  useEffect(() => { setTyped(''); reset(); }, [item]); // eslint-disable-line react-hooks/exhaustive-deps
  const matches = !!item && typed.trim().toLowerCase() === item.confirmText.toLowerCase();

  return (
    <Dialog open={!!item} onClose={isLoading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('Erase for good?')}</DialogTitle>
      <DialogContent>
        <Alert severity="error" sx={{ mb: 2 }}>{t('This cannot be undone. The data is removed from the database and cannot be recovered.')}</Alert>
        {error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(error)}</Alert>}
        <Typography sx={{ mb: 1 }}>{t('This will erase:')}</Typography>
        {isFetching || !data ? (
          <CircularProgress size={20} aria-label={t('Loading')} />
        ) : (
          <Box component="ul" sx={{ mt: 0, mb: 2, paddingInlineStart: 3 }}>
            {IMPACT_LINES.filter(([key]) => data.counts[key] > 0).map(([key, one, many]) => (
              <li key={key}>{data.counts[key] === 1 ? t(one) : t(many, { n: data.counts[key] })}</li>
            ))}
          </Box>
        )}
        <Typography variant="body2" sx={{ mb: 1 }}>
          {item?.kind === 'commission' || item?.kind === 'expense' ? t('To confirm, type: {{text}}', { text: item.confirmText }) : t('To confirm, type the patient’s name: {{name}}', { name: item?.confirmText ?? '' })}
        </Typography>
        <TextField label={item?.kind === 'commission' || item?.kind === 'expense' ? t('Confirmation') : t('Patient’s name')} value={typed} onChange={(e) => setTyped(e.target.value)} margin="none" autoFocus autoComplete="off" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isLoading}>{t('Keep it')}</Button>
        <Button
          variant="contained" color="error" disabled={!matches || isLoading || !data}
          onClick={async () => { const r = await purge({ kind: item!.kind, id: item!.id, confirm: typed.trim() }); if (!('error' in r && r.error)) onClose(); }}
        >
          {t('Erase for good')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** What is in the Trash, by kind (English text is the translation key). */
const KIND_LINES: [TrashItemDto['kind'], string][] = [
  ['patient', 'Patients'], ['appointment', 'Appointments'], ['report', 'Visit reports'], ['offer', 'Treatment offers'], ['payment', 'Payments'],
  ['commission', 'Commission payments'], ['expense', 'Expenses'], ['lab_order', 'Lab orders'], ['document', 'Documents'],
];

/** Erases everything in the Trash, after the word "empty" is typed. */
function EmptyTrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data } = useGetTrashSummaryQuery(undefined, { skip: !open });
  const [empty, { isLoading, error, reset }] = useEmptyTrashMutation();
  const [typed, setTyped] = useState('');
  const [left, setLeft] = useState<{ erased: number; failed: number } | null>(null);
  useEffect(() => { if (open) { setTyped(''); setLeft(null); reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const matches = typed.trim().toLowerCase() === 'empty';

  return (
    <Dialog open={open} onClose={isLoading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('Empty the Trash?')}</DialogTitle>
      <DialogContent>
        {left ? (
          <Alert severity="warning" role="status">{t('Erased {{n}}. {{failed}} could not be erased and are still in the Trash.', { n: left.erased, failed: left.failed })}</Alert>
        ) : (
          <>
            <Alert severity="error" sx={{ mb: 2 }}>
              {t('This erases everything in the Trash for good ({{n}} items) and cannot be undone. A patient goes with their visits, offers, payments, documents and sign-in account.', { n: data?.total ?? 0 })}
            </Alert>
            {error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(error)}</Alert>}
            {!data ? <CircularProgress size={20} aria-label={t('Loading')} /> : (
              <Box component="ul" sx={{ mt: 0, mb: 2, paddingInlineStart: 3 }}>
                {KIND_LINES.filter(([kind]) => data.counts[kind] > 0).map(([kind, label]) => <li key={kind}>{t(label)}: {data.counts[kind]}</li>)}
              </Box>
            )}
            <Typography variant="body2" sx={{ mb: 1 }}>{t('To confirm, type: {{text}}', { text: 'empty' })}</Typography>
            <TextField label={t('Confirmation')} value={typed} onChange={(e) => setTyped(e.target.value)} margin="none" autoFocus autoComplete="off" />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isLoading}>{left ? t('Close') : t('Keep it')}</Button>
        {!left && (
          <Button
            variant="contained" color="error" disabled={!matches || isLoading || !data || data.total === 0}
            onClick={async () => {
              const r = await empty({ confirm: typed.trim() });
              if ('error' in r && r.error) return;
              if (r.data.failed > 0) setLeft({ erased: r.data.total, failed: r.data.failed });
              else onClose();
            }}
          >
            {isLoading ? t('Erasing…') : t('Empty the Trash')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

type SortKey = 'deletedAt' | 'kind' | 'label' | 'deletedBy';

/** Admin only: what staff and doctors deleted. Restore it, or erase it for good. */
export function TrashPage() {
  const { t } = useTranslation();
  const sort = useSort<SortKey>('deletedAt', 'desc');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [erasing, setErasing] = useState<TrashItemDto | null>(null);
  const [emptying, setEmptying] = useState(false);
  const { data: summary } = useGetTrashSummaryQuery();
  const { data: config } = useGetConfigQuery();
  const { data, isFetching, error } = useListTrashQuery({
    page: page + 1, pageSize, kind: (kind || undefined) as TrashItemDto['kind'] | undefined, q: q || undefined, sort: sort.key, order: sort.order,
  });
  const [restore, restoreState] = useRestoreTrashMutation();
  useEffect(() => setPage(0), [kind, q, sort.key, sort.order]);

  const when = (utc: string) =>
    new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: config?.timezone }).format(new Date(`${utc.replace(' ', 'T')}Z`));
  const rows = data?.data ?? [];
  const blockedText = (b: 'patient' | 'appointment' | 'offer') => (b === 'patient' ? t('Restore the patient first') : b === 'offer' ? t('Restore the treatment offer first') : t('Restore the appointment first'));

  return (
    <>
      <PageHeader
        title={t('Trash')}
        subtitle={t('Deleted by staff and doctors. Restore an item, or erase it for good: only you can.')}
        actions={<Button color="error" variant="outlined" startIcon={<DeleteSweepIcon />} disabled={!summary || summary.total === 0} onClick={() => setEmptying(true)}>{t('Empty the Trash')}</Button>}
      />
      <EmptyTrashDialog open={emptying} onClose={() => setEmptying(false)} />
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search the Trash')} margin="none" sx={{ maxWidth: 360 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t('Search the Trash') } }}
        />
        <TextField select label={t('Type')} value={kind} onChange={(e) => setKind(e.target.value)} margin="none" sx={{ maxWidth: 220 }}>
          <MenuItem value="">{t('Everything')}</MenuItem>
          <MenuItem value="patient">{t('Patients')}</MenuItem>
          <MenuItem value="appointment">{t('Appointments')}</MenuItem>
          <MenuItem value="report">{t('Visit reports')}</MenuItem>
          <MenuItem value="offer">{t('Treatment offers')}</MenuItem>
          <MenuItem value="payment">{t('Payments')}</MenuItem>
          <MenuItem value="commission">{t('Commission payments')}</MenuItem>
          <MenuItem value="expense">{t('Expenses')}</MenuItem>
          <MenuItem value="lab_order">{t('Lab orders')}</MenuItem>
          <MenuItem value="document">{t('Documents')}</MenuItem>
        </TextField>
      </Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {restoreState.error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(restoreState.error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={120} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('The Trash is empty.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="label" sort={sort}>{t('Item')}</SortCell>
                <SortCell field="kind" sort={sort}>{t('Type')}</SortCell>
                <TableCell>{t('Details')}</TableCell>
                <SortCell field="deletedBy" sort={sort}>{t('Deleted by')}</SortCell>
                <SortCell field="deletedAt" sort={sort}>{t('Deleted')}</SortCell>
                <TableCell align="right">{t('Actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((item) => (
                <TableRow key={`${item.kind}-${item.id}`}>
                  <TableCell>{item.label}</TableCell>
                  <TableCell><Chip size="small" label={t(KIND_LABEL[item.kind])} /></TableCell>
                  <TableCell><bdi dir="ltr">{item.detail}</bdi></TableCell>
                  <TableCell>{item.deletedBy ?? '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{when(item.deletedAt)}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title={item.blockedBy ? blockedText(item.blockedBy) : ''}>
                      <span>
                        <Button size="small" startIcon={<RestoreFromTrashIcon />} disabled={!!item.blockedBy || restoreState.isLoading}
                          aria-label={t('Restore {{name}}', { name: item.label })} onClick={() => restore({ kind: item.kind, id: item.id })}>
                          {t('Restore')}
                        </Button>
                      </span>
                    </Tooltip>
                    <Button size="small" color="error" startIcon={<DeleteForeverIcon />} aria-label={t('Erase {{name}} for good', { name: item.label })} onClick={() => setErasing(item)}>
                      {t('Erase for good')}
                    </Button>
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
          labelDisplayedRows={({ from, to, count }) => t('{{from}}–{{to}} of {{count}}', { from, to, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        />
      )}
      <EraseDialog item={erasing} onClose={() => setErasing(null)} />
    </>
  );
}
