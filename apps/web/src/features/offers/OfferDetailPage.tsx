import { useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Divider, IconButton, LinearProgress, Link, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import type { OfferAction, OfferItemDto, PaymentDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName, statusLabel } from '../../lib/format';
import { METHOD_LABEL, formatMoney } from '../../lib/money';
import { AppointmentFormDialog } from '../appointments/AppointmentFormDialog';
import { useDeletePaymentMutation, useListPaymentsQuery } from '../finance/financeApi';
import { PaymentFormDialog } from '../finance/PaymentFormDialog';
import { OfferStatusChip, PaymentStateChip, WorkStateChip } from './OfferChips';
import { ITEM_STATUS_COLOR, ITEM_STATUS_LABEL } from './labels';
import { OfferFormDialog } from './OfferFormDialog';
import { useDeleteOfferMutation, useGetOfferQuery, useMarkOfferItemDoneMutation, useMarkOfferItemPendingMutation, useOfferActionMutation } from './offersApi';
import { TimeText } from '../../lib/useTime';

type SortKey = 'order' | 'description' | 'procedure' | 'tooth' | 'price' | 'cost' | 'status' | 'visit';

/** The buttons that apply to an offer in each state. A new offer is accepted already; only a draft waits to be accepted. */
const NEXT: Record<string, { action: OfferAction; label: string; primary?: boolean }[]> = {
  draft: [{ action: 'accept', label: 'Patient accepted', primary: true }],
};

/**
 * One treatment offer: its work in order with prices, the three indicators (offer status, payment, work), the
 * payments, and the buttons that move it along. Only the patient's doctor (and admin) change it; staff book its
 * visits and record payments.
 */
export function OfferDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const id = Number(useParams().id);
  const { role, doctorId } = useRole();
  const { data: offer, isFetching, error } = useGetOfferQuery(id, { skip: !id });
  const [act, actState] = useOfferActionMutation();
  const [markDone, doneState] = useMarkOfferItemDoneMutation();
  const [markPending, pendingState] = useMarkOfferItemPendingMutation();
  const [picked, setPicked] = useState<number[]>([]); // pending works chosen for one visit
  const [remove, removeState] = useDeleteOfferMutation();
  const [removePayment, removePaymentState] = useDeletePaymentMutation();
  const sort = useSort<SortKey>('order');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [booking, setBooking] = useState<OfferItemDto[] | null>(null);
  const [paying, setPaying] = useState<'new' | PaymentDto | null>(null);
  const [deletingPayment, setDeletingPayment] = useState<PaymentDto | null>(null);

  const mayWrite = !!offer && (role === 'admin' || (role === 'doctor' && !!doctorId && offer.doctor?.id === doctorId));
  const mayBook = role === 'admin' || role === 'doctor' || role === 'staff';
  const seesPayments = mayWrite; // staff record a payment but cannot browse the history
  const { data: payments } = useListPaymentsQuery({ offerId: id, pageSize: 100, sort: 'date', order: 'asc' }, { skip: !id || !seesPayments });
  const accepted = offer?.status === 'accepted';
  const closed = offer?.status === 'cancelled';
  const canPay = !!offer && offer.status === 'accepted' && offer.remaining > 0 && (mayWrite || role === 'staff');
  const failure = actState.error ?? doneState.error ?? pendingState.error ?? removeState.error ?? removePaymentState.error;
  const hasCost = offer?.cost !== undefined;
  const untouched = !!offer && offer.paid === 0 && (offer.items ?? []).every((i) => i.status === 'pending');

  const patientDefaults = useMemo(() => (offer ? { patient: offer.patient } : undefined), [offer]);

  const value: Record<SortKey, (i: OfferItemDto) => string | number | null> = {
    order: (i) => i.sequence, description: (i) => i.description, procedure: (i) => i.category?.name ?? null, tooth: (i) => i.tooth?.index ?? null,
    price: (i) => i.price, cost: (i) => i.cost ?? null, status: (i) => ['pending', 'scheduled', 'done'].indexOf(i.status),
    visit: (i) => (i.appointment ? `${i.appointment.date} ${i.appointment.time}` : null),
  };
  const items = sortRows(offer?.items ?? [], value[sort.key], sort.order);

  const run = (action: OfferAction) => { actState.reset(); act({ id, action }); };

  if (error) return <Alert severity="error">{errorMessage(error)}</Alert>;
  if (!offer) return <Skeleton variant="rounded" height={200} aria-label={t('Loading')} />;

  const paidPercent = offer.price > 0 ? Math.min(100, Math.round((offer.paid / offer.price) * 100)) : 0;

  return (
    <>
      <PageHeader
        title={offer.title}
        subtitle={`${fullName(offer.patient)}${offer.doctor ? ` · ${t('Dr.')} ${fullName(offer.doctor)}` : ''}`}
        actions={
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <OfferStatusChip status={offer.status} />
            <PaymentStateChip state={offer.paymentState} />
            <WorkStateChip state={offer.workState} />
          </Box>
        }
      />
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
        {mayWrite && (NEXT[offer.status] ?? []).map((n) => (
          <Button key={n.action} variant={n.primary ? 'contained' : 'outlined'} onClick={() => run(n.action)} disabled={actState.isLoading}>{t(n.label)}</Button>
        ))}
        {canPay && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setPaying('new')}>{t('Record payment')}</Button>}
        <Button component="a" href={`/api/v1/treatment-offers/${id}/pdf`} target="_blank" rel="noopener" startIcon={<PictureAsPdfIcon />}>{t('Offer (PDF)')}</Button>
        {mayWrite && !closed && <Button startIcon={<EditIcon />} onClick={() => setEditing(true)}>{t('Edit')}</Button>}
        {mayWrite && !closed && untouched && <Button color="warning" onClick={() => run('cancel')} disabled={actState.isLoading}>{t('Cancel offer')}</Button>}
        {mayWrite && <Button color="error" startIcon={<DeleteOutlineIcon />} onClick={() => { removeState.reset(); setDeleting(true); }}>{t('Delete')}</Button>}
      </Box>
      {failure != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(failure)}</Alert>}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} divider={<Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />}>
          <Box sx={{ flexGrow: 1 }}>
            <Stack direction="row" gap={3} flexWrap="wrap" sx={{ mb: 1 }}>
              <Box><Typography variant="caption" color="text.secondary">{t('Total')}</Typography><Typography variant="h6">{formatMoney(offer.price)}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">{t('Paid')}</Typography><Typography variant="h6" color="success.main">{formatMoney(offer.paid)}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">{t('Remaining')}</Typography><Typography variant="h6" color={offer.remaining > 0 ? 'warning.main' : 'text.primary'}>{formatMoney(offer.remaining)}</Typography></Box>
              {hasCost && offer.cost! > 0 && (
                <Box><Typography variant="caption" color="text.secondary">{t('Clinic cost')}</Typography><Typography variant="h6">{formatMoney(offer.cost)}</Typography></Box>
              )}
            </Stack>
            <LinearProgress variant="determinate" value={paidPercent} aria-label={t('Paid so far')} sx={{ height: 8 }} />
          </Box>
          <Box sx={{ flexGrow: 1 }}>
            <Typography variant="caption" color="text.secondary">{t('Work')}</Typography>
            <LinearProgress variant="determinate" value={offer.progress.percent} aria-label={t('Progress of {{title}}', { title: offer.title })} sx={{ height: 8, my: 0.75 }} />
            <Typography variant="body2">{t('{{done}} of {{total}} done', { done: offer.progress.done, total: offer.progress.total })}</Typography>
          </Box>
        </Stack>
        {offer.description && <Typography sx={{ mt: 1.5 }}>{offer.description}</Typography>}
        {offer.notes && <Typography variant="body2" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{offer.notes}</Typography>}
        <Typography variant="body2" sx={{ mt: 1.5 }}>
          <Link component={RouterLink} to={`/patients/${offer.patientId}`}>{t('Open the patient')}</Link>
        </Typography>
      </Paper>

      {!accepted && !closed && (
        <Alert severity="info" sx={{ mb: 2 }}>{t('This offer is a draft. Visits and payments come once the patient has accepted it.')}</Alert>
      )}

      {offer.items && offer.items.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('This offer has no work listed yet.')}</Typography></Paper>
      ) : (
        <>
        {mayBook && accepted && picked.length > 1 && (
          <Box sx={{ mb: 1 }}>
            <Button variant="contained" size="small" onClick={() => { setBooking(items.filter((i) => picked.includes(i.id) && i.status === 'pending')); setPicked([]); }}>
              {t('Book one visit for the {{count}} selected works', { count: picked.length })}
            </Button>
          </Box>
        )}
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1, mb: 3 }}>
          <Table size="small" aria-label={t('Work')}>
            <TableHead>
              <TableRow>
                <SortCell field="order" sort={sort}>#</SortCell>
                <SortCell field="description" sort={sort}>{t('Work')}</SortCell>
                <SortCell field="procedure" sort={sort}>{t('Procedure')}</SortCell>
                <SortCell field="tooth" sort={sort}>{t('Tooth')}</SortCell>
                <SortCell field="price" sort={sort} align="right">{t('Price')}</SortCell>
                {hasCost && <SortCell field="cost" sort={sort} align="right">{t('Cost')}</SortCell>}
                <SortCell field="status" sort={sort}>{t('Status')}</SortCell>
                <SortCell field="visit" sort={sort}>{t('Visit')}</SortCell>
                {mayBook && <TableCell align="right">{t('Actions')}</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.sequence}</TableCell>
                  <TableCell>{i.description}</TableCell>
                  <TableCell>{i.category?.name ?? '—'}</TableCell>
                  <TableCell>{i.tooth ? <bdi dir="ltr">{i.tooth.index}</bdi> : '—'}</TableCell>
                  <TableCell align="right">{formatMoney(i.price)}</TableCell>
                  {hasCost && <TableCell align="right">{i.cost == null ? '—' : formatMoney(i.cost)}</TableCell>}
                  <TableCell><Chip size="small" label={t(ITEM_STATUS_LABEL[i.status])} color={ITEM_STATUS_COLOR[i.status]} /></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {i.appointment ? (
                      <>
                        {formatDate(i.appointment.date)} <TimeText value={i.appointment.time} />
                        <Typography variant="caption" color="text.secondary" component="span" sx={{ marginInlineStart: 1 }}>{statusLabel(i.appointment.status as never)}</Typography>
                      </>
                    ) : i.completedAt ? formatDate(i.completedAt.slice(0, 10)) : '—'}
                  </TableCell>
                  {mayBook && (
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      {accepted && i.status === 'pending' && (
                        <>
                          <Checkbox size="small" checked={picked.includes(i.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i.id] : p.filter((x) => x !== i.id)))} inputProps={{ 'aria-label': t('Select {{work}} for one visit', { work: i.description }) }} />
                          <Button size="small" variant="outlined" onClick={() => setBooking([i])} aria-label={t('Book a visit for {{work}}', { work: i.description })}>{t('Book visit')}</Button>
                          {mayWrite && (
                            <Button size="small" sx={{ marginInlineStart: 0.5 }} disabled={doneState.isLoading} onClick={() => { doneState.reset(); markDone({ id, itemId: i.id }); }} aria-label={t('Mark {{work}} as done', { work: i.description })}>
                              {t('Mark done')}
                            </Button>
                          )}
                        </>
                      )}
                      {accepted && mayWrite && i.status === 'scheduled' && (
                        <Button size="small" disabled={doneState.isLoading} onClick={() => { doneState.reset(); markDone({ id, itemId: i.id }); }} aria-label={t('Mark {{work}} as done', { work: i.description })}>{t('Mark done')}</Button>
                      )}
                      {accepted && mayWrite && (i.status === 'scheduled' || i.status === 'done') && (
                        <Button size="small" sx={{ marginInlineStart: 0.5 }} disabled={pendingState.isLoading} onClick={() => { pendingState.reset(); markPending({ id, itemId: i.id }); }} aria-label={t('Mark {{work}} as pending', { work: i.description })}>{t('Mark pending')}</Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        </>
      )}

      {seesPayments && (
        <Box component="section" aria-label={t('Payments')}>
          <Typography variant="subtitle1" component="h2" sx={{ mb: 1 }}>{t('Payments')}</Typography>
          {(payments?.data ?? []).length === 0 ? (
            <Typography variant="body2" color="text.secondary">{t('No payments yet.')}</Typography>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label={t('Payments')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('Date')}</TableCell><TableCell align="right">{t('Amount')}</TableCell><TableCell align="right">{t('Left after')}</TableCell>
                    <TableCell>{t('Paid by')}</TableCell><TableCell align="right">{t('Actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {payments!.data.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{formatDate(p.date)}</TableCell>
                      <TableCell align="right">{formatMoney(p.amount)}</TableCell>
                      <TableCell align="right">{formatMoney(p.remaining)}</TableCell>
                      <TableCell>{p.method ? t(METHOD_LABEL[p.method]) : '—'}</TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Tooltip title={t('Receipt (PDF)')}>
                          <IconButton
                            size="small" component="a" href={`/api/v1/payments/${p.id}/receipt`} target="_blank" rel="noopener"
                            aria-label={t('Receipt for payment of {{amount}}', { amount: formatMoney(p.amount) })}
                          ><PictureAsPdfIcon fontSize="small" /></IconButton>
                        </Tooltip>
                        <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit payment of {{amount}}', { amount: formatMoney(p.amount) })} onClick={() => setPaying(p)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete payment of {{amount}}', { amount: formatMoney(p.amount) })} onClick={() => { removePaymentState.reset(); setDeletingPayment(p); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Box>
      )}

      <OfferFormDialog open={editing} onClose={() => setEditing(false)} offer={offer} />
      <PaymentFormDialog
        open={!!paying} onClose={() => setPaying(null)}
        offer={paying === 'new' ? { id: offer.id, title: offer.title, remaining: offer.remaining } : undefined}
        payment={paying && paying !== 'new' ? paying : undefined}
      />
      {booking && (
        <AppointmentFormDialog
          open onClose={() => setBooking(null)} defaults={patientDefaults}
          offerItem={{ offerId: id, itemId: booking[0]!.id, alsoItemIds: booking.slice(1).map((b) => b.id), description: booking.map((b) => b.description).join(', '), categoryId: booking[0]!.category?.id ?? null }}
        />
      )}
      <ConfirmDialog
        open={deleting} destructive title={t('Delete this treatment offer?')}
        message={t('The offer and its payments go to the Trash. Only an administrator can restore them or erase them for good. Visits already booked are not affected.')}
        confirmLabel={t('Delete offer')} busy={removeState.isLoading} onClose={() => setDeleting(false)}
        onConfirm={async () => { const r = await remove(id); setDeleting(false); if (!('error' in r && r.error)) navigate('/treatment-offers'); }}
      />
      <ConfirmDialog
        open={!!deletingPayment} destructive title={t('Delete this payment?')}
        message={t('The payment goes to the Trash and the balance of the offer is worked out again. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete payment')} busy={removePaymentState.isLoading} onClose={() => setDeletingPayment(null)}
        onConfirm={async () => { await removePayment(deletingPayment!.id); setDeletingPayment(null); }}
      />
    </>
  );
}
