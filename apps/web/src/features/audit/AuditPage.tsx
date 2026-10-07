import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, IconButton, Tooltip, Link, MenuItem, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination,
  TableRow, TextField, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import CloseIcon from '@mui/icons-material/Close';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import DownloadIcon from '@mui/icons-material/Download';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { dateLocale } from '../../i18n';
import { useClearAuditMutation, useDeleteAuditEntryMutation, useGetConfigQuery, useListAuditQuery, useListUsersQuery } from '../clinical/clinicalApi';

/** What each recorded action means, in plain words (English text is the translation key). */
export const ACTION_LABEL: Record<string, string> = {
  'patient.view': 'Opened the patient',
  'patient.timeline.view': 'Opened the patient’s history',
  'patient.chart.view': 'Opened the patient’s teeth chart',
  'patient.appointments.view': 'Opened the patient’s appointments',
  'appointment.view': 'Opened an appointment',
  'report.view': 'Opened a visit report',
  'report.pdf': 'Downloaded a visit summary',
  'patient.create': 'Added a patient',
  'patient.update': 'Changed a patient',
  'patient.delete': 'Deleted a patient (to the Trash)',
  'appointment.delete': 'Deleted an appointment (to the Trash)',
  'report.delete': 'Deleted a visit report (to the Trash)',
  'document.upload': 'Added a document',
  'document.update': 'Changed a document',
  'document.delete': 'Deleted a document (to the Trash)',
  'document.view': 'Opened a document',
  'offer.view': 'Opened a treatment offer',
  'offer.create': 'Created a treatment offer',
  'offer.update': 'Changed a treatment offer',
  'offer.items': 'Changed the work in a treatment offer',
  'offer.send': 'Marked a treatment offer as sent',
  'offer.accept': 'Marked a treatment offer as accepted',
  'offer.reject': 'Rejected a treatment offer',
  'offer.expire': 'Marked a treatment offer as expired',
  'offer.cancel': 'Cancelled a treatment offer',
  'offer.item_done': 'Marked offer work as done',
  'offer.pdf': 'Downloaded a treatment offer',
  'offer.delete': 'Deleted a treatment offer (to the Trash)',
  'quote.create': 'Created a quote',
  'quote.update': 'Changed a quote',
  'quote.send': 'Marked a quote as sent',
  'quote.accept': 'Marked a quote as accepted',
  'quote.reject': 'Rejected a quote',
  'quote.expire': 'Marked a quote as expired',
  'quote.pdf': 'Downloaded a quote',
  'payment.receipt': 'Downloaded a payment receipt',
  'quote.delete': 'Deleted a quote (to the Trash)',
  'payment.create': 'Recorded a payment',
  'payment.update': 'Changed a payment',
  'payment.delete': 'Deleted a payment (to the Trash)',
  'expense.create': 'Added an expense',
  'expense.update': 'Changed an expense',
  'expense.delete': 'Deleted an expense (to the Trash)',
  'commission.payment.create': 'Recorded a commission payment',
  'commission.payment.update': 'Changed a commission payment',
  'commission.payment.delete': 'Deleted a commission payment (to the Trash)',
  'plan.view': 'Opened a treatment plan',
  'plan.create': 'Created a treatment plan',
  'plan.update': 'Changed a treatment plan',
  'plan.items': 'Changed the work in a treatment plan',
  'plan.propose': 'Marked a treatment plan as proposed',
  'plan.accept': 'Marked a treatment plan as accepted',
  'plan.cancel': 'Cancelled a treatment plan',
  'plan.item_done': 'Marked plan work as done',
  'plan.delete': 'Deleted a treatment plan (to the Trash)',
  'lab_order.view': 'Opened a lab order',
  'lab_order.create': 'Added a lab order',
  'lab_order.update': 'Changed a lab order',
  'lab_order.send': 'Marked a lab order as sent',
  'lab_order.receive': 'Marked a lab order as received',
  'lab_order.fit': 'Marked a lab order as fitted',
  'lab_order.delete': 'Deleted a lab order (to the Trash)',
  'role.update': 'Changed what a role may do',
  'role.reset': 'Put a role back to the built-in permissions',
  'lab.create': 'Added a lab',
  'lab.update': 'Changed a lab',
  'lab.delete': 'Deleted a lab',
  'supplier.create': 'Added a supplier',
  'supplier.update': 'Changed a supplier',
  'supplier.delete': 'Deleted a supplier',
  'report.export': 'Downloaded a report',
  'report.queue': 'Asked for a big report',
  'report.download': 'Downloaded a big report',

  'tax.view': 'Opened the income tax estimate',
  'tax.reopen': 'Reopened a tax year',
  'tax.pdf': 'Downloaded the income tax worksheet',
  'tax.declare': 'Marked a tax year as declared and paid',
  'settings.tax.update': 'Changed the income tax rules',
  'settings.tax.delete': 'Deleted income tax rules',
  'settings.general.update': 'Changed the general settings',
  'settings.appearance.update': 'Changed the appearance settings',
  'trash.restore': 'Restored something from the Trash',
  'trash.purge': 'Erased something for good',
  'appointment.create': 'Booked an appointment',
  'appointment.update': 'Changed an appointment',
  'appointment.confirm': 'Confirmed an appointment',
  'appointment.cancel': 'Cancelled an appointment',
  'appointment.complete': 'Completed a visit',
  'appointment.no-show': 'Marked a no-show',
  'appointment.categories': 'Changed an appointment’s procedures',
  'appointment.teeth': 'Changed an appointment’s teeth',
  'report.summary': 'Wrote a report summary',
  'report.teeth': 'Wrote report tooth notes',
  'report.medications': 'Wrote a prescription',
  'medication.create': 'Added a medication',
  'medication.update': 'Changed a medication',
  'medication.delete': 'Deleted a medication',
  'category.create': 'Added a procedure',
  'category.update': 'Changed a procedure',
  'category.delete': 'Deleted a procedure',
  'doctor.create': 'Added a doctor',
  'doctor.update': 'Changed a doctor',
  'doctor.delete': 'Deleted a doctor',
  'clinic.create': 'Added a clinic',
  'clinic.update': 'Changed a clinic',
  'clinic.delete': 'Deleted a clinic',
  'clinic.logo.set': 'Set a clinic logo',
  'clinic.logo.remove': 'Removed a clinic logo',
  'clinic.doctor.set': 'Assigned a doctor to a clinic',
  'clinic.doctor.remove': 'Removed a doctor from a clinic',
  'unit.create': 'Added a dental unit',
  'unit.rename': 'Renamed a dental unit',
  'unit.delete': 'Deleted a dental unit',
  'user.create': 'Created an account',
  'user.update': 'Changed an account',
  'user.deactivate': 'Switched an account off',
  'user.reset-password': 'Made a temporary password',
  'user.reset-link': 'Made a reset link',
  'auth.login.success': 'Signed in',
  'auth.login.failed': 'Failed sign-in',
  'auth.lockout': 'Account locked after failed sign-ins',
  'auth.logout': 'Signed out',
  'auth.password.change': 'Changed own password',
  'auth.password.reset.complete': 'Chose a new password from a reset link',
  'audit.clear': 'Cleared the activity log',
  'audit.export': 'Downloaded the activity log',
  'audit.retention': 'Removed old activity log entries automatically',
  'trash.autopurge': 'Erased old items from the Trash automatically',
  'settings.retention.update': 'Changed the Trash and activity log settings',
  'audit.delete': 'Deleted one activity log entry',
  'auth.refresh.reuse': 'Reused an old session (sessions ended)',
};

const isView = (action: string) => action.endsWith('.view') || ['report.pdf', 'quote.pdf', 'offer.pdf', 'payment.receipt'].includes(action);

/** Admin only: who opened and changed what, and when. Content is never recorded, only ids. */
export function AuditPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const sort = useSort<'time' | 'user' | 'action'>('time', 'desc');
  const [kind, setKind] = useState<'' | 'views' | 'changes'>('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const entity = params.get('entity') ?? undefined;
  const entityId = params.get('entityId') ?? undefined;

  const [clear, clearState] = useClearAuditMutation();
  const [clearing, setClearing] = useState(false);
  const [removeEntry, removeState] = useDeleteAuditEntryMutation();
  const { data: config } = useGetConfigQuery();
  const { data: users } = useListUsersQuery();
  const { data, isFetching, error } = useListAuditQuery({
    page: page + 1, pageSize, kind: kind || undefined, userId: userId ? Number(userId) : undefined, entity, entityId,
    from: from || undefined, to: to || undefined, sort: sort.key, order: sort.order,
  });
  useEffect(() => setPage(0), [kind, userId, from, to, entity, entityId, sort.key, sort.order]);

  const when = (utc: string) =>
    new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: config?.timezone }).format(new Date(`${utc.replace(' ', 'T')}Z`));
  // The file holds every entry the filters select (not only this page), a plain link so the browser downloads it.
  const exportParams = new URLSearchParams(Object.entries({ kind, userId, entity, entityId, from, to }).filter((e): e is [string, string] => Boolean(e[1])));
  const exportUrl = `/api/v1/audit-log/export.csv${exportParams.size ? `?${exportParams}` : ''}`;
  const rows = data?.data ?? [];
  const patientName = rows.find((r) => r.entity === 'patient' && r.entityId === entityId)?.entityLabel;

  return (
    <>
      <PageHeader
        title={t('Activity log')}
        subtitle={t('Who opened or changed what, and when. Only ids are recorded, never the content of a record.')}
        actions={(
          <>
            <Button component="a" href={exportUrl} download variant="outlined" startIcon={<DownloadIcon />}>{t('Download as CSV')}</Button>
            <Button color="error" variant="outlined" startIcon={<DeleteSweepIcon />} onClick={() => { clearState.reset(); setClearing(true); }}>{t('Clear the log')}</Button>
          </>
        )}
      />

      <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} sx={{ mb: 2 }} flexWrap="wrap">
        <TextField select label={t('Show')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} sx={{ maxWidth: { md: 220 } }}>
          <MenuItem value="">{t('Everything')}</MenuItem>
          <MenuItem value="views">{t('Who opened records')}</MenuItem>
          <MenuItem value="changes">{t('Changes and sign-ins')}</MenuItem>
        </TextField>
        <TextField select label={t('Person')} value={userId} onChange={(e) => setUserId(e.target.value)} sx={{ maxWidth: { md: 240 } }}>
          <MenuItem value="">{t('Everyone')}</MenuItem>
          {(users?.data ?? []).map((u) => <MenuItem key={u.id} value={String(u.id)}>{u.name}</MenuItem>)}
        </TextField>
        <TextField type="date" label={t('From')} value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: { md: 170 } }} />
        <TextField type="date" label={t('To')} value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: { md: 170 } }} />
      </Stack>
      <ConfirmDialog
        open={clearing} destructive title={t('Clear the whole log?')}
        message={t('This erases every entry for everyone ({{n}} entries) and cannot be undone. Afterwards the log holds one entry saying who cleared it.', { n: data?.meta.total ?? 0 })}
        confirmLabel={t('Clear the log')} busy={clearState.isLoading} onClose={() => setClearing(false)}
        onConfirm={async () => { const r = await clear(); if (!('error' in r && r.error)) setClearing(false); }}
      />
      {removeState.error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(removeState.error)}</Alert>}
      {clearState.error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(clearState.error)}</Alert>}
      {entityId && (
        <Chip
          sx={{ mb: 2 }} color="primary" variant="outlined"
          label={t('Only this record: {{name}}', { name: patientName ?? `#${entityId}` })}
          onDelete={() => setParams({})}
        />
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={160} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('Nothing has been recorded for these filters.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="time" sort={sort}>{t('When')}</SortCell>
                <SortCell field="user" sort={sort}>{t('Person')}</SortCell>
                <SortCell field="action" sort={sort}>{t('What')}</SortCell>
                <TableCell>{t('Record')}</TableCell>
                <TableCell align="right" sx={{ width: 56 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t('Actions')}</span></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{when(r.createdAt)}</TableCell>
                  <TableCell>{r.userName ?? '—'}</TableCell>
                  <TableCell>
                    {ACTION_LABEL[r.action] ? t(ACTION_LABEL[r.action]!) : r.action}
                    {isView(r.action) && <Chip size="small" label={t('Viewed')} sx={{ marginInlineStart: 1 }} />}
                  </TableCell>
                  <TableCell>
                    {r.entity === 'patient' && r.entityId ? (
                      <Link component={RouterLink} to={`/patients/${r.entityId}`} underline="hover">
                        {r.entityLabel ?? t('Patient #{{number}}', { number: r.entityId })}
                      </Link>
                    ) : r.entity ? (
                      <Box component="span" dir="ltr">{r.entity} #{r.entityId}</Box>
                    ) : '—'}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title={t('Delete this entry')}>
                      <IconButton size="small" aria-label={t('Delete this entry')} disabled={removeState.isLoading} onClick={() => removeEntry(r.id)}>
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {data && data.meta.total > 0 && (
        <TablePagination
          component="div" count={data.meta.total} page={page} rowsPerPage={pageSize} rowsPerPageOptions={[25, 50, 100, 200]}
          labelRowsPerPage={t('Rows per page:')}
          labelDisplayedRows={({ from: f, to: tt, count }) => t('{{from}}–{{to}} of {{count}}', { from: f, to: tt, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        />
      )}
    </>
  );
}
