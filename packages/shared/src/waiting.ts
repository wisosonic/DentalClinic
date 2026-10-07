import { z } from 'zod';

// ---------------------------------------------------------------------------
// The waiting room (owner request 2026-10-07): numbers given at the desk, the doctor's list, calling by number,
// and a screen in the waiting room that shows the number called and the dental unit to go to.
// ---------------------------------------------------------------------------

export const WAITING_STATUSES = ['waiting', 'called', 'done', 'left'] as const;
export type WaitingStatus = (typeof WAITING_STATUSES)[number];

/** call (or call again) · finish (the visit is over) · leave (did not come, or went away) · requeue (back to waiting) */
export const WAITING_ACTIONS = ['call', 'finish', 'leave', 'requeue'] as const;
export type WaitingAction = (typeof WAITING_ACTIONS)[number];

const id = z.number().int().positive();

/**
 * Giving a patient a number: for an expected appointment (its doctor and dental unit are used), or for anyone
 * else with the doctor and the dental unit chosen.
 */
export const waitingCheckInSchema = z
  .object({
    patientId: id,
    appointmentId: id.optional(),
    doctorId: id.optional(),
    unitId: id.optional(),
  })
  .refine((v) => v.appointmentId !== undefined || (v.doctorId !== undefined && v.unitId !== undefined), { message: 'Choose the doctor and the dental unit' });
export type WaitingCheckInInput = z.input<typeof waitingCheckInSchema>;

export interface WaitingTicketDto {
  id: number;
  /** Starts again at 1 every day, in each clinic. */
  number: number;
  date: string;
  status: WaitingStatus;
  patient: { id: number; fname: string; lname: string };
  doctor: { id: number; fname: string; lname: string };
  unit: { id: number; name: string } | null;
  /** The appointment the patient came for, when there is one. */
  appointment: { id: number; time: string; procedures: string[] } | null;
  arrivedAt: string;
  calledAt: string | null;
  /** How many times the patient has been called (calling again adds one). */
  callCount: number;
  finishedAt: string | null;
}

export interface WaitingListDto {
  /** Today, at the clinic. */
  date: string;
  data: WaitingTicketDto[];
}

/** An expected appointment of today whose patient has not been given a number yet. */
export interface WaitingCandidateDto {
  appointmentId: number;
  time: string;
  patient: { id: number; fname: string; lname: string };
  doctor: { id: number; fname: string; lname: string };
  unit: { id: number; name: string } | null;
}

/** What the waiting-room screen may show: numbers and dental units, never a name. */
export interface WaitingDisplayDto {
  /** The patients being called now, the most recent call first: one per dental unit. */
  calls: { number: number; unit: string | null; calledAt: string; callCount: number }[];
  /** How many are waiting. */
  waiting: number;
  clinic: string | null;
}

export interface WaitingScreenDto {
  /** The secret in the screen's address; null until it is first made. */
  key: string | null;
  /** The address to open on the waiting-room screen, relative to the site. */
  path: string | null;
}
