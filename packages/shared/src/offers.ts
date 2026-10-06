import { z } from 'zod';
import { dateSchema, idSchema } from './clinical';
import { moneySchema } from './finance';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(max).nullable().optional());
const optionalDate = z.preprocess((v) => (v === '' ? null : v), dateSchema.nullable().optional());
const optionalId = z.preprocess((v) => (v === '' || v === 0 ? null : v), idSchema.nullable().optional());

// ---------------------------------------------------------------------------
// Treatment offers: what will be done, what it costs, what the patient agreed to and what was paid.
// (Treatment plans and quotes used to be two things; owner decision 2026-10-06.)
// ---------------------------------------------------------------------------

/**
 * The offer's own status. An offer is made in the chair, after the patient has agreed to the treatment and its price,
 * so a new offer is `accepted` at once (owner decision 2026-10-06; there is no online sending to wait on). A doctor
 * can still keep an unfinished one as a `draft` (not binding: no payments, no visits) and accept it later; `cancelled`
 * closes one the patient is not going ahead with. Whether it has been paid and how far the work has got are NOT part
 * of it: they are worked out from the payments and the items (`OfferPaymentState`, `OfferWorkState`).
 */
export const OFFER_STATUSES = ['draft', 'accepted', 'cancelled'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_ACTIONS = ['accept', 'cancel'] as const;
export type OfferAction = (typeof OFFER_ACTIONS)[number];

/** Worked out from the payments: nothing paid, something paid, or everything (or more) paid. */
export const PAYMENT_STATES = ['unpaid', 'partly_paid', 'paid'] as const;
export type OfferPaymentState = (typeof PAYMENT_STATES)[number];

/** Worked out from the items: none started, some booked or done, all done. */
export const WORK_STATES = ['not_started', 'in_progress', 'completed'] as const;
export type OfferWorkState = (typeof WORK_STATES)[number];

export const offerItemInputSchema = z.object({
  /** Present for an item that already exists, so editing the list keeps its appointment and progress. */
  id: idSchema.optional(),
  description: text(255).min(1, 'Describe the work'),
  toothId: optionalId,
  categoryId: optionalId,
  /** What the patient is asked to pay for this work. */
  price: moneySchema,
  /** What it costs the clinic (optional; admins and doctors only ever see it). */
  cost: z.preprocess((v) => (v === '' || v === undefined ? null : v), moneySchema.nullable().optional()),
});
export type OfferItemInput = z.input<typeof offerItemInputSchema>;

export const offerInputSchema = z.object({
  patientId: idSchema,
  title: text(255).min(1, 'Title is required'),
  description: optionalText(255),
  startDate: optionalDate,
  notes: optionalText(5000),
  items: z.array(offerItemInputSchema).max(60).default([]),
  /** Keep it as an unfinished draft instead of making it final (needs no items). */
  asDraft: z.boolean().optional(),
});
export type OfferInput = z.input<typeof offerInputSchema>;

export const offerUpdateSchema = z
  .object({
    title: text(255).min(1, 'Title is required'),
    description: optionalText(255),
    startDate: optionalDate,
    notes: optionalText(5000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const offerItemsSchema = z.object({ items: z.array(offerItemInputSchema).max(60) });

export type OfferItemStatus = 'pending' | 'scheduled' | 'done';

export interface OfferItemDto {
  id: number;
  sequence: number;
  description: string;
  tooth: { id: number; index: string } | null;
  category: { id: number; name: string } | null;
  price: number;
  /** The clinic's own cost: admins and doctors only. */
  cost?: number | null;
  status: OfferItemStatus;
  /** The visit that does this work, once one is booked. */
  appointment: { id: number; date: string; time: string; status: string } | null;
  completedAt: string | null;
}

export interface OfferDto {
  id: number;
  patientId: number;
  patient: { id: number; fname: string; lname: string };
  doctor: { id: number; fname: string; lname: string } | null;
  title: string;
  description: string | null;
  startDate: string | null;
  notes: string | null;
  status: OfferStatus;
  /** The sum of the items' prices. */
  price: number;
  /** The sum of the items' costs: admins and doctors only. */
  cost?: number;
  currency: string;
  /** Sum of the payments so far. */
  paid: number;
  /** What is still owed, never below zero. */
  remaining: number;
  paymentState: OfferPaymentState;
  workState: OfferWorkState;
  progress: { done: number; total: number; percent: number };
  /** Only when one offer is read, not in lists. */
  items?: OfferItemDto[];
  createdAt: string | null;
}

/** An open offer of a patient, as a payment is entered: nothing but what is needed to pick it. */
export interface OpenOfferDto {
  id: number;
  title: string;
  price: number;
  paid: number;
  remaining: number;
}
