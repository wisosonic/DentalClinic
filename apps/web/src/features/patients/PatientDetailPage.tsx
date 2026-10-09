import { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import HistoryIcon from '@mui/icons-material/History';
import AssignmentIcon from '@mui/icons-material/Assignment';
import EventNoteIcon from '@mui/icons-material/EventNote';
import FolderIcon from '@mui/icons-material/Folder';
import FamilyRestroomIcon from '@mui/icons-material/FamilyRestroom';
import PaymentsIcon from '@mui/icons-material/Payments';
import ScienceIcon from '@mui/icons-material/Science';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { useAppointmentDialogs } from '../appointments/AppointmentDialogs';
import { useDeletePatientMutation, useGetConfigQuery, useGetDoctorsQuery, useGetPatientCountsQuery, useGetPatientQuery } from '../clinical/clinicalApi';
import { PatientChart } from '../visits/PatientChart';
import { PatientCardDialog } from './PatientCardDialog';
import { PatientFormDialog } from './PatientFormDialog';

function age(dob: string | null, today: string | undefined, years: (n: number) => string): string {
  if (!dob || !today) return '';
  let n = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  if (today.slice(5) < dob.slice(5)) n--;
  return n >= 0 ? ` (${years(n)})` : '';
}

/** A button's words and, once known, how much its page holds (the number is part of its accessible name). */
function counted(label: string, n: number | null | undefined): { 'aria-label'?: string; children: React.ReactNode } {
  if (n == null) return { children: label };
  return {
    'aria-label': `${label} (${n})`,
    children: (
      <>
        {label}
        <Chip aria-hidden size="small" label={n} color={n > 0 ? 'primary' : 'default'} sx={{ marginInlineStart: 0.75, height: 18, minWidth: 22, fontSize: 11, fontWeight: 700, '& .MuiChip-label': { px: 0.75 } }} />
      </>
    ),
  };
}

function Info({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography sx={{ overflowWrap: 'anywhere' }}>{children || '—'}</Typography>
    </Box>
  );
}

export function PatientDetailPage() {
  const { t } = useTranslation();
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { isAdmin, role } = useRole();
  const { data: patient, isLoading, error } = useGetPatientQuery(id, { skip: !Number.isInteger(id) });
  const { data: doctors = [] } = useGetDoctorsQuery();
  const { data: config } = useGetConfigQuery();
  const { data: counts } = useGetPatientCountsQuery(id, { skip: !Number.isInteger(id) || role === 'patient' });
  const [remove, removeState] = useDeletePatientMutation();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const { dialogs, openCreate } = useAppointmentDialogs();

  if (isLoading) return <CircularProgress aria-label={t('Loading patient')} />;
  if (error || !patient) {
    return (
      <>
        <Alert severity="error" sx={{ mb: 2 }}>{error ? errorMessage(error, 'Patient not found') : t('Patient not found')}</Alert>
        <Button component={RouterLink} to="/patients">{t('Back to patients')}</Button>
      </>
    );
  }

  const doctor = doctors.find((d) => d.id === patient.doctorId);
  const today = config?.today ?? '';

  return (
    <>
      <PageHeader
        title={fullName(patient)}
        subtitle={t('Patient #{{number}}', { number: patient.patientIdentifier })}
        actionsBelow
        actions={
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => openCreate({ patient })}>{t('Book appointment')}</Button>
            <Button component={RouterLink} to={`/patients/${patient.id}/appointments`} startIcon={<EventNoteIcon />} {...counted(t('Appointments and reports'), counts?.appointments)} />
            {role !== 'patient' && <Button component={RouterLink} to={`/patients/${patient.id}/family`} startIcon={<FamilyRestroomIcon />} {...counted(t('Family'), counts?.family)} />}
            {role !== 'patient' && <Button component={RouterLink} to={`/patients/${patient.id}/documents`} startIcon={<FolderIcon />} {...counted(t('Documents'), counts?.documents)} />}
            <Button component={RouterLink} to={`/treatment-offers?patientId=${patient.id}`} startIcon={<AssignmentIcon />} {...counted(t('Treatment offers'), counts?.offers)} />
            {role !== 'staff' && <Button component={RouterLink} to={`/payments?patientId=${patient.id}`} startIcon={<PaymentsIcon />} {...counted(t('Payments'), counts?.payments)} />}
            <Button component={RouterLink} to={`/lab-orders?patientId=${patient.id}`} startIcon={<ScienceIcon />}>{t('Lab orders')}</Button>
            {role !== 'patient' && <Button startIcon={<BadgeOutlinedIcon />} onClick={() => setCardOpen(true)}>{t('Patient card')}</Button>}
            <Button startIcon={<EditIcon />} onClick={() => setEditing(true)}>{t('Edit')}</Button>
            {isAdmin && (
              <Tooltip title={t('Who viewed this record')}>
                <IconButton component={RouterLink} to={`/settings/audit?entity=patient&entityId=${patient.id}`} aria-label={t('Who viewed this record')}><HistoryIcon /></IconButton>
              </Tooltip>
            )}
            <Button color="error" startIcon={<DeleteOutlineIcon />} onClick={() => setDeleting(true)}>{t('Delete')}</Button>
          </Stack>
        }
      />

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2 }}>
          <Info label={t('Phone')}><bdi dir="ltr">{patient.phone}</bdi></Info>
          <Info label={t('Email')}>{patient.email && <bdi dir="ltr">{patient.email}</bdi>}</Info>
          <Info label={t('Date of birth')}>
            {patient.dateOfBirth ? `${formatDate(patient.dateOfBirth)}${age(patient.dateOfBirth, today, (n) => t('{{n}} years', { n }))}` : ''}
          </Info>
          <Info label={t('Gender')}>{patient.gender ? <span style={{ textTransform: 'capitalize' }}>{t(patient.gender)}</span> : ''}</Info>
          <Info label={t('Address')}>{patient.address}</Info>
          <Info label={t('Primary doctor')}>{doctor ? fullName(doctor) : ''}</Info>
          <Info label={t('Last visit')}>{formatDate(patient.lastVisit)}</Info>
          <Info label={t('Username')}>{patient.username && <bdi dir="ltr">{patient.username}</bdi>}</Info>
          <Info label={t('Portal account')}>
            {patient.loginState === 'waiting' ? <Chip size="small" color="warning" label={t('First password not changed yet')} />
              : patient.hasAccount ? <Chip size="small" color="success" label={t('Has login')} /> : t('None')}
          </Info>
          {patient.description && (
            <Box sx={{ gridColumn: '1 / -1' }}>
              <Typography variant="caption" color="text.secondary" display="block">{t('Internal notes')}</Typography>
              <Typography sx={{ whiteSpace: 'pre-wrap' }}>{patient.description}</Typography>
            </Box>
          )}
        </Box>
      </Paper>

      {role !== 'patient' && (
        <>
          <Typography variant="h6" component="h2" gutterBottom>{t('Dental chart')}</Typography>
          <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
            <PatientChart patientId={id} />
          </Paper>
        </>
      )}


      <PatientCardDialog open={cardOpen} onClose={() => setCardOpen(false)} patient={patient} />
      <PatientFormDialog open={editing} onClose={() => setEditing(false)} patient={patient} />
      <ConfirmDialog
        open={deleting}
        destructive
        title={t('Delete {{name}}?', { name: fullName(patient) })}
        message={t('The patient disappears from lists and the schedule and goes to the Trash. Only an administrator can restore them or erase them for good.')}
        confirmLabel={t('Delete patient')}
        busy={removeState.isLoading}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          const result = await remove(id);
          if (!result.error) navigate('/patients', { replace: true });
        }}
      />
      {removeState.error && <Alert severity="error" sx={{ mt: 2 }}>{errorMessage(removeState.error)}</Alert>}
      {dialogs}
    </>
  );
}
