import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { GENDERS, patientInputSchema, type PatientDto } from '@aya/shared';
import { useRole } from '../../components/useRole';
import { errorCode, errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useCreatePatientMutation, useGetDoctorsQuery, useUpdatePatientMutation } from '../clinical/clinicalApi';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Omit to create a new patient. */
  patient?: PatientDto;
  onSaved?: (patient: PatientDto) => void;
}

const empty = { fname: '', lname: '', phone: '', dateOfBirth: '', gender: '', email: '', address: '', description: '', doctorId: '' };

const fromPatient = (p?: PatientDto) =>
  p
    ? {
        fname: p.fname, lname: p.lname, phone: p.phone, dateOfBirth: p.dateOfBirth ?? '', gender: p.gender ?? '',
        email: p.email ?? '', address: p.address ?? '', description: p.description ?? '', doctorId: p.doctorId ? String(p.doctorId) : '',
      }
    : empty;

export function PatientFormDialog({ open, onClose, patient, onSaved }: Props) {
  const { t } = useTranslation();
  const { isSpecialist } = useRole();
  const [values, setValues] = useState(fromPatient(patient));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [duplicate, setDuplicate] = useState(false);
  const { data: doctors = [] } = useGetDoctorsQuery(undefined, { skip: !open || isSpecialist });
  const [create, createState] = useCreatePatientMutation();
  const [update, updateState] = useUpdatePatientMutation();
  const busy = createState.isLoading || updateState.isLoading;
  const serverError = createState.error ?? updateState.error;

  useEffect(() => {
    if (open) {
      setValues(fromPatient(patient));
      setErrors({});
      setDuplicate(false);
      createState.reset();
      updateState.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, patient]);

  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((er) => ({ ...er, [key]: '' }));
  };

  const submit = async (allowDuplicate = false) => {
    // A specialist's patients are always his own, so the doctor isn't his to choose (the server enforces it).
    const { doctorId: chosen, ...rest } = values;
    const payload = isSpecialist ? rest : { ...rest, doctorId: chosen ? Number(chosen) : null };
    const { data, errors: found } = validate(patientInputSchema, payload);
    if (!data) return setErrors(found!);
    // A new patient needs a primary doctor (an older patient without one can still be edited).
    if (!patient && !isSpecialist && !chosen) return setErrors({ doctorId: t('Choose the primary doctor') });

    const result = patient
      ? await update({ id: patient.id, body: data })
      : await create({ body: data, allowDuplicate });
    if (result.data) {
      onSaved?.(result.data);
      onClose();
    } else if (errorCode(result.error) === 'DUPLICATE_PATIENT') {
      setDuplicate(true);
    }
  };

  const field = (key: keyof typeof empty, label: string, extra: object = {}) => (
    <TextField
      label={label}
      value={values[key]}
      onChange={set(key)}
      error={!!errors[key]}
      helperText={errors[key] || undefined}
      {...extra}
    />
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{patient ? t('Edit {{name}}', { name: fullName(patient) }) : t('New patient')}</DialogTitle>
      <DialogContent>
        {serverError && !duplicate && (
          <Alert severity="error" sx={{ mb: 1 }} role="alert">
            {errorMessage(serverError)}
          </Alert>
        )}
        {duplicate && (
          <Alert
            severity="warning"
            sx={{ mb: 1 }}
            action={
              <Button color="inherit" size="small" onClick={() => submit(true)} disabled={busy}>
                {t('Create anyway')}
              </Button>
            }
          >
            {t('A patient with this name and phone number already exists.')}
          </Alert>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: 16 }}>
          {field('fname', t('First name'), { autoFocus: true, required: true })}
          {field('lname', t('Last name'), { required: true })}
          {field('phone', t('Phone'), { required: true, type: 'tel', autoComplete: 'off', slotProps: { htmlInput: { dir: 'ltr' } } })}
          {field('email', t('Email'), { type: 'email', slotProps: { htmlInput: { dir: 'ltr' } } })}
          {field('dateOfBirth', t('Date of birth'), { type: 'date', InputLabelProps: { shrink: true } })}
          {field('gender', t('Gender'), {
            select: true,
            children: [
              <MenuItem key="" value="">
                {t('Not set')}
              </MenuItem>,
              ...GENDERS.map((g) => (
                <MenuItem key={g} value={g}>
                  {t(g)}
                </MenuItem>
              )),
            ],
          })}
        </div>
        {field('address', t('Address'))}
        {!isSpecialist &&
          field('doctorId', t('Primary doctor'), {
            select: true,
            required: !patient,
            children: [
              // Only an older patient who has no doctor yet can be left without one.
              ...(patient && !patient.doctorId ? [<MenuItem key="" value="">{t('None')}</MenuItem>] : []),
              ...doctors.map((d) => (
                <MenuItem key={d.id} value={String(d.id)}>
                  {fullName(d)}
                </MenuItem>
              )),
            ],
          })}
        {field('description', t('Internal notes'), { multiline: true, minRows: 2, helperText: errors.description || t('Visible to clinic staff only') })}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t('Cancel')}
        </Button>
        <Button variant="contained" onClick={() => submit()} disabled={busy}>
          {busy ? t('Saving…') : t('Save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
