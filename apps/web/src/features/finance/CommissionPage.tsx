import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, Paper, Skeleton, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { PAYMENT_METHODS, commissionPaymentInputSchema, commissionPaymentUpdateSchema, type CommissionPaymentDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { METHOD_LABEL, formatMoney } from '../../lib/money';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useGetConfigQuery, useGetDoctorsQuery } from '../clinical/clinicalApi';
import {
  useCommissionPaymentsQuery, useCommissionStatementQuery, useCreateCommissionPaymentMutation, useDeleteCommissionPaymentMutation, useUpdateCommissionPaymentMutation,
} from './financeApi';

/** What a specialist paid over to an owner: recorded by the owner who received it, or an admin. */
function CommissionPaymentDialog({ open, onClose, payment }: { open: boolean; onClose: () => void; payment?: CommissionPaymentDto }) {
  const { t } = useTranslation();
  const { isAdmin, doctorId } = useRole();
  const editing = !!payment;
  const { data: config } = useGetConfigQuery();
  const { data: doctors = [] } = useGetDoctorsQuery(undefined, { skip: !open });
  const [create, createState] = useCreateCommissionPaymentMutation();
  const [update, updateState] = useUpdateCommissionPaymentMutation();
  const busy = createState.isLoading || updateState.isLoading;

  const [specialistId, setSpecialistId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [method, setMethod] = useState('cash');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!open) return;
    createState.reset();
    updateState.reset();
    setErrors({});
    setSpecialistId(payment?.specialist ? String(payment.specialist.id) : '');
    setOwnerId(payment?.owner ? String(payment.owner.id) : !isAdmin && doctorId ? String(doctorId) : '');
    setAmount(payment ? String(payment.amount) : '');
    setDate(payment?.date ?? config?.today ?? '');
    setMethod(payment?.method ?? 'cash');
    setDescription(payment?.description ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payment]);

  const submit = async () => {
    const { data, errors: found } = editing
      ? validate(commissionPaymentUpdateSchema, { ownerId: Number(ownerId) || undefined, amount, date, method, description })
      : validate(commissionPaymentInputSchema, { specialistId: Number(specialistId) || undefined, ownerId: Number(ownerId) || undefined, amount, date, method, description });
    if (!data) return setErrors({ ...found!, ...(found!.specialistId ? { specialistId: t('Choose the specialist') } : {}), ...(found!.ownerId ? { ownerId: t('Choose the owner') } : {}) });
    const result = editing ? await update({ id: payment!.id, body: data }) : await create(data);
    if (!('error' in result && result.error)) onClose();
  };

  const error = createState.error ?? updateState.error;
  const field = (key: string) => ({ error: !!errors[key], helperText: errors[key] || undefined });
  const clear = (key: string) => setErrors((x) => ({ ...x, [key]: '' }));

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? t('Edit commission payment') : t('Record commission received')}</DialogTitle>
      <DialogContent>
        {error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(error)}</Alert>}
        {editing ? (
          <>
            <TextField label={t('Paid by (specialist)')} value={payment?.specialist ? fullName(payment.specialist) : ''} disabled />
            <TextField
              select label={t('Received by (owner)')} value={ownerId} required disabled={!isAdmin}
              onChange={(e) => { setOwnerId(e.target.value); clear('ownerId'); }} {...field('ownerId')}
              helperText={errors.ownerId || (payment && !payment.owner ? t('This payment does not say who received it: choose the owner.') : undefined)}
            >
              {doctors.filter((d) => d.kind === 'owner').map((d) => <MenuItem key={d.id} value={String(d.id)}>{fullName(d)}</MenuItem>)}
            </TextField>
          </>
        ) : (
          <>
            <TextField select label={t('Paid by (specialist)')} value={specialistId} required onChange={(e) => { setSpecialistId(e.target.value); clear('specialistId'); }} {...field('specialistId')}>
              {doctors.filter((d) => d.kind === 'external').map((d) => <MenuItem key={d.id} value={String(d.id)}>{fullName(d)}</MenuItem>)}
            </TextField>
            <TextField select label={t('Received by (owner)')} value={ownerId} required disabled={!isAdmin} onChange={(e) => { setOwnerId(e.target.value); clear('ownerId'); }} {...field('ownerId')}>
              {doctors.filter((d) => d.kind === 'owner').map((d) => <MenuItem key={d.id} value={String(d.id)}>{fullName(d)}</MenuItem>)}
            </TextField>
          </>
        )}
        <TextField
          label={t('Amount ($)')} type="number" value={amount} required slotProps={{ htmlInput: { min: 0, step: '0.01', inputMode: 'decimal', dir: 'ltr' } }}
          onChange={(e) => { setAmount(e.target.value); clear('amount'); }} {...field('amount')}
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

const money = (n: number | null) => (n === null ? <Typography component="span" color="text.secondary">{'—'}</Typography> : formatMoney(n));

/**
 * What outside specialists owe the owners for using their dental units: a percentage of what the specialist
 * collected, for the owner of the unit of the patient's latest visit, less what has been paid over.
 * Admins see everyone's; an owner sees what is owed to him; a specialist what he owes.
 */
export function CommissionPage() {
  const { t } = useTranslation();
  const { role, doctorId, isSpecialist } = useRole();
  const [params] = useSearchParams();
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [form, setForm] = useState<'new' | CommissionPaymentDto | null>(null);
  const [deleting, setDeleting] = useState<CommissionPaymentDto | null>(null);
  const [remove, removeState] = useDeleteCommissionPaymentMutation();

  const range = { from: from || undefined, to: to || undefined };
  const statement = useCommissionStatementQuery(range);
  const payments = useCommissionPaymentsQuery(range);
  const canRecord = role === 'admin' || (role === 'doctor' && !isSpecialist && !!doctorId);
  const lines = statement.data?.lines ?? [];
  const fees = statement.data?.fees ?? [];
  const missing = statement.data?.missingPercentage ?? [];
  const totals = lines.reduce((s, l) => ({ owed: s.owed + (l.owed ?? 0), received: s.received + l.received, balance: s.balance + (l.balance ?? 0) }), { owed: 0, received: 0, balance: 0 });

  return (
    <>
      <PageHeader
        title={t('Commission')}
        subtitle={t('What outside specialists owe the owner of the dental unit they use: their percentage of what they collected.')}
        actions={canRecord ? <Button variant="contained" startIcon={<AddIcon />} onClick={() => setForm('new')}>{t('Record commission received')}</Button> : undefined}
      />
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 2 }}>
        <TextField type="date" label={t('From')} value={from} onChange={(e) => setFrom(e.target.value)} margin="none" slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} />
        <TextField type="date" label={t('To')} value={to} onChange={(e) => setTo(e.target.value)} margin="none" slotProps={{ inputLabel: { shrink: true } }} sx={{ maxWidth: 170 }} />
      </Box>
      {statement.error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(statement.error)}</Alert>}
      {missing.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t('No commission percentage is set for {{names}}, so what they owe cannot be worked out yet. Set it under Doctors.', { names: missing.map(fullName).join(', ') })}
        </Alert>
      )}

      <Typography variant="h6" component="h2" gutterBottom>{t('Owed by specialists')}</Typography>
      {!statement.data ? (
        <Skeleton variant="rounded" height={100} />
      ) : lines.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', mb: 3 }}><Typography>{t('No commission to show.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('Specialist')}</TableCell><TableCell>{t('Owner')}</TableCell>
                <TableCell align="right">{t('Collected')}</TableCell><TableCell align="right">{t('Owed')}</TableCell>
                <TableCell align="right">{t('Received')}</TableCell><TableCell align="right">{t('Balance')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={`${l.specialist.id}-${l.owner?.id ?? 'none'}`}>
                  <TableCell>{fullName(l.specialist)}{l.specialist.commissionPercent !== null && <Typography component="span" variant="caption" color="text.secondary"> · {l.specialist.commissionPercent}%</Typography>}</TableCell>
                  <TableCell>{l.owner ? fullName(l.owner) : <Typography component="span" color="text.secondary">{t('No visit to go by')}</Typography>}</TableCell>
                  <TableCell align="right">{formatMoney(l.collected)}</TableCell>
                  <TableCell align="right">{money(l.owed)}</TableCell>
                  <TableCell align="right">{formatMoney(l.received)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, color: (l.balance ?? 0) > 0 ? 'warning.main' : 'text.primary' }}>{money(l.balance)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={3} sx={{ fontWeight: 700 }}>{t('Total')}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>{formatMoney(totals.owed)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>{formatMoney(totals.received)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700 }}>{formatMoney(totals.balance)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Typography variant="h6" component="h2" gutterBottom>{t('Paid over by specialists')}</Typography>
      {removeState.error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(removeState.error)}</Alert>}
      {(payments.data ?? []).length === 0 ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center', mb: 3 }}><Typography>{t('No commission payments yet.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('Date')}</TableCell><TableCell>{t('Specialist')}</TableCell><TableCell>{t('Owner')}</TableCell>
                <TableCell align="right">{t('Amount')}</TableCell><TableCell>{t('Paid by')}</TableCell>{canRecord && <TableCell align="right">{t('Actions')}</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {payments.data!.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{formatDate(p.date)}</TableCell>
                  <TableCell>{p.specialist ? fullName(p.specialist) : '—'}</TableCell>
                  <TableCell>{p.owner ? fullName(p.owner) : '—'}</TableCell>
                  <TableCell align="right">{formatMoney(p.amount)}</TableCell>
                  <TableCell>{p.method ? t(METHOD_LABEL[p.method]) : '—'}</TableCell>
                  {canRecord && (
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit payment of {{amount}}', { amount: formatMoney(p.amount) })} onClick={() => setForm(p)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete payment of {{amount}}', { amount: formatMoney(p.amount) })} onClick={() => { removeState.reset(); setDeleting(p); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {fees.length > 0 && (
        <>
          <Typography variant="h6" component="h2" gutterBottom>{t('Fees paid to specialists')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('For an owner’s patient treated by a specialist, the owner pays the specialist. The specialist owes nothing on these.')}</Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow><TableCell>{t('Specialist')}</TableCell><TableCell>{t('Paid by')}</TableCell><TableCell align="right">{t('Visits')}</TableCell><TableCell align="right">{t('Amount')}</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {fees.map((f) => (
                  <TableRow key={`${f.specialist.id}-${f.owner?.id ?? 'none'}`}>
                    <TableCell>{fullName(f.specialist)}</TableCell>
                    <TableCell>{f.owner ? fullName(f.owner) : '—'}</TableCell>
                    <TableCell align="right">{f.count}</TableCell>
                    <TableCell align="right">{formatMoney(f.paid)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <CommissionPaymentDialog open={!!form} onClose={() => setForm(null)} payment={form && form !== 'new' ? form : undefined} />
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete this payment?')}
        message={t('The payment goes to the Trash. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete payment')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </>
  );
}
