import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { labOrderInputSchema, type LabOrderDto, type PatientDto } from '@aya/shared';
import { PatientPicker } from '../../components/PatientPicker';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useGetTeethQuery } from '../clinical/clinicalApi';
import { useLabsQuery } from '../finance/financeApi';
import { useCreateLabOrderMutation, useUpdateLabOrderMutation } from './labsApi';

/** One lab order: what is sent to which lab for which patient, what it costs the clinic and when it is due. */
export function LabOrderFormDialog({
  open, onClose, order, patient: preset,
}: { open: boolean; onClose: () => void; order?: LabOrderDto; patient?: PatientDto }) {
  const { t } = useTranslation();
  const editing = !!order;
  const { data: labs = [] } = useLabsQuery(undefined, { skip: !open });
  const { data: teeth = [] } = useGetTeethQuery(undefined, { skip: !open });
  const [create, createState] = useCreateLabOrderMutation();
  const [update, updateState] = useUpdateLabOrderMutation();
  const busy = createState.isLoading || updateState.isLoading;

  const [patient, setPatient] = useState<PatientDto | null>(null);
  const [labId, setLabId] = useState('');
  const [item, setItem] = useState('');
  const [toothId, setToothId] = useState('');
  const [cost, setCost] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!open) return;
    createState.reset();
    updateState.reset();
    setErrors({});
    setPatient(order ? null : (preset ?? null));
    setLabId(order ? String(order.lab.id) : '');
    setItem(order?.item ?? '');
    setToothId(order?.tooth ? String(order.tooth.id) : '');
    setCost(order?.cost !== undefined ? String(order.cost) : '');
    setDueAt(order?.dueAt ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order]);

  const submit = async () => {
    const values = { labId: Number(labId) || undefined, patientId: order?.patient.id ?? patient?.id, item, toothId: Number(toothId) || null, cost, dueAt };
    const { data, errors: found } = validate(labOrderInputSchema, values);
    if (!data) return setErrors(found!);
    const { patientId: _patientId, ...changes } = data; // the patient of an existing order does not change
    void _patientId;
    const result = editing ? await update({ id: order!.id, body: changes }) : await create(data);
    if (!('error' in result && result.error)) onClose();
  };

  const error = createState.error ?? updateState.error;
  const field = (key: string) => ({ error: !!errors[key], helperText: errors[key] || undefined });
  const clear = (key: string) => setErrors((x) => ({ ...x, [key]: '' }));

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? t('Edit lab order') : t('New lab order')}</DialogTitle>
      <DialogContent>
        {error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(error)}</Alert>}
        {editing ? (
          <TextField label={t('Patient')} value={fullName(order!.patient)} disabled />
        ) : (
          <PatientPicker value={patient} onChange={(p) => { setPatient(p); clear('patientId'); }} error={!!errors.patientId} helperText={errors.patientId && t('Choose a patient')} autoFocus />
        )}
        <TextField select label={t('Lab')} value={labId} required onChange={(e) => { setLabId(e.target.value); clear('labId'); }} {...field('labId')}>
          {labs.map((l) => <MenuItem key={l.id} value={String(l.id)}>{l.name}</MenuItem>)}
        </TextField>
        <TextField label={t('What is ordered')} value={item} required onChange={(e) => { setItem(e.target.value); clear('item'); }} {...field('item')} />
        <TextField select label={t('Tooth (optional)')} value={toothId} onChange={(e) => setToothId(e.target.value)}>
          <MenuItem value="">{t('None')}</MenuItem>
          {teeth.map((x) => <MenuItem key={x.id} value={String(x.id)}>{x.index} · {x.name}</MenuItem>)}
        </TextField>
        <TextField
          label={t('Cost to the clinic ($)')} type="number" value={cost} required slotProps={{ htmlInput: { min: 0, step: '0.01', inputMode: 'decimal', dir: 'ltr' } }}
          onChange={(e) => { setCost(e.target.value); clear('cost'); }} {...field('cost')}
        />
        <TextField label={t('Due date (optional)')} type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} {...field('dueAt')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : editing ? t('Save changes') : t('Add order')}</Button>
      </DialogActions>
    </Dialog>
  );
}
