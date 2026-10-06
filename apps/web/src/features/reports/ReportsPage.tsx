import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert, Box, Button, Chip, MenuItem, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import TableChartIcon from '@mui/icons-material/TableChart';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDateTime } from '../../lib/format';
import { useGetConfigQuery, useGetDoctorsQuery } from '../clinical/clinicalApi';
import type { ReportJobDto } from '@aya/shared';
import { api } from '../auth/authApi';

const reportsApi = api.injectEndpoints({
  endpoints: (build) => ({
    reportList: build.query<string[], void>({ query: () => '/reports', transformResponse: (r: { data: string[] }) => r.data }),
    reportJobs: build.query<ReportJobDto[], void>({ query: () => '/reports/jobs', transformResponse: (r: { data: ReportJobDto[] }) => r.data }),
  }),
});
const { useReportListQuery, useReportJobsQuery } = reportsApi;

type Kind = 'date' | 'period' | 'none';
interface Spec {
  key: string;
  title: string;
  description: string;
  kind: Kind;
  formats: ('xlsx' | 'pdf')[];
}

/** The reports, in the order they are shown. English text is the translation key. */
const SPECS: Spec[] = [
  { key: 'daily-schedule', title: 'Daily schedule', description: 'Every appointment of one day by time, with the doctor, dental unit and procedures, to print for the front desk.', kind: 'date', formats: ['pdf'] },
  { key: 'revenue', title: 'Revenue and expenses', description: 'Payments received and money spent over a period, by month, by type or by doctor.', kind: 'period', formats: ['xlsx', 'pdf'] },
  { key: 'outstanding-balances', title: 'Outstanding balances', description: 'Who still owes what on open treatment offers, biggest balance first, as things stand today.', kind: 'none', formats: ['xlsx', 'pdf'] },
  { key: 'appointments', title: 'Appointments', description: 'Every appointment of a period with its status and procedures, for analysis.', kind: 'period', formats: ['xlsx'] },
  { key: 'procedures', title: 'Procedures', description: 'How often each procedure was booked and completed in a period, cancelled and missed visits counted apart.', kind: 'period', formats: ['xlsx'] },
  { key: 'patients', title: 'New patients', description: 'Patients added in a period, with their primary doctor and when they were last seen.', kind: 'period', formats: ['xlsx'] },
  { key: 'lab-orders', title: 'Lab orders', description: 'Lab orders due in a period, with their status and whether they are overdue.', kind: 'period', formats: ['xlsx'] },
];

const monthStart = (today: string) => `${today.slice(0, 8)}01`;

function ReportCard({ spec, today, isAdmin }: { spec: Spec; today: string; isAdmin: boolean }) {
  const { t } = useTranslation();
  const { data: doctors = [] } = useGetDoctorsQuery(undefined, { skip: spec.key !== 'daily-schedule' || !isAdmin });
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState('month');
  const [doctorId, setDoctorId] = useState('');

  const validPeriod = !!from && !!to && from <= to;
  const ready = spec.kind === 'date' ? !!date : spec.kind === 'period' ? validPeriod : true;

  const link = (format: 'xlsx' | 'pdf') => {
    const q = new URLSearchParams();
    if (spec.kind === 'date') { q.set('date', date); if (doctorId) q.set('doctorId', doctorId); }
    if (spec.kind === 'period') { q.set('from', from); q.set('to', to); }
    if (spec.key === 'revenue') q.set('groupBy', groupBy);
    if (spec.formats.length > 1) q.set('format', format);
    return `/api/v1/reports/${spec.key}?${q}`;
  };

  return (
    <Paper component="section" aria-label={t(spec.title)} sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Box>
        <Typography variant="h6" component="h2">{t(spec.title)}</Typography>
        <Typography variant="body2" color="text.secondary">{t(spec.description)}</Typography>
      </Box>

      {spec.kind === 'date' && (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <TextField type="date" label={t('Day')} value={date} onChange={(e) => setDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 190 }} margin="none" />
          {isAdmin && (
            <TextField select label={t('Doctor')} value={doctorId} onChange={(e) => setDoctorId(e.target.value)} sx={{ minWidth: 190, maxWidth: 260 }} margin="none">
              <MenuItem value="">{t('All doctors')}</MenuItem>
              {doctors.map((d) => <MenuItem key={d.id} value={String(d.id)}>{t('Dr. {{name}}', { name: `${d.fname} ${d.lname}` })}</MenuItem>)}
            </TextField>
          )}
        </Box>
      )}
      {spec.kind === 'period' && (
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          <TextField type="date" label={t('From')} value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} margin="none" />
          <TextField
            type="date" label={t('To')} value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} margin="none"
            error={!!from && !!to && !validPeriod} helperText={!!from && !!to && !validPeriod ? t('The start must not be after the end') : undefined}
          />
          {spec.key === 'revenue' && (
            <TextField select label={t('Group by')} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} sx={{ minWidth: 150, maxWidth: 190 }} margin="none">
              <MenuItem value="month">{t('Month')}</MenuItem>
              <MenuItem value="type">{t('Type')}</MenuItem>
              {isAdmin && <MenuItem value="doctor">{t('Doctor')}</MenuItem>}
            </TextField>
          )}
        </Box>
      )}

      <Stack direction="row" gap={1} flexWrap="wrap">
        {spec.formats.includes('xlsx') && (
          <Button
            component="a" href={ready ? link('xlsx') : undefined} download target="_blank" rel="noopener" variant="contained" size="small" startIcon={<TableChartIcon />}
            disabled={!ready} aria-label={t('Download {{report}} as Excel', { report: t(spec.title) })}
          >
            {t('Excel')}
          </Button>
        )}
        {spec.formats.includes('pdf') && (
          <Button
            component="a" href={ready ? link('pdf') : undefined} target="_blank" rel="noopener" variant={spec.formats.length > 1 ? 'outlined' : 'contained'} size="small" startIcon={<PictureAsPdfIcon />}
            disabled={!ready} aria-label={t('Download {{report}} as PDF', { report: t(spec.title) })}
          >
            {t('PDF')}
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

const JOB_STATUS: Record<ReportJobDto['status'], { label: string; color: 'default' | 'warning' | 'success' | 'error' }> = {
  queued: { label: 'Waiting', color: 'default' },
  running: { label: 'Being prepared', color: 'warning' },
  done: { label: 'Ready', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  expired: { label: 'Expired', color: 'default' },
};

/** Your reports that were too big to wait for: made in the background, kept for a few days, downloaded from here. */
function BigReports({ queued }: { queued: boolean }) {
  const { t } = useTranslation();
  const [polling, setPolling] = useState(false);
  const { data: jobs = [] } = useReportJobsQuery(undefined, { pollingInterval: polling || queued ? 8000 : 0, refetchOnMountOrArgChange: true });
  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => setPolling(active), [active]); // check again every few seconds while something is being made
  const sort = useSort<'title' | 'status' | 'rows' | 'asked' | 'until'>('asked', 'desc');
  if (!jobs.length && !queued) return null;
  const value = (j: ReportJobDto) => ({ title: j.title, status: t(JOB_STATUS[j.status].label), rows: j.rows, asked: j.createdAt, until: j.expiresAt })[sort.key];
  return (
    <Box component="section" aria-label={t('Big reports')} sx={{ mb: 3 }}>
      {queued && <Alert severity="info" sx={{ mb: 2 }}>{t('That report is big, so it is being prepared in the background. You will get a notification when it is ready, and it will be listed here.')}</Alert>}
      <Typography variant="h6" component="h2" sx={{ mb: 1 }}>{t('Big reports')}</Typography>
      <TableContainer component={Paper}>
        <Table size="small" aria-label={t('Big reports')}>
          <TableHead>
            <TableRow>
              <SortCell field="title" sort={sort}>{t('Report')}</SortCell><SortCell field="status" sort={sort}>{t('Status')}</SortCell>
              <SortCell field="rows" sort={sort} align="right">{t('Rows')}</SortCell><SortCell field="asked" sort={sort}>{t('Asked')}</SortCell>
              <SortCell field="until" sort={sort}>{t('Kept until')}</SortCell><TableCell align="right">{t('Actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sortRows(jobs, value, sort.order).map((j) => (
              <TableRow key={j.id}>
                <TableCell>{j.title}</TableCell>
                <TableCell><Chip size="small" color={JOB_STATUS[j.status].color} label={t(JOB_STATUS[j.status].label)} /></TableCell>
                <TableCell align="right">{j.rows == null ? '—' : j.rows.toLocaleString('en-US')}</TableCell>
                <TableCell>{formatDateTime(j.createdAt)}</TableCell>
                <TableCell>{j.expiresAt ? formatDateTime(j.expiresAt) : '—'}</TableCell>
                <TableCell align="right">
                  {j.downloadUrl && (
                    <Button component="a" href={j.downloadUrl} download size="small" startIcon={<DownloadIcon />} aria-label={t('Download {{report}}', { report: j.title })}>{t('Download')}</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

/** Reports to print or open in Excel. Each person sees only those they may run, limited to the patients they may see. */
export function ReportsPage() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  const { data: config } = useGetConfigQuery();
  const { data: allowed, error } = useReportListQuery();
  const today = config?.today ?? '';
  const specs = SPECS.filter((s) => allowed?.includes(s.key));
  const [params] = useSearchParams();

  return (
    <>
      <PageHeader title={t('Reports')} subtitle={t('Downloads are logged. They contain patient and money data: keep them safe.')} />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {allowed && <BigReports queued={!!params.get('queued')} />}
      {!allowed || !today ? (
        <Skeleton variant="rounded" height={200} aria-label={t('Loading')} />
      ) : specs.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}><Typography>{t('There are no reports you can run.')}</Typography></Paper>
      ) : (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' } }}>
          {specs.map((s) => <ReportCard key={s.key} spec={s} today={today} isAdmin={isAdmin} />)}
        </Box>
      )}
    </>
  );
}
