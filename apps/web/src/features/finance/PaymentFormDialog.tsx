import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { PAYMENT_METHODS, paymentInputSchema, paymentUpdateSchema, type PatientDto, type PaymentDto } from '@aya/shared';
import { PatientPicker } from '../../components/PatientPicker';
import { errorMessage } from '../../lib/baseQuery';
import { formatMoney, METHOD_LABEL } from '../../lib/money';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useGetConfigQuery } from '../clinical/clinicalApi';
import { useCreatePaymentMutation, useOpenOffersQuery, useUpdatePaymentMutation } from './financeApi';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Recording a payment on this offer. Without it, the dialog first asks for the patient and the offer. */
  offer?: { id: number; title: string; remaining: number };
  /** Changing this payment. */
  payment?: PaymentDto;
}

/** Records a payment, or fixes one. What is still owed is worked out by the server and shown here only as a guide. */
export function PaymentFormDialog({ open, onClose, offer, payment }: Props) {
  const { t } = useTranslation();
  const editing = !!payment;
  const { data: config } = useGetConfigQuery();
  const [create, createState] = useCreatePaymentMutation();
  const [update, updateState] = useUpdatePaymentMutation();
  const busy = createState.isLoading || updateState.isLoading;

  const [patient, setPatient] = useState<PatientDto | null>(null);
  const [offerId, setOfferId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [method, setMethod] = useState('cash');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const { data: open_ = [], isFetching } = useOpenOffersQuery(patient?.id ?? 0, { skip: !open || editing || !!offer || !patient });
  const chosen = offer ?? open_.find((q) => String(q.id) === offerId);

  useEffect(() => {
    if (!open) return;
    createState.reset();
    updateState.reset();
    setErrors({});
    setPatient(null);
    setOfferId('');
    setAmount(payment ? String(payment.amount) : '');
    setDate(payment?.date ?? config?.today ?? '');
    setMethod(payment?.method ?? 'cash');
    setDescription(payment?.description ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payment]);
  useEffect(() => { if (open && !payment && !date && config) setDate(config.today); }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const body = { offerId: offer?.id ?? (Number(offerId) || undefined), amount, date, method, description };
    const { data, errors: found } = editing ? validate(paymentUpdateSchema, { amount, date, method, description }) : validate(paymentInputSchema, body);
    if (!data) return setErrors({ ...found!, ...(found!.offerId ? { offerId: t('Choose a treatment offer') } : {}) });
    const result = editing ? await update({ id: payment!.id, body: data }) : await create(data);
    if (!('error' in result && result.error)) onClose();
  };

  const error = createState.error ?? updateState.error;
  const field = (key: string) => ({ error: !!errors[key], helperText: errors[key] || undefined });

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? t('Edit payment') : t('Record payment')}</DialogTitle>
      <DialogContent>
        {error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(error)}</Alert>}

        {!editing && !offer && (
          <>
            <PatientPicker value={patient} onChange={(p) => { setPatient(p); setOfferId(''); }} autoFocus />
            <TextField
              select label={t('Treatment offer')} value={offerId} required disabled={!patient || isFetching} onChange={(e) => { setOfferId(e.target.value); setErrors((x) => ({ ...x, offerId: '' })); }}
              {...field('offerId')}
              helperText={errors.offerId || (patient && !isFetching && open_.length === 0 ? t('This patient has no treatment offer waiting for a payment.') : undefined)}
            >
              {open_.map((q) => (
                <MenuItem key={q.id} value={String(q.id)}>{q.title} · {t('{{amount}} left', { amount: formatMoney(q.remaining) })}</MenuItem>
              ))}
            </TextField>
          </>
        )}
        {(offer || editing) && (
          <Typography sx={{ mb: 1 }}>
            {offer?.title ?? payment?.offer?.title}
            {chosen && <Typography component="span" color="text.secondary"> · {t('{{amount}} left', { amount: formatMoney(chosen.remaining) })}</Typography>}
          </Typography>
        )}

        <TextField
          label={t('Amount ($)')} type="number" value={amount} required autoFocus={!!offer || editing}
          slotProps={{ htmlInput: { min: 0, step: '0.01', inputMode: 'decimal', dir: 'ltr' } }}
          onChange={(e) => { setAmount(e.target.value); setErrors((x) => ({ ...x, amount: '' })); }}
          {...field('amount')}
          helperText={errors.amount || (chosen && !editing ? t('Still owed {{amount}}', { amount: formatMoney(chosen.remaining) }) : undefined)}
        />
        <TextField label={t('Date')} type="date" value={date} required onChange={(e) => setDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} {...field('date')} />
        <TextField select label={t('Paid by')} value={method} onChange={(e) => setMethod(e.target.value)} {...field('method')}>
          {PAYMENT_METHODS.map((m) => <MenuItem key={m} value={m}>{t(METHOD_LABEL[m])}</MenuItem>)}
        </TextField>
        <TextField label={t('Note (optional)')} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={2} {...field('description')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : editing ? t('Save changes') : t('Record payment')}</Button>
      </DialogActions>
    </Dialog>
  );
}
