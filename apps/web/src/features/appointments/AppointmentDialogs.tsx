import { useCallback, useState, type ReactNode } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import type { AppointmentDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { StatusChip } from '../../components/StatusChip';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import {
  useAppointmentActionMutation, useDeleteAppointmentMutation, useDeleteReportMutation, useGetAppointmentQuery, useGetConfigQuery, useGetReportQuery,
} from '../clinical/clinicalApi';
import { ReportDialog } from '../visits/ReportDialog';
import { ReportView } from '../visits/ReportView';
import { PlanDialog } from './PlanDialog';
import { AppointmentFormDialog, durationLabel, type FormDefaults } from './AppointmentFormDialog';
import { TimeText } from '../../lib/useTime';

type Action = 'confirm' | 'cancel' | 'complete' | 'no-show';

/** The visit report of an appointment: shown to whoever may read it, editable by the treating doctor and admins. */
function ReportSection({ a }: { a: AppointmentDto }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGetReportQuery(a.id);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeReport, removeState] = useDeleteReportMutation();
  const { role } = useRole();
  const treated = a.status !== 'cancelled' && a.status !== 'no_show' && a.clinicId !== null; // a deleted clinic's report is read-only

  if (isLoading) return <CircularProgress size={20} aria-label={t('Loading report')} />;
  if (error || !data) return <Typography variant="body2" color="text.secondary">{t("The visit report isn't available to you.")}</Typography>;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle1" component="h3" sx={{ flexGrow: 1 }}>{t('Visit report')}</Typography>
        {data.canEdit && treated && (
          <Button size="small" variant={data.report ? 'text' : 'contained'} onClick={() => setEditing(true)}>
            {data.report ? t('Edit report') : t('Write report')}
          </Button>
        )}
        {data.report && (data.canEdit || role === 'staff') && (
          <Button size="small" color="error" onClick={() => setRemoving(true)}>{t('Delete report')}</Button>
        )}
      </Box>
      {data.report ? (
        <ReportView report={data.report} appointmentId={a.id} />
      ) : (
        <Typography variant="body2" color="text.secondary">
          {treated ? t('No report has been written for this visit.') : t('There is no visit to report on.')}
        </Typography>
      )}
      <ConfirmDialog
        open={removing} destructive title={t('Delete this report?')}
        message={t('The report goes to the Trash. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete report')} busy={removeState.isLoading} onClose={() => setRemoving(false)}
        onConfirm={async () => { await removeReport(a.id); setRemoving(false); }}
      />
      {removeState.error != null && <Alert severity="error" sx={{ mt: 1 }}>{errorMessage(removeState.error)}</Alert>}
      <ReportDialog open={editing} onClose={() => setEditing(false)} appointment={a} report={data.report} />
    </Box>
  );
}

function Detail({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (a: AppointmentDto) => void }) {
  const { t } = useTranslation();
  const { canComplete, role, isSpecialist, doctorId } = useRole();
  const { data: a, isLoading, error } = useGetAppointmentQuery(id);
  const { data: config } = useGetConfigQuery();
  const [run, { isLoading: acting, error: actionError, reset }] = useAppointmentActionMutation();
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [planning, setPlanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [remove, removeState] = useDeleteAppointmentMutation();
  const staff = role !== 'patient';

  const confirmText: Partial<Record<Action, { title: string; message: string; label: string }>> = {
    cancel: { title: t('Cancel this appointment?'), message: t('The time slot will be freed. This cannot be undone.'), label: t('Cancel appointment') },
    'no-show': { title: t('Mark as no-show?'), message: t('Use this when the patient did not come.'), label: t('Mark as no-show') },
  };

  const act = async (action: Action) => {
    setConfirming(null);
    reset();
    await run({ id, action });
  };

  const started = !!a && !!config && a.date <= config.today;
  const open = !!a && (a.status === 'pending' || a.status === 'confirmed');
  // A specialist manages only his own patients' appointments that he treats himself. For another
  // doctor's patient he sees the appointment and writes the report, nothing more.
  // The clinic was deleted: the appointment stays for the records (payments, commission, tax) but cannot be changed.
  const locked = !!a && a.clinicId === null;
  const canManage = !isSpecialist || (!!a && a.patientVisible && a.doctorId === doctorId);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        {t('Appointment')} {a && <StatusChip status={a.status} />}
      </DialogTitle>
      <DialogContent>
        {isLoading && <CircularProgress aria-label={t('Loading appointment')} />}
        {error && <Alert severity="error">{errorMessage(error)}</Alert>}
        {actionError && (
          <Alert severity="error" sx={{ mb: 2 }} role="alert">
            {errorMessage(actionError)}
          </Alert>
        )}
        {locked && <Alert severity="info" sx={{ mb: 2 }}>{t('This appointment belongs to a deleted clinic. It is kept for the records and can no longer be changed.')}</Alert>}
        {a && (
          <Stack spacing={1.5} divider={<Divider flexItem />}>
            <Box>
              <Typography variant="h6">{formatDate(a.date)}</Typography>
              <Typography>
                <TimeText value={a.time} end={a.endTime} /> ({durationLabel(a.durationMinutes)}) · {a.clinic?.name ?? t('Deleted clinic')}
              </Typography>
              {a.unit && <Typography variant="body2" color="text.secondary">{a.unit.name}</Typography>}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{t('Patient')}</Typography>
              <Typography>
                {staff && a.patientVisible ? (
                  <RouterLink to={`/patients/${a.patientId}`} onClick={onClose}>{fullName(a.patient)}</RouterLink>
                ) : (
                  fullName(a.patient)
                )}
                {a.patient.phone ? <> · <bdi dir="ltr">{a.patient.phone}</bdi></> : ''}
              </Typography>
              {!a.patientVisible && (
                <Typography variant="caption" color="text.secondary">{t("This is another doctor's patient: you can see the visit and write its report only.")}</Typography>
              )}
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">{t('Doctor')}</Typography>
              <Typography>{fullName(a.doctor)}</Typography>
            </Box>
            {a.categories.length > 0 && (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">{t('Procedures')}</Typography>
                <Stack direction="row" gap={0.5} flexWrap="wrap">
                  {a.categories.map((c) => <Chip key={c.id} size="small" label={c.name} />)}
                </Stack>
              </Box>
            )}
            {a.teeth && a.teeth.length > 0 && (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">{t('Teeth')}</Typography>
                <Typography>{a.teeth.map((tooth) => tooth.index).join(', ')}</Typography>
              </Box>
            )}
            {a.intended && (
              <Box>
                <Typography variant="caption" color="text.secondary">{t('Reason / notes')}</Typography>
                <Typography sx={{ whiteSpace: 'pre-wrap' }}>{a.intended}</Typography>
              </Box>
            )}
            <ReportSection a={a} />
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: 3, pb: 2 }}>
        {a && open && role !== 'patient' && canManage && !locked && (
          <>
            {a.status === 'pending' && <Button variant="contained" disabled={acting} onClick={() => act('confirm')}>{t('Confirm')}</Button>}
            {a.status === 'confirmed' && canComplete && (
              <Button variant="contained" color="success" disabled={acting || !started} title={started ? undefined : t("This appointment hasn't happened yet")} onClick={() => act('complete')}>
                {t('Complete visit')}
              </Button>
            )}
            {a.status === 'confirmed' && started && <Button disabled={acting} onClick={() => setConfirming('no-show')}>{t('No-show')}</Button>}
            <Button disabled={acting} onClick={() => onEdit(a)}>{t('Edit / reschedule')}</Button>
          </>
        )}
        {a && staff && canManage && !locked && a.status !== 'cancelled' && a.status !== 'no_show' && (
          <Button disabled={acting} onClick={() => setPlanning(true)}>{canComplete ? t('Procedures & teeth') : t('Procedures')}</Button>
        )}
        {a && open && canManage && !locked && (
          <Button color="error" disabled={acting} onClick={() => setConfirming('cancel')}>{t('Cancel appointment')}</Button>
        )}
        {a && staff && canManage && <Button color="error" disabled={acting} onClick={() => setDeleting(true)}>{t('Delete')}</Button>}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>{t('Close')}</Button>
      </DialogActions>
      <ConfirmDialog
        open={deleting} destructive title={t('Delete this appointment?')}
        message={t('It disappears from the schedule and goes to the Trash, and its time becomes free. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete appointment')} busy={removeState.isLoading} onClose={() => setDeleting(false)}
        onConfirm={async () => { const r = await remove(id); setDeleting(false); if (!r.error) onClose(); }}
      />
      {a && <PlanDialog open={planning} onClose={() => setPlanning(false)} appointment={a} />}
      {confirming && confirmText[confirming] && (
        <ConfirmDialog
          open
          destructive
          title={confirmText[confirming]!.title}
          message={confirmText[confirming]!.message}
          confirmLabel={confirmText[confirming]!.label}
          busy={acting}
          onConfirm={() => act(confirming)}
          onClose={() => setConfirming(null)}
        />
      )}
    </Dialog>
  );
}

/**
 * Owns the appointment detail and booking dialogs so any page can open them:
 *   const { dialogs, openDetail, openCreate } = useAppointmentDialogs();
 */
export function useAppointmentDialogs(): {
  dialogs: ReactNode;
  openDetail: (id: number) => void;
  openCreate: (defaults?: FormDefaults) => void;
} {
  const [detailId, setDetailId] = useState<number | null>(null);
  const [form, setForm] = useState<{ appointment?: AppointmentDto; defaults?: FormDefaults } | null>(null);

  const openDetail = useCallback((id: number) => setDetailId(id), []);
  const openCreate = useCallback((defaults?: FormDefaults) => setForm({ defaults }), []);

  const dialogs = (
    <>
      {detailId !== null && (
        <Detail
          id={detailId}
          onClose={() => setDetailId(null)}
          onEdit={(appointment) => {
            setDetailId(null);
            setForm({ appointment });
          }}
        />
      )}
      <AppointmentFormDialog
        open={!!form}
        onClose={() => setForm(null)}
        appointment={form?.appointment}
        defaults={form?.defaults}
        onSaved={(a) => setDetailId(a.id)}
      />
    </>
  );
  return { dialogs, openDetail, openCreate };
}
