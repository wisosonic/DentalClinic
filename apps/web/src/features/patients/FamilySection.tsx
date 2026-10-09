import { useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Link, MenuItem, Paper, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Tooltip, Typography,
} from '@mui/material';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { FAMILY_RELATIONS, familyLinkSchema, type FamilyMemberDto, type FamilyRole, type PatientDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PatientPicker } from '../../components/PatientPicker';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { TimeText } from '../../lib/useTime';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useLinkFamilyMemberMutation, useListFamilyQuery, useUnlinkFamilyMemberMutation } from './familyApi';

/** What a person is to the patient (English text is the translation key). Parent and child appear only when the gender is not known; husband and wife show a spouse whose gender is known. */
export const FAMILY_ROLE_LABEL: Record<FamilyRole, string> = {
  father: 'Father', mother: 'Mother', son: 'Son', daughter: 'Daughter', sibling: 'Sibling', spouse: 'Spouse', parent: 'Parent', child: 'Child', husband: 'Husband', wife: 'Wife',
};

type SortKey = 'name' | 'relation' | 'number' | 'phone' | 'dob' | 'lastVisit' | 'next';

/** The people linked to a patient: who they are, how they are related, and their own page one click away. */
export function FamilySection({ patient, adding, onAddingChange }: { patient: Pick<PatientDto, 'id' | 'fname' | 'lname'>; adding: boolean; onAddingChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useListFamilyQuery(patient.id);
  const [unlink, unlinkState] = useUnlinkFamilyMemberMutation();
  const [removing, setRemoving] = useState<FamilyMemberDto | null>(null);
  const sort = useSort<SortKey>('relation');

  const value: Record<SortKey, (m: FamilyMemberDto) => string | number | null> = {
    name: (m) => fullName(m), relation: (m) => t(FAMILY_ROLE_LABEL[m.relation]), number: (m) => m.patientIdentifier, phone: (m) => m.phone, dob: (m) => m.dateOfBirth,
    lastVisit: (m) => m.lastVisit, next: (m) => (m.nextAppointment ? `${m.nextAppointment.date} ${m.nextAppointment.time}` : null),
  };
  const rows = sortRows(data ?? [], value[sort.key], sort.order);

  return (
    <>
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {isLoading ? (
        <Skeleton variant="rounded" height={120} aria-label={t('Loading')} />
      ) : rows.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography sx={{ mb: 1 }}>{t('No family members are linked to this patient yet.')}</Typography>
          <Button variant="contained" onClick={() => onAddingChange(true)}>{t('Link a family member')}</Button>
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small" aria-label={t('Family members')}>
            <TableHead>
              <TableRow>
                <SortCell field="name" sort={sort}>{t('Name')}</SortCell>
                <SortCell field="relation" sort={sort}>{t('Relationship')}</SortCell>
                <SortCell field="number" sort={sort}>{t('Patient number')}</SortCell>
                <SortCell field="phone" sort={sort}>{t('Phone')}</SortCell>
                <SortCell field="dob" sort={sort}>{t('Date of birth')}</SortCell>
                <SortCell field="lastVisit" sort={sort}>{t('Last visit')}</SortCell>
                <SortCell field="next" sort={sort}>{t('Next appointment')}</SortCell>
                <TableCell align="right" sx={{ width: 56 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t('Actions')}</span></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.linkId} hover>
                  <TableCell><Link component={RouterLink} to={`/patients/${m.patientId}`} underline="hover" color="text.primary" sx={{ fontWeight: 600 }}>{fullName(m)}</Link></TableCell>
                  <TableCell>{t(FAMILY_ROLE_LABEL[m.relation])}</TableCell>
                  <TableCell><bdi dir="ltr">{m.patientIdentifier}</bdi></TableCell>
                  <TableCell><bdi dir="ltr">{m.phone}</bdi></TableCell>
                  <TableCell>{m.dateOfBirth ? formatDate(m.dateOfBirth) : '—'}</TableCell>
                  <TableCell>{m.lastVisit ? formatDate(m.lastVisit) : '—'}</TableCell>
                  <TableCell>{m.nextAppointment ? <>{formatDate(m.nextAppointment.date)} <TimeText value={m.nextAppointment.time} /></> : '—'}</TableCell>
                  <TableCell align="right">
                    <Tooltip title={t('Remove the link')}>
                      <IconButton size="small" aria-label={t('Remove the link to {{name}}', { name: fullName(m) })} onClick={() => { unlinkState.reset(); setRemoving(m); }}>
                        <LinkOffIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ConfirmDialog
        open={!!removing} destructive title={t('Remove this family link?')}
        message={removing ? t('{{name}} will no longer be listed as a family member of {{patient}}. Neither patient’s record is deleted.', { name: fullName(removing), patient: fullName(patient) }) : ''}
        confirmLabel={t('Remove the link')} busy={unlinkState.isLoading} onClose={() => setRemoving(null)}
        onConfirm={async () => { const r = await unlink({ patientId: patient.id, linkId: removing!.linkId }); if (!('error' in r && r.error)) setRemoving(null); }}
      />
      {unlinkState.error != null && !removing && <Alert severity="error" sx={{ mt: 2 }}>{errorMessage(unlinkState.error)}</Alert>}
      <LinkFamilyDialog open={adding} patient={patient} onClose={() => onAddingChange(false)} />
    </>
  );
}

function LinkFamilyDialog({ open, patient, onClose }: { open: boolean; patient: Pick<PatientDto, 'id' | 'fname' | 'lname'>; onClose: () => void }) {
  const { t } = useTranslation();
  const [link, state] = useLinkFamilyMemberMutation();
  const [relative, setRelative] = useState<PatientDto | null>(null);
  const [relation, setRelation] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const close = () => { if (state.isLoading) return; setRelative(null); setRelation(''); setErrors({}); state.reset(); onClose(); };
  const submit = async () => {
    const { data: body, errors: found } = validate(familyLinkSchema, { relativeId: relative?.id, relation });
    if (!body) return setErrors(found!);
    if (body.relativeId === patient.id) return setErrors({ relativeId: t('Choose a different patient') });
    setErrors({});
    const result = await link({ patientId: patient.id, body });
    if (result.data) close();
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <DialogTitle>{t('Link a family member')}</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary" sx={{ mb: 2 }}>{t('Choose the relative, then say what they are to {{name}}.', { name: fullName(patient) })}</Typography>
        {state.error != null && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{errorMessage(state.error)}</Alert>}
        <Box sx={{ display: 'grid', gap: 2 }}>
          <PatientPicker label={t('Relative')} value={relative} onChange={(p) => { setRelative(p); setErrors((e) => ({ ...e, relativeId: '' })); }} error={!!errors.relativeId} helperText={errors.relativeId} autoFocus />
          <TextField
            select required label={t('They are {{name}}’s', { name: fullName(patient) })} value={relation} onChange={(e) => { setRelation(e.target.value); setErrors((er) => ({ ...er, relation: '' })); }}
            error={!!errors.relation} helperText={errors.relation || t('For example: Father means the relative is the patient’s father. Spouse is shown as husband or wife.')}
          >
            {FAMILY_RELATIONS.map((r) => <MenuItem key={r} value={r}>{t(FAMILY_ROLE_LABEL[r])}</MenuItem>)}
          </TextField>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={state.isLoading}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={state.isLoading}>{state.isLoading ? t('Saving…') : t('Link')}</Button>
      </DialogActions>
    </Dialog>
  );
}
