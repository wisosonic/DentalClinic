import { Chip } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { OfferPaymentState, OfferStatus, OfferWorkState } from '@aya/shared';
import { OFFER_STATUS_COLOR, OFFER_STATUS_LABEL, PAYMENT_STATE_COLOR, PAYMENT_STATE_LABEL, WORK_STATE_COLOR, WORK_STATE_LABEL } from './labels';

/** What the offer's own status is: set by hand by the doctor or admin. */
export function OfferStatusChip({ status }: { status: OfferStatus }) {
  const { t } = useTranslation();
  return <Chip size="small" label={t(OFFER_STATUS_LABEL[status])} color={OFFER_STATUS_COLOR[status]} variant={status === 'draft' || status === 'expired' || status === 'cancelled' ? 'outlined' : 'filled'} />;
}

/** Whether it has been paid: always worked out from the payments. */
export function PaymentStateChip({ state }: { state: OfferPaymentState }) {
  const { t } = useTranslation();
  return <Chip size="small" label={t(PAYMENT_STATE_LABEL[state])} color={PAYMENT_STATE_COLOR[state]} variant={state === 'unpaid' ? 'outlined' : 'filled'} />;
}

/** How far the work has got: always worked out from the items. */
export function WorkStateChip({ state }: { state: OfferWorkState }) {
  const { t } = useTranslation();
  return <Chip size="small" label={t(WORK_STATE_LABEL[state])} color={WORK_STATE_COLOR[state]} variant={state === 'not_started' ? 'outlined' : 'filled'} />;
}
