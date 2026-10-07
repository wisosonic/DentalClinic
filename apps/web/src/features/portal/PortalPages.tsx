import { useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, LinearProgress, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ImageIcon from '@mui/icons-material/Image';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { formatBytes, formatDate, fullName, statusLabel, STATUS_COLOR } from '../../lib/format';
import { METHOD_LABEL, formatMoney } from '../../lib/money';
import { useGetTimelineQuery } from '../clinical/clinicalApi';
import { DOCUMENT_CATEGORY_LABEL } from '../documents/labels';
import { ITEM_STATUS_COLOR, ITEM_STATUS_LABEL } from '../offers/labels';
import { PaymentStateChip, WorkStateChip } from '../offers/OfferChips';
import { ReportView } from '../visits/ReportView';
import { useGetMyPatientQuery } from '../clinical/clinicalApi';
import { AppointmentCard } from './AppointmentCard';
import { useGetPortalDocumentsQuery, useGetPortalOffersQuery, useGetPortalOverviewQuery, useGetPortalPaymentsQuery, useGetPortalUpcomingQuery } from './portalApi';
import { TimeText } from '../../lib/useTime';
import { useTimeFormat } from '../../lib/useTime';

const Loading = () => {
  const { t } = useTranslation();
  return <Skeleton variant="rounded" height={120} aria-label={t('Loading')} />;
};
const Empty = ({ children }: { children: string }) => <Paper sx={{ p: 3, textAlign: 'center' }}><Typography color="text.secondary">{children}</Typography></Paper>;

// ---------------------------------------------------------------------------------------------------------------------
// Appointments: what is coming (with a way to cancel while there is notice) and the history with each visit's report
// ---------------------------------------------------------------------------------------------------------------------
export function PortalAppointmentsPage() {
  const { t } = useTranslation();
  const fmtTime = useTimeFormat();
  const { data: overview } = useGetPortalOverviewQuery();
  const { data: upcoming, error: upcomingError, isLoading } = useGetPortalUpcomingQuery();
  const { data: timeline, error: timelineError, isLoading: loadingHistory } = useGetTimelineQuery({ patientId: 'me', pageSize: 100 });
  const coming = new Set((upcoming ?? []).map((a) => a.id));
  const history = (timeline?.data ?? []).filter((e) => !coming.has(e.appointment.id));

  return (
    <>
      <PageHeader title={t('My appointments')} subtitle={t('To book or change an appointment, please call the clinic.')} />
      <Box component="section" aria-label={t('Upcoming')} sx={{ mb: 4 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>{t('Upcoming')}</Typography>
        {upcomingError != null && <Alert severity="error">{errorMessage(upcomingError)}</Alert>}
        {isLoading ? <Loading /> : (upcoming ?? []).length === 0 ? <Empty>{t('You have no appointment coming up.')}</Empty> : (
          <Stack spacing={2}>
            {(upcoming ?? []).map((a) => <AppointmentCard key={a.id} appointment={a} cancelMinHours={overview?.cancelMinHours ?? 24} />)}
          </Stack>
        )}
      </Box>

      <Box component="section" aria-label={t('History')}>
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>{t('History')}</Typography>
        {timelineError != null && <Alert severity="error">{errorMessage(timelineError)}</Alert>}
        {loadingHistory ? <Loading /> : history.length === 0 ? <Empty>{t('Your visits will appear here.')}</Empty> : (
          <Stack spacing={1}>
            {history.map(({ appointment: a, report, hasReport }) => (
              <Accordion key={a.id} disableGutters>
                <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-label={`${formatDate(a.date)} ${fmtTime(a.time)}`}>
                  <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', width: '100%', paddingInlineEnd: 1 }}>
                    <Typography fontWeight={700}>{formatDate(a.date)} · <TimeText value={a.time} /></Typography>
                    <Typography color="text.secondary">{t('Dr. {{name}}', { name: `${a.doctor.fname} ${a.doctor.lname}` })}</Typography>
                    <Chip size="small" color={STATUS_COLOR[a.status]} label={statusLabel(a.status)} />
                    {a.categories.map((c) => <Chip key={c} size="small" variant="outlined" label={c} />)}
                  </Box>
                </AccordionSummary>
                <AccordionDetails>
                  {report ? <ReportView report={report} appointmentId={a.id} /> : (
                    <Typography color="text.secondary">{hasReport ? t('The report is not available.') : t('There is no report for this visit.')}</Typography>
                  )}
                </AccordionDetails>
              </Accordion>
            ))}
          </Stack>
        )}
      </Box>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Treatment: the offers the patient agreed to, item by item, with what is paid
// ---------------------------------------------------------------------------------------------------------------------
export function PortalTreatmentPage() {
  const { t } = useTranslation();
  const { data, error, isLoading } = useGetPortalOffersQuery();
  return (
    <>
      <PageHeader title={t('My treatment')} subtitle={t('What your doctor has planned with you, how far it has got, and what is paid.')} />
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {isLoading ? <Loading /> : (data ?? []).length === 0 ? <Empty>{t('You have no treatment plan yet.')}</Empty> : (
        <Stack spacing={3}>
          {(data ?? []).map((o) => (
            <Paper key={o.id} component="article" aria-label={o.title} sx={{ p: { xs: 2, sm: 3 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 0.5 }}>
                <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>{o.title}</Typography>
                <WorkStateChip state={o.workState} />
                {o.paymentState && <PaymentStateChip state={o.paymentState} />}
              </Box>
              {o.description && <Typography color="text.secondary" sx={{ mb: 1 }}>{o.description}</Typography>}
              {o.doctor && <Typography variant="body2" color="text.secondary">{t('Dr. {{name}}', { name: `${o.doctor.fname} ${o.doctor.lname}` })}</Typography>}
              <LinearProgress variant="determinate" value={o.progress.percent} aria-label={t('Progress of {{title}}', { title: o.title })} sx={{ height: 8, my: 1.5 }} />
              <Typography variant="body2" sx={{ mb: 1.5 }}>{t('{{done}} of {{total}} done', { done: o.progress.done, total: o.progress.total })}</Typography>
              <TableContainer>
                <Table size="small" aria-label={t('Work')}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('Work')}</TableCell>
                      <TableCell>{t('Tooth')}</TableCell>
                      <TableCell>{t('Status')}</TableCell>
                      <TableCell>{t('Visit')}</TableCell>
                      <TableCell align="right">{t('Price')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {o.items.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell>{i.description}</TableCell>
                        <TableCell>{i.tooth ? <bdi dir="ltr">{i.tooth}</bdi> : '—'}</TableCell>
                        <TableCell><Chip size="small" label={t(ITEM_STATUS_LABEL[i.status])} color={ITEM_STATUS_COLOR[i.status]} /></TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{i.visit ? <>{formatDate(i.visit.date)} <TimeText value={i.visit.time} /></> : '—'}</TableCell>
                        <TableCell align="right">{formatMoney(i.price)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mt: 2, alignItems: 'flex-end' }}>
                <Box><Typography variant="caption" color="text.secondary">{t('Total')}</Typography><Typography variant="h6">{formatMoney(o.price)}</Typography></Box>
                {o.paid !== undefined && o.remaining !== undefined && (
                  <>
                    <Box><Typography variant="caption" color="text.secondary">{t('Paid')}</Typography><Typography variant="h6">{formatMoney(o.paid)}</Typography></Box>
                    <Box><Typography variant="caption" color="text.secondary">{t('Still to pay')}</Typography><Typography variant="h6" color={o.remaining > 0 ? 'warning.main' : 'success.main'}>{formatMoney(o.remaining)}</Typography></Box>
                  </>
                )}
                <Box sx={{ flexGrow: 1 }} />
                <Button startIcon={<PictureAsPdfIcon />} component="a" href={`/api/v1/portal/offers/${o.id}/pdf`} target="_blank" rel="noopener">{t('Print the plan (PDF)')}</Button>
              </Box>
            </Paper>
          ))}
        </Stack>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------------------------------
type PaymentSort = 'date' | 'plan' | 'method' | 'amount' | 'remaining';

export function PortalPaymentsPage() {
  const { t } = useTranslation();
  const { data, error, isLoading } = useGetPortalPaymentsQuery();
  const sort = useSort<PaymentSort>('date', 'desc');
  const value: Record<PaymentSort, (p: NonNullable<typeof data>[number]) => string | number | null> = {
    date: (p) => p.date, plan: (p) => p.offerTitle, method: (p) => (p.method ? t(METHOD_LABEL[p.method as keyof typeof METHOD_LABEL] ?? p.method) : null), amount: (p) => p.amount, remaining: (p) => p.remaining,
  };
  const rows = sortRows(data ?? [], value[sort.key], sort.order);
  return (
    <>
      <PageHeader title={t('My payments')} subtitle={t('Every payment you made at the clinic, with a receipt.')} />
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {isLoading ? <Loading /> : rows.length === 0 ? <Empty>{t('You have no payments yet.')}</Empty> : (
        <TableContainer component={Paper}>
          <Table aria-label={t('My payments')}>
            <TableHead>
              <TableRow>
                <SortCell field="date" sort={sort}>{t('Date')}</SortCell>
                <SortCell field="plan" sort={sort}>{t('Treatment plan')}</SortCell>
                <SortCell field="method" sort={sort}>{t('Method')}</SortCell>
                <SortCell field="amount" sort={sort} align="right">{t('Amount')}</SortCell>
                <SortCell field="remaining" sort={sort} align="right">{t('Still to pay after')}</SortCell>
                <TableCell align="right">{t('Actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(p.date)}</TableCell>
                  <TableCell>{p.offerTitle ?? '—'}</TableCell>
                  <TableCell>{p.method ? t(METHOD_LABEL[p.method as keyof typeof METHOD_LABEL] ?? p.method) : '—'}</TableCell>
                  <TableCell align="right">{formatMoney(p.amount)}</TableCell>
                  <TableCell align="right">{formatMoney(p.remaining)}</TableCell>
                  <TableCell align="right">
                    <Button size="small" startIcon={<PictureAsPdfIcon />} component="a" href={`/api/v1/portal/payments/${p.id}/receipt`} target="_blank" rel="noopener" aria-label={t('Receipt of the payment of {{amount}}', { amount: formatMoney(p.amount) })}>
                      {t('Receipt')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  );
}

/** The preview of a shared picture; an icon for a PDF, or when no preview could be made. */
function Thumb({ id, isImage }: { id: number; isImage: boolean }) {
  const [broken, setBroken] = useState(false);
  if (!isImage) return <PictureAsPdfIcon color="action" sx={{ fontSize: 48 }} />;
  if (broken) return <ImageIcon color="action" sx={{ fontSize: 48 }} />;
  return <Box component="img" src={`/api/v1/portal/documents/${id}/thumbnail`} alt="" loading="lazy" onError={() => setBroken(true)} sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Documents the clinic shared
// ---------------------------------------------------------------------------------------------------------------------
export function PortalDocumentsPage() {
  const { t } = useTranslation();
  const { data, error, isLoading } = useGetPortalDocumentsQuery();
  return (
    <>
      <PageHeader title={t('My documents')} subtitle={t('X-rays, reports and tests that the clinic has shared with you.')} />
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {isLoading ? <Loading /> : (data ?? []).length === 0 ? <Empty>{t('Nothing has been shared with you yet.')}</Empty> : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' }, gap: 2 }}>
          {(data ?? []).map((d) => (
            <Paper key={d.id} component="article" aria-label={d.title} sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ height: 140, display: 'grid', placeItems: 'center', bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden' }}>
                <Thumb id={d.id} isImage={d.isImage} />
              </Box>
              <Typography fontWeight={700} sx={{ overflowWrap: 'anywhere' }}>{d.title}</Typography>
              <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={t(DOCUMENT_CATEGORY_LABEL[d.category])} />
                <Typography variant="caption" color="text.secondary">{d.takenOn ? formatDate(d.takenOn) : ''} · <bdi dir="ltr">{formatBytes(d.sizeBytes)}</bdi></Typography>
              </Stack>
              <Button component="a" href={`/api/v1/portal/documents/${d.id}/file`} target="_blank" rel="noopener" startIcon={<OpenInNewIcon />} aria-label={t('Open {{title}}', { title: d.title })} sx={{ alignSelf: 'flex-start' }}>{t('Open')}</Button>
            </Paper>
          ))}
        </Box>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------------------------------
function Field({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography sx={{ overflowWrap: 'anywhere' }}>{children || '—'}</Typography>
    </Box>
  );
}

export function PortalProfilePage() {
  const { t } = useTranslation();
  const { data: patient, error, isLoading } = useGetMyPatientQuery();
  const { data: overview } = useGetPortalOverviewQuery();
  const doctor = overview?.patient.doctor;
  return (
    <>
      <PageHeader title={t('My profile')} subtitle={t('Your details as the clinic has them. To change any of them, please tell the clinic.')} />
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {isLoading || !patient ? <Loading /> : (
        <Paper sx={{ p: { xs: 2, sm: 3 }, maxWidth: 720 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2 }}>
            <Field label={t('Name')}>{fullName(patient)}</Field>
            <Field label={t('Patient number')}><bdi dir="ltr">{patient.patientIdentifier}</bdi></Field>
            <Field label={t('Username')}>{patient.username && <bdi dir="ltr">{patient.username}</bdi>}</Field>
            <Field label={t('Primary doctor')}>{doctor ? `${doctor.fname} ${doctor.lname}` : ''}</Field>
            <Field label={t('Phone')}><bdi dir="ltr">{patient.phone}</bdi></Field>
            <Field label={t('Email')}>{patient.email && <bdi dir="ltr">{patient.email}</bdi>}</Field>
            <Field label={t('Date of birth')}>{patient.dateOfBirth ? formatDate(patient.dateOfBirth) : ''}</Field>
            <Field label={t('Gender')}>{patient.gender ? <span style={{ textTransform: 'capitalize' }}>{t(patient.gender)}</span> : ''}</Field>
            <Field label={t('Address')}>{patient.address}</Field>
          </Box>
          <Button component={RouterLink} to="/change-password" variant="outlined" sx={{ mt: 3 }}>{t('Change my password')}</Button>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('Forgot your password? Please ask the clinic for a new patient card.')}</Typography>
        </Paper>
      )}
    </>
  );
}
