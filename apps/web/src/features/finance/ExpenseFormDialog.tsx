import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { EXPENSE_TYPES, expenseInputSchema, type ExpenseDto } from '@aya/shared';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { EXPENSE_TYPE_LABEL } from '../../lib/money';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useGetConfigQuery, useGetDoctorsQuery } from '../clinical/clinicalApi';
import {
  useCommissionAppointmentsQuery, useCreateExpenseMutation, useLabsQuery, useSuppliersQuery, useUpdateExpenseMutation,
} from './financeApi';
import { useTimeFormat } from '../../lib/useTime';

/** One expense. What else must be filled in depends on its type: a lab, a supplier, or a specialist (and, optionally, the visit). */
export function ExpenseFormDialog({ open, onClose, expense }: { open: boolean; onClose: () => void; expense?: ExpenseDto }) {
  const { t } = useTranslation();
  const fmtTime = useTimeFormat();
  const { isAdmin } = useRole();
  const editing = !!expense;
  const { data: config } = useGetConfigQuery();
  const { data: labs = [] } = useLabsQuery(undefined, { skip: !open });
  const { data: suppliers = [] } = useSuppliersQuery(undefined, { skip: !open });
  const { data: doctors = [] } = useGetDoctorsQuery(undefined, { skip: !open });
  const [create, createState] = useCreateExpenseMutation();
  const [update, updateState] = useUpdateExpenseMutation();
  const busy = createState.isLoading || updateState.isLoading;

  const [type, setType] = useState('clinic');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [labId, setLabId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [appointmentId, setAppointmentId] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const { data: visits = [] } = useCommissionAppointmentsQuery(Number(doctorId), { skip: !open || type !== 'commission' || !doctorId });
  const specialists = doctors.filter((d) => d.kind === 'external');

  useEffect(() => {
    if (!open) return;
    createState.reset();
    updateState.reset();
    setErrors({});
    setType(expense?.type ?? 'clinic');
    setDate(expense?.date ?? config?.today ?? '');
    setAmount(expense ? String(expense.amount) : '');
    setDescription(expense?.description ?? '');
    setLabId(expense?.lab ? String(expense.lab.id) : '');
    setSupplierId(expense?.supplier ? String(expense.supplier.id) : '');
    setDoctorId(expense?.doctor ? String(expense.doctor.id) : '');
    setAppointmentId(expense?.appointment ? String(expense.appointment.id) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense]);
  useEffect(() => { if (open && !expense && !date && config) setDate(config.today); }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const { data, errors: found } = validate(expenseInputSchema, {
      type, date, amount, description,
      labId: type === 'lab' ? Number(labId) || null : null,
      supplierId: type === 'supplier' ? Number(supplierId) || null : null,
      doctorId: type === 'commission' ? Number(doctorId) || null : null,
      appointmentId: type === 'commission' ? Number(appointmentId) || null : null,
    });
    if (!data) return setErrors(found!);
    const result = editing ? await update({ id: expense!.id, body: data }) : await create(data);
    if (!('error' in result && result.error)) onClose();
  };

  const error = createState.error ?? updateState.error;
  const field = (key: string) => ({ error: !!errors[key], helperText: errors[key] || undefined });
  const clear = (key: string) => setErrors((x) => ({ ...x, [key]: '' }));
  const types = EXPENSE_TYPES.filter((x) => isAdmin || x !== 'personal');

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? t('Edit expense') : t('New expense')}</DialogTitle>
      <DialogContent>
        {error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(error)}</Alert>}
        <TextField select label={t('Type')} value={type} onChange={(e) => { setType(e.target.value); setErrors({}); }} {...field('type')}>
          {types.map((x) => <MenuItem key={x} value={x}>{t(EXPENSE_TYPE_LABEL[x])}</MenuItem>)}
        </TextField>
        {type === 'lab' && (
          <TextField select label={t('Lab')} value={labId} required onChange={(e) => { setLabId(e.target.value); clear('labId'); }} {...field('labId')}>
            {labs.map((l) => <MenuItem key={l.id} value={String(l.id)}>{l.name}</MenuItem>)}
          </TextField>
        )}
        {type === 'supplier' && (
          <TextField select label={t('Supplier')} value={supplierId} required onChange={(e) => { setSupplierId(e.target.value); clear('supplierId'); }} {...field('supplierId')}>
            {suppliers.map((l) => <MenuItem key={l.id} value={String(l.id)}>{l.name}</MenuItem>)}
          </TextField>
        )}
        {type === 'commission' && (
          <>
            <TextField
              select label={t('Specialist paid')} value={doctorId} required onChange={(e) => { setDoctorId(e.target.value); setAppointmentId(''); clear('doctorId'); }} {...field('doctorId')}
              helperText={errors.doctorId || t('What an owner doctor pays an outside specialist for treating the owner’s patient')}
            >
              {specialists.map((d) => <MenuItem key={d.id} value={String(d.id)}>{fullName(d)}</MenuItem>)}
            </TextField>
            <TextField
              select label={t('Visit (optional)')} value={appointmentId} disabled={!doctorId} onChange={(e) => { setAppointmentId(e.target.value); clear('appointmentId'); }} {...field('appointmentId')}
              helperText={errors.appointmentId || (doctorId && visits.length === 0 ? t('This specialist has no visit with an owner doctor’s patient.') : undefined)}
            >
              <MenuItem value="">{t('No visit')}</MenuItem>
              {visits.map((v) => <MenuItem key={v.id} value={String(v.id)}>{formatDate(v.date)} · {fmtTime(v.time)} · {fullName(v.patient)}</MenuItem>)}
            </TextField>
          </>
        )}
        <TextField label={t('Date')} type="date" value={date} required onChange={(e) => setDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} {...field('date')} />
        <TextField
          label={t('Amount ($)')} type="number" value={amount} required slotProps={{ htmlInput: { min: 0, step: '0.01', inputMode: 'decimal', dir: 'ltr' } }}
          onChange={(e) => { setAmount(e.target.value); clear('amount'); }} {...field('amount')}
        />
        <TextField label={t('Note (optional)')} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={2} {...field('description')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : editing ? t('Save changes') : t('Add expense')}</Button>
      </DialogActions>
    </Dialog>
  );
}
