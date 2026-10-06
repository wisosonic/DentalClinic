import type { AppContext } from '../../context';
import { contactOverride } from '../settings/app';

/** The clinic on a document: where the patient was last seen, otherwise the first clinic. */
export async function clinicLetterhead(db: AppContext['db'], patientId: number) {
  const last = await db('appointments as a').join('clinics as c', 'c.id', 'a.clinic_id').where('a.patient_id', patientId).whereNull('a.deleted_at')
    .orderBy([{ column: 'a.date', order: 'desc' }, { column: 'a.time', order: 'desc' }]).first('c.name', 'c.address', 'c.phone');
  const c = last ?? (await db('clinics').orderBy('id').first('name', 'address', 'phone'));
  const contact = await contactOverride(db); // contact details saved in Settings replace the clinic record's
  return {
    name: (c?.name as string | undefined) ?? 'Clinic',
    address: contact.address ?? (c?.address as string | null | undefined) ?? null,
    phone: contact.phone ?? (c?.phone as string | null | undefined) ?? null,
    email: contact.email ?? null,
  };
}
