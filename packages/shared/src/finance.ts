import { z } from 'zod';
import { dateSchema, idSchema } from './clinical';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(max).nullable().optional());

/** Money is US dollars with cents; the form sends strings, the API numbers. */
const MAX_MONEY = 1_000_000;
export const moneySchema = z.coerce
  .number({ invalid_type_error: 'Enter an amount' })
  .finite('Enter an amount')
  .min(0, 'Cannot be negative')
  .max(MAX_MONEY, 'That amount is too large')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use at most two decimals');

export const positiveMoneySchema = moneySchema.refine((v) => v > 0, 'Enter an amount above zero');

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const paymentInputSchema = z.object({
  offerId: idSchema,
  amount: positiveMoneySchema,
  date: dateSchema,
  method: z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose how it was paid' }) }),
  description: optionalText(500),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const paymentUpdateSchema = paymentInputSchema.omit({ offerId: true }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface PaymentDto {
  id: number;
  offerId: number | null;
  offer: { id: number; title: string } | null;
  patient: { id: number; fname: string; lname: string } | null;
  date: string;
  amount: number;
  /** What was still owed on the offer right after this payment. Always worked out by the server. */
  remaining: number | null;
  currency: string;
  method: PaymentMethod | null;
  description: string | null;
  type: 'clinic' | 'commission';
  /** The doctor who collected it (the patient's primary doctor when it was made). */
  collectedBy: { id: number; fname: string; lname: string } | null;
  /** The doctor's share, as a percentage: admins only. */
  drPart?: number | null;
  createdAt: string | null;
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/**
 * personal (the owners' own, admins only), clinic (water, electricity, things bought for the clinic),
 * lab (names the lab), supplier (names the supplier), commission (an owner pays an outside specialist for
 * treating the owner's patient: names the doctor and the appointment).
 */
export const EXPENSE_TYPES = ['personal', 'clinic', 'lab', 'supplier', 'commission'] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const expenseInputSchema = z
  .object({
    type: z.enum(EXPENSE_TYPES, { errorMap: () => ({ message: 'Choose a type' }) }),
    date: dateSchema,
    amount: positiveMoneySchema,
    description: optionalText(500),
    labId: idSchema.nullable().optional(),
    supplierId: idSchema.nullable().optional(),
    doctorId: idSchema.nullable().optional(),
    appointmentId: idSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const need = (field: 'labId' | 'supplierId' | 'doctorId' | 'appointmentId', message: string) => {
      if (!v[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (v.type === 'lab') need('labId', 'Choose the lab');
    if (v.type === 'supplier') need('supplierId', 'Choose the supplier');
    if (v.type === 'commission') need('doctorId', 'Choose the specialist'); // the visit is optional
  });
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

export interface ExpenseDto {
  id: number;
  type: ExpenseType;
  date: string;
  amount: number;
  currency: string;
  description: string | null;
  lab: { id: number; name: string } | null;
  supplier: { id: number; name: string } | null;
  /** For a commission expense: the specialist who was paid, and the visit it was for. */
  doctor: { id: number; fname: string; lname: string } | null;
  appointment: { id: number; date: string; time: string; patient: { fname: string; lname: string } } | null;
  createdBy: string | null;
}

export interface DirectoryEntryDto {
  id: number;
  name: string;
}

/** A lab or a supplier, with its details. */
export interface DirectoryDto extends DirectoryEntryDto {
  contact: string | null;
  address: string | null;
  phone: string;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Commission (what outside specialists owe the owner of the unit they use)
// ---------------------------------------------------------------------------

export const commissionPaymentInputSchema = z.object({
  specialistId: idSchema,
  ownerId: idSchema,
  amount: positiveMoneySchema,
  date: dateSchema,
  method: z.enum(PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose how it was paid' }) }),
  description: optionalText(500),
});
export type CommissionPaymentInput = z.infer<typeof commissionPaymentInputSchema>;
/** The owner who received it can be changed (an old payment may not say who); the specialist who paid cannot. */
export const commissionPaymentUpdateSchema = commissionPaymentInputSchema.omit({ specialistId: true }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface CommissionPaymentDto {
  id: number;
  date: string;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  description: string | null;
  /** The specialist who paid. */
  specialist: { id: number; fname: string; lname: string } | null;
  /** The owner who received it. */
  owner: { id: number; fname: string; lname: string } | null;
}

export interface CommissionLineDto {
  specialist: { id: number; fname: string; lname: string; commissionPercent: number | null };
  /** The owner of the unit of the patient's latest visit; null when the patient has no visit to go by. */
  owner: { id: number; fname: string; lname: string } | null;
  /** What the specialist collected from patients in the period. */
  collected: number;
  /** The percentage of that which is owed: null when the specialist has no percentage set yet. */
  owed: number | null;
  /** What he paid over in the period. */
  received: number;
  /** Owed minus received, from the beginning up to the end of the period. */
  balance: number | null;
}

export interface CommissionFeeDto {
  specialist: { id: number; fname: string; lname: string };
  /** The owner who paid the fees (the patients' primary doctor). */
  owner: { id: number; fname: string; lname: string } | null;
  paid: number;
  count: number;
}

export interface CommissionStatementDto {
  lines: CommissionLineDto[];
  fees: CommissionFeeDto[];
  /** Specialists who collected money but have no commission percentage yet, so nothing could be worked out. */
  missingPercentage: { id: number; fname: string; lname: string }[];
}

// ---------------------------------------------------------------------------
// Finance summary (admin)
// ---------------------------------------------------------------------------

export interface FinanceSummaryDto {
  from: string | null;
  to: string | null;
  /** Everything received in the period: payments from patients and commission paid over by specialists. */
  payments: { total: number; count: number; byType: { type: 'clinic' | 'commission'; total: number; count: number }[] };
  expenses: {
    total: number;
    count: number;
    byType: { type: ExpenseType; total: number }[];
    /** Lab and supplier spending, by name (biggest first). */
    byLab: { id: number; name: string; total: number }[];
    bySupplier: { id: number; name: string; total: number }[];
  };
  /** Each month of the period: what came in and what went out. Months with nothing are included, so the chart has no gaps. */
  byMonth: { month: string; payments: number; expenses: number }[];
  /** Total payments minus total expenses. Negative when more went out than came in. */
  net: number;
  /** What patients still owe on their offers, as things stand today (not limited to the period). */
  debts: {
    total: number;
    patients: number;
    offers: number;
    top: { patient: { id: number; fname: string; lname: string }; owed: number }[];
  };
}

/** One doctor's money. A patient's doctor is his primary doctor; an admin sees every doctor, a doctor only himself. */
export interface DoctorFiguresDto {
  doctor: { id: number; fname: string; lname: string; kind: 'owner' | 'external' };
  /** Offers (apart from drafts) made in the period for this doctor's patients. */
  offers: { count: number; value: number };
  /** What this doctor collected from patients in the period. */
  collected: number;
  /** What this doctor's patients still owe on open offers, as things stand today. */
  debts: number;
  /**
   * An owner: the commission specialists still owe him. A specialist: the commission he still owes the owners.
   * null when a specialist's percentage is not set, so it cannot be worked out.
   */
  commissionBalance: number | null;
  /** An owner: fees he paid specialists in the period. A specialist: fees owners paid him in the period. */
  fees: number;
}

export interface DoctorFiguresResponse {
  from: string | null;
  to: string | null;
  doctors: DoctorFiguresDto[];
}
