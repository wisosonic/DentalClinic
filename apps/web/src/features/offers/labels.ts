import type { OfferItemStatus, OfferPaymentState, OfferStatus, OfferWorkState } from '@aya/shared';

type Color = 'default' | 'info' | 'primary' | 'warning' | 'success' | 'error';

/** English text is the translation key. */
export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired', cancelled: 'Cancelled',
};
export const OFFER_STATUS_COLOR: Record<OfferStatus, Color> = {
  draft: 'default', sent: 'info', accepted: 'primary', rejected: 'error', expired: 'default', cancelled: 'error',
};

export const PAYMENT_STATE_LABEL: Record<OfferPaymentState, string> = { unpaid: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid' };
export const PAYMENT_STATE_COLOR: Record<OfferPaymentState, Color> = { unpaid: 'default', partly_paid: 'warning', paid: 'success' };

export const WORK_STATE_LABEL: Record<OfferWorkState, string> = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
export const WORK_STATE_COLOR: Record<OfferWorkState, Color> = { not_started: 'default', in_progress: 'warning', completed: 'success' };

export const ITEM_STATUS_LABEL: Record<OfferItemStatus, string> = { pending: 'To do', scheduled: 'Booked', done: 'Done' };
export const ITEM_STATUS_COLOR: Record<OfferItemStatus, Color> = { pending: 'default', scheduled: 'info', done: 'success' };
