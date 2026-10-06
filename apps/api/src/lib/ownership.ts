import type { Db } from '../db/connection';
import type { AuthUser } from '../middleware/auth';
import { notFound } from './errors';

/**
 * Object-level check against IDOR. Staff roles may access any patient; a patient may
 * only access the record linked to their own login (`patients.user_id`).
 * A foreign record yields 404 rather than 403 so ids can't be probed.
 */
export async function assertPatientAccess(db: Db, user: AuthUser, patientId: number): Promise<void> {
  if (user.role !== 'patient') return;
  const row = await db('patients').where({ id: patientId, user_id: user.id }).whereNull('deleted_at').first('id');
  if (!row) throw notFound('Patient not found');
}
