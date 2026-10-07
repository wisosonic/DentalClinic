import { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { PatientDto, WaitingCandidateDto, WaitingTicketDto } from '@aya/shared';
import { PatientPicker } from '../../components/PatientPicker';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { useGetDoctorsQuery, useGetUnitsQuery } from '../clinical/clinicalApi';
import { useCheckInWaitingMutation, useGetWaitingCandidatesQuery } from './waitingApi';
import { TimeText } from '../../lib/useTime';

/**
 * At the desk: give the patient who has just arrived a number. For someone expected today, one click (the doctor and
 * dental unit come from the appointment); for anyone else, choose the patient, the doctor and the dental unit. The number
 * is then shown large, to read out or write down.
 */
export function CheckInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: candidates = [] } = useGetWaitingCandidatesQuery(undefined, { skip: !open });
  const { data: doctors = [] } = useGetDoctorsQuery(undefined, { skip: !open });
  const { data: units = [] } = useGetUnitsQuery(undefined, { skip: !open });
  const [checkIn, state] = useCheckInWaitingMutation();
  const [patient, setPatient] = useState<PatientDto | null>(null);
  const [doctorId, setDoctorId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [problem, setProblem] = useState('');
  const [given, setGiven] = useState<WaitingTicketDto | null>(null);

  useEffect(() => {
    if (open) { setPatient(null); setDoctorId(''); setUnitId(''); setProblem(''); setGiven(null); state.reset(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Choosing a doctor suggests his own dental unit.
  const pickDoctor = (id: string) => {
    setDoctorId(id);
    setProblem('');
    const own = units.find((u) => String(u.ownerDoctorId) === id);
    if (own) setUnitId(String(own.id));
  };

  const forAppointment = async (c: WaitingCandidateDto) => {
    const result = await checkIn({ patientId: c.patient.id, appointmentId: c.appointmentId });
    if (result.data) setGiven(result.data);
  };
  const forOther = async () => {
    if (!patient) return setProblem(t('Choose a patient'));
    if (!doctorId || !unitId) return setProblem(t('Choose the doctor and the dental unit'));
    const result = await checkIn({ patientId: patient.id, doctorId: Number(doctorId), unitId: Number(unitId) });
    if (result.data) setGiven(result.data);
  };

  return (
    <Dialog open={open} onClose={state.isLoading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('Give a number')}</DialogTitle>
      <DialogContent>
        {given ? (
          <Box sx={{ textAlign: 'center', py: 2 }} role="status">
            <Typography color="text.secondary">{t('{{name}} has number', { name: fullName(given.patient) })}</Typography>
            <Typography sx={{ fontSize: '6rem', fontWeight: 900, lineHeight: 1.1 }} color="primary" aria-label={t('Number {{n}}', { n: given.label })}>{given.label}</Typography>
            <Typography>{t('Dr. {{name}}', { name: fullName(given.doctor) })}{given.unit ? ` · ${given.unit.name}` : ''}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('Ask them to wait for this number on the screen.')}</Typography>
          </Box>
        ) : (
          <>
            {state.error != null && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{errorMessage(state.error)}</Alert>}
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700, mb: 1 }}>{t('Expected today')}</Typography>
            {candidates.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t('Nobody else is expected today without a number.')}</Typography>
            ) : (
              <Stack spacing={1}>
                {candidates.map((c) => (
                  <Paper key={c.appointmentId} variant="outlined" sx={{ p: 1.25, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                    <Typography sx={{ fontWeight: 700, minWidth: 48 }}><TimeText value={c.time} /></Typography>
                    <Box sx={{ flexGrow: 1, minWidth: 160 }}>
                      <Typography>{fullName(c.patient)}</Typography>
                      <Typography variant="caption" color="text.secondary">{t('Dr. {{name}}', { name: fullName(c.doctor) })}{c.unit ? ` · ${c.unit.name}` : ''}</Typography>
                    </Box>
                    <Button variant="contained" size="small" disabled={state.isLoading} onClick={() => forAppointment(c)} aria-label={t('Give a number to {{name}}', { name: fullName(c.patient) })}>{t('Give a number')}</Button>
                  </Paper>
                ))}
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700, mb: 0.5 }}>{t('Someone else')}</Typography>
            <PatientPicker value={patient} onChange={(p) => { setPatient(p); setProblem(''); }} label={t('Patient')} />
            <TextField select label={t('Doctor')} value={doctorId} onChange={(e) => pickDoctor(e.target.value)}>
              {doctors.map((d) => <MenuItem key={d.id} value={String(d.id)}>{t('Dr. {{name}}', { name: fullName(d) })}</MenuItem>)}
            </TextField>
            <TextField select label={t('Dental unit')} value={unitId} onChange={(e) => { setUnitId(e.target.value); setProblem(''); }}>
              {units.filter((u) => u.clinicId !== null).map((u) => <MenuItem key={u.id} value={String(u.id)}>{u.name}</MenuItem>)}
            </TextField>
            {problem && <Alert severity="error" role="alert" sx={{ mt: 1 }}>{problem}</Alert>}
          </>
        )}
      </DialogContent>
      <DialogActions>
        {given ? (
          <Button variant="contained" onClick={onClose}>{t('Done')}</Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={state.isLoading}>{t('Cancel')}</Button>
            <Button variant="contained" onClick={forOther} disabled={state.isLoading}>{state.isLoading ? t('Saving…') : t('Give a number to this patient')}</Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
