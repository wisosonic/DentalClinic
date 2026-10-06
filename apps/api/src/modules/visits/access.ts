import type { Db } from '../../db/connection';
import type { AuthUser } from '../../middleware/auth';

/** What one signed-in user may do with the visit report of one appointment. */
export interface ReportAccess {
  read: boolean;
  write: boolean;
  /** Sees the clinical detail (per-tooth notes). A patient never does. */
  full: boolean;
}

export const NO_ACCESS: ReportAccess = { read: false, write: false, full: false };

/** The fields the access rules need about an appointment and its patient. */
export interface AccessSubject {
  doctor_id: number;
  patient_user_id: number | null;
  patient_doctor_id: number | null;
}

/** The doctor profile linked to a login, if any (`doctors.user_id`). */
export async function doctorIdFor(db: Db, userId: number): Promise<number | null> {
  return (await db('doctors').where({ user_id: userId }).first('id'))?.id ?? null;
}

/**
 * Builds the visit-report access rules for one user (owner decisions, 2026-10-01):
 *  - admin: reads and edits everything
 *  - the treating doctor (the appointment's doctor): reads and edits
 *  - the patient's primary doctor: reads
 *  - staff: read only
 *  - the patient: reads their own, without the per-tooth notes
 *  - any other doctor: nothing (the caller answers 404)
 * A doctor login that isn't linked to a doctor profile has no access, since the app can't tell who they are.
 */
export async function accessChecker(db: Db, user: AuthUser): Promise<(a: AccessSubject) => ReportAccess> {
  const me = user.role === 'doctor' ? await doctorIdFor(db, user.id) : null;

  return (a) => {
    switch (user.role) {
      case 'admin':
        return { read: true, write: true, full: true };
      case 'staff':
        return { read: true, write: false, full: true };
      case 'patient':
        return a.patient_user_id === user.id ? { read: true, write: false, full: false } : NO_ACCESS;
      case 'doctor': {
        if (!me) return NO_ACCESS;
        const treating = a.doctor_id === me;
        return treating || a.patient_doctor_id === me ? { read: true, write: treating, full: true } : NO_ACCESS;
      }
      default:
        return NO_ACCESS;
    }
  };
}
