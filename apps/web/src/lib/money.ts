import type { ExpenseType, PaymentMethod } from '@aya/shared';
import { dateLocale } from '../i18n';

/** US dollars, with digits and separators of the chosen language's locale (Arabic keeps Western digits). */
export const formatMoney = (n: number | null | undefined): string =>
  n == null ? '—' : new Intl.NumberFormat(dateLocale(), { style: 'currency', currency: 'USD' }).format(n);

/** Lebanese pounds, whole, with the digits and separators of the chosen language's locale (Arabic keeps Western digits). */
export const formatLbp = (n: number): string => `${new Intl.NumberFormat(dateLocale(), { maximumFractionDigits: 0 }).format(n)} LBP`;

/** English text is the translation key. */
export const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other',
};

export const EXPENSE_TYPE_LABEL: Record<ExpenseType, string> = {
  personal: 'Personal', clinic: 'Clinic', lab: 'Lab', supplier: 'Supplier', commission: 'Specialist fee',
};

/** The two kinds of payment: from a patient, and commission a specialist paid over to an owner. */
export const PAYMENT_TYPE_LABEL = { clinic: 'From patients', commission: 'Commission received' } as const;
