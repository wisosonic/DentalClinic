import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { BackToPatientButton } from '../../components/BackToPatientButton';
import { PageHeader } from '../../components/PageHeader';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { useAppointmentDialogs } from '../appointments/AppointmentDialogs';
import { useGetConfigQuery, useGetPatientQuery, useGetTimelineQuery } from '../clinical/clinicalApi';
import { DocumentsSection } from '../documents/DocumentsSection';
import { FamilySection } from './FamilySection';
import { Timeline } from '../visits/Timeline';

/** The frame the patient's own pages share: the patient's name under the title, and a way back to the patient. */
function PatientPageFrame({ title, actions, children }: { title: string; actions?: ReactNode; children: (patient: { id: number; fname: string; lname: string }) => ReactNode }) {
  const { t } = useTranslation();
  const id = Number(useParams().id);
  const { data: patient, isLoading, error } = useGetPatientQuery(id, { skip: !Number.isInteger(id) });

  if (isLoading) return <CircularProgress aria-label={t('Loading patient')} />;
  if (error || !patient) {
    return (
      <>
        <Alert severity="error" sx={{ mb: 2 }}>{error ? errorMessage(error, 'Patient not found') : t('Patient not found')}</Alert>
        <Button component={RouterLink} to="/patients">{t('Back to patients')}</Button>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={title} subtitle={fullName(patient)}
        actions={(
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <BackToPatientButton patientId={patient.id} />
            {actions}
          </Box>
        )}
      />
      {children(patient)}
    </>
  );
}

/** The patient's documents (x-ray, panoramic, CBCT report, blood analysis...), on a page of their own. */
export function PatientDocumentsPage() {
  const { t } = useTranslation();
  const { data: config } = useGetConfigQuery();
  const [adding, setAdding] = useState(false);
  return (
    <PatientPageFrame title={t('Documents')} actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>{t('Add documents')}</Button>}>
      {(p) => <DocumentsSection patientId={p.id} today={config?.today ?? ''} showTitle={false} adding={adding} onAddingChange={setAdding} />}
    </PatientPageFrame>
  );
}

/** The patient's family: who is linked to them, how, and a way to their pages. */
export function PatientFamilyPage() {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  return (
    <PatientPageFrame title={t('Family')} actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>{t('Link a family member')}</Button>}>
      {(p) => <FamilySection patient={p} adding={adding} onAddingChange={setAdding} />}
    </PatientPageFrame>
  );
}

/** The patient's appointments, each with its report, newest first, on a page of their own. */
export function PatientAppointmentsPage() {
  const { t } = useTranslation();
  return <PatientPageFrame title={t('Appointments and reports')}>{(p) => <History patientId={p.id} />}</PatientPageFrame>;
}

function History({ patientId }: { patientId: number }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(50);
  const { data: timeline, error } = useGetTimelineQuery({ patientId, pageSize: limit });
  const { dialogs, openDetail } = useAppointmentDialogs();

  return (
    <>
      {error ? (
        <Alert severity="error">{errorMessage(error)}</Alert>
      ) : (
        <>
          <Timeline entries={timeline?.data ?? []} onOpenAppointment={openDetail} emptyText={t('No appointments yet.')} />
          {timeline && timeline.data.length < timeline.meta.total && (
            <Button onClick={() => setLimit((n) => Math.min(n + 50, 200))} sx={{ mt: 1 }}>{t('Show older appointments')}</Button>
          )}
        </>
      )}
      {dialogs}
    </>
  );
}
