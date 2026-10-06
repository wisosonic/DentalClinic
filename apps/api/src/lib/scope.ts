import type { Db } from '../db/connection';
import type { AuthUser } from '../middleware/auth';

/**
 * What part of the clinic a doctor login may see (owner decision, 2026-10-01).
 *
 *  - Owner doctors, admins and staff work clinic-wide: `restricted` is false.
 *  - An **external specialist** is restricted to two cases:
 *      1. a patient who belongs to him (`patients.doctor_id` is him): full working access;
 *      2. an appointment he treats for another doctor's patient: he sees that appointment and
 *         writes its report, but cannot browse the patient's profile, history or data.
 *  - A doctor login that is not linked to a doctor profile is treated as restricted with no
 *    identity, so it sees nothing: the app can't tell who it is, and fails closed.
 */
export interface DoctorScope {
  restricted: boolean;
  /** The linked doctor profile, or null. */
  doctorId: number | null;
}

export const UNRESTRICTED: DoctorScope = { restricted: false, doctorId: null };

export async function doctorScope(db: Db, user: AuthUser): Promise<DoctorScope> {
  if (user.role !== 'doctor') return UNRESTRICTED;
  const profile = await db('doctors').where({ user_id: user.id }).first('id', 'kind');
  if (!profile) return { restricted: true, doctorId: null };
  return { restricted: profile.kind === 'external', doctorId: profile.id };
}

/** Is this patient one of the restricted doctor's own? Always true for unrestricted viewers. */
export const ownsPatient = (scope: DoctorScope, patientDoctorId: number | null | undefined): boolean =>
  !scope.restricted || (scope.doctorId !== null && patientDoctorId === scope.doctorId);

/** Does this appointment concern the restricted doctor at all (his patient, or he treats it)? */
export const involvedIn = (scope: DoctorScope, a: { doctor_id: number; p_doctor_id?: number | null }): boolean =>
  !scope.restricted || (scope.doctorId !== null && (a.doctor_id === scope.doctorId || a.p_doctor_id === scope.doctorId));

/** May he change this appointment? Only when the patient is his own and he is the one treating. */
export const canManageAppointment = (scope: DoctorScope, a: { doctor_id: number; p_doctor_id?: number | null }): boolean =>
  !scope.restricted || (scope.doctorId !== null && a.doctor_id === scope.doctorId && a.p_doctor_id === scope.doctorId);
