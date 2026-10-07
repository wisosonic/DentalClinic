import { z } from 'zod';
import { dateSchema, idSchema } from './clinical';
import { moneySchema } from './finance';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), text(max).nullable().optional());
const optionalDate = z.preprocess((v) => (v === '' ? null : v), dateSchema.nullable().optional());
const optionalId = z.preprocess((v) => (v === '' || v === 0 ? null : v), idSchema.nullable().optional());

// ---------------------------------------------------------------------------
// Labs and suppliers (the directories)
// ---------------------------------------------------------------------------

export const directoryInputSchema = z.object({
  name: text(255).min(1, 'Name is required'),
  /** The person to ask for. */
  contact: optionalText(255),
  address: optionalText(255),
  phone: text(40).min(3, 'Phone is required'),
  description: optionalText(2000),
});
export type DirectoryInput = z.input<typeof directoryInputSchema>;
export const directoryUpdateSchema = directoryInputSchema.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

// ---------------------------------------------------------------------------
// Lab orders
// ---------------------------------------------------------------------------

export const LAB_STATUSES = ['draft', 'sent', 'received', 'fitted'] as const;
export type LabStatus = (typeof LAB_STATUSES)[number];

export const LAB_ACTIONS = ['send', 'receive', 'fit'] as const;
export type LabAction = (typeof LAB_ACTIONS)[number];

export const labOrderInputSchema = z.object({
  labId: idSchema,
  patientId: idSchema,
  item: text(255).min(1, 'Describe what is ordered'),
  toothId: optionalId,
  appointmentId: optionalId,
  /** What the lab charges the clinic. */
  cost: moneySchema,
  dueAt: optionalDate,
});
export type LabOrderInput = z.input<typeof labOrderInputSchema>;

export const labOrderUpdateSchema = labOrderInputSchema.omit({ patientId: true }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export interface LabOrderDto {
  id: number;
  lab: { id: number; name: string };
  patient: { id: number; fname: string; lname: string };
  item: string;
  tooth: { id: number; index: string } | null;
  appointmentId: number | null;
  /** What the lab charges the clinic: admins and staff only. */
  cost?: number;
  currency: string;
  status: LabStatus;
  sentAt: string | null;
  dueAt: string | null;
  receivedAt: string | null;
  /** Past its due date and not yet received. */
  overdue: boolean;
}

// ---------------------------------------------------------------------------
// Dashboard charts
// ---------------------------------------------------------------------------

/** What the dashboard's Insights section shows. Each role gets only the parts it may see; the rest is absent. */
export interface DashboardChartsDto {
  role: 'admin' | 'doctor' | 'staff';
  /** Admin and doctor: the last six months. A doctor's months hold only collections from his own patients (expenses are 0). */
  byMonth?: { month: string; payments: number; expenses: number }[];
  /** Admin and doctor: what patients owed at the end of each of the same six months (today for the current one), over the offers they have agreed to. A doctor's figure is his own patients' only. */
  debtsByMonth?: { month: string; owed: number }[];
  /** Admin and doctor: who owes the most, as things stand today. */
  topDebts?: { patient: { id: number; fname: string; lname: string }; owed: number }[];
  /** Admin and doctor: appointments in each of the same six months (the current month whole, upcoming days included), cancelled ones left out. A doctor's count is the visits he treats or his own patients'. */
  appointmentsByMonth?: { month: string; count: number }[];
  /** Admin and doctor: appointments of the last 30 days, by status. */
  appointmentsByStatus?: { status: string; count: number }[];
  /** Admin and doctor: the most booked procedures of the last 90 days (cancelled and no-show left out). */
  topProcedures?: { id: number; name: string; count: number }[];
  /** Staff: the next 7 days, today first, empty days included. */
  appointmentsPerDay?: { date: string; count: number }[];
  /** Staff: lab orders past their due date and not received. */
  overdueLabOrders?: { count: number; oldest: { id: number; item: string; lab: string; patient: { id: number; fname: string; lname: string }; dueAt: string }[] };
  /** Staff: accepted offers that still have work to book. */
  offersToBook?: number;
}
