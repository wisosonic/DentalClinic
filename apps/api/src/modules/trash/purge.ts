import type { Db } from '../../db/connection';

export type TrashKind = 'patient' | 'appointment' | 'report' | 'offer' | 'payment' | 'commission' | 'expense' | 'lab_order' | 'document';
export const TRASH_KINDS: TrashKind[] = ['patient', 'appointment', 'report', 'offer', 'payment', 'commission', 'expense', 'lab_order', 'document'];

export const TRASH_TABLES: Record<TrashKind, string> = {
  patient: 'patients', appointment: 'appointments', report: 'reports', offer: 'treatment_offers', payment: 'payments', commission: 'payments', expense: 'expenses', lab_order: 'lab_orders', document: 'patient_documents',
};

type Conn = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Everything that goes when one record is erased for good. Ids only. */
export interface Footprint {
  patients: number[];
  appointments: number[];
  reports: number[];
  offers: number[];
  payments: number[];
  expenses: number[];
  labOrders: number[];
  documents: number[];
  /** The patient's own sign-in, if they had one. */
  userId: number | null;
}

export type Counts = Record<'patients' | 'appointments' | 'reports' | 'reportToothNotes' | 'prescriptionLines' | 'offers' | 'payments' | 'expenses' | 'labOrders' | 'documents' | 'logins', number>;

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

/** Works out what erasing this record would remove. */
export async function footprint(db: Conn, kind: TrashKind, id: number): Promise<Footprint> {
  const none: Footprint = { patients: [], appointments: [], reports: [], offers: [], payments: [], expenses: [], labOrders: [], documents: [], userId: null };
  if (kind === 'report') return { ...none, reports: [id] };
  if (kind === 'payment' || kind === 'commission') return { ...none, payments: [id] };
  if (kind === 'expense') return { ...none, expenses: [id] };
  if (kind === 'lab_order') return { ...none, labOrders: [id] };
  if (kind === 'document') return { ...none, documents: [id] };
  if (kind === 'offer') {
    return { ...none, offers: [id], payments: ids(await db('payments').where({ offer_id: id }).select('id')) };
  }
  if (kind === 'appointment') {
    return { ...none, appointments: [id], reports: ids(await db('reports').where({ appointment_id: id }).select('id')) };
  }
  const patient = await db('patients').where({ id }).first('id', 'user_id');
  if (!patient) return none;
  const appointments = ids(await db('appointments').where({ patient_id: id }).select('id'));
  const offers = ids(await db('treatment_offers').where({ patient_id: id }).select('id'));
  const login = patient.user_id ? await db('users').where({ id: patient.user_id, role: 'patient' }).first('id') : null;
  return {
    ...none,
    patients: [id],
    appointments,
    reports: appointments.length ? ids(await db('reports').whereIn('appointment_id', appointments).select('id')) : [],
    offers,
    payments: offers.length ? ids(await db('payments').whereIn('offer_id', offers).select('id')) : [],
    labOrders: ids(await db('lab_orders').where({ patient_id: id }).select('id')),
    documents: ids(await db('patient_documents').where({ patient_id: id }).select('id')),
    userId: login?.id ?? null,
  };
}

export async function countsOf(db: Conn, f: Footprint): Promise<Counts> {
  const n = async (table: string, column: string, values: number[]) =>
    values.length ? Number((await db(table).whereIn(column, values).count({ n: '*' }).first())?.n ?? 0) : 0;
  return {
    patients: f.patients.length,
    appointments: f.appointments.length,
    reports: f.reports.length,
    reportToothNotes: await n('report_tooth', 'report_id', f.reports),
    prescriptionLines: await n('medication_report', 'report_id', f.reports),
    offers: f.offers.length,
    payments: f.payments.length,
    expenses: f.expenses.length,
    labOrders: f.labOrders.length,
    documents: f.documents.length,
    logins: f.userId ? 1 : 0,
  };
}

/**
 * Erases the records for good, children before parents. Run it inside a transaction.
 * Nothing here is recoverable: the caller has already checked that the item is in the Trash.
 */
export async function erase(trx: Conn, f: Footprint): Promise<void> {
  const del = async (table: string, column: string, values: number[]) => {
    if (values.length) await trx(table).whereIn(column, values).del();
  };
  await del('medication_report', 'report_id', f.reports);
  await del('report_tooth', 'report_id', f.reports);
  await del('reports', 'id', f.reports);
  await del('payments', 'id', f.payments);
  await del('expenses', 'id', f.expenses);
  await del('offer_items', 'offer_id', f.offers);
  await del('lab_orders', 'id', f.labOrders);
  await del('patient_documents', 'id', f.documents);
  // an item whose visit is erased can be booked again
  if (f.appointments.length) await trx('offer_items').whereIn('appointment_id', f.appointments).where({ status: 'scheduled' }).update({ status: 'pending', appointment_id: null });
  await del('appointment_category', 'appointment_id', f.appointments);
  await del('appointment_tooth', 'appointment_id', f.appointments);
  await del('appointments', 'id', f.appointments);
  await del('treatment_offers', 'id', f.offers);
  await del('waiting_tickets', 'patient_id', f.patients); // the numbers given at the desk: day-to-day records, not counted in the warning
  await del('event_patient', 'patient_id', f.patients);
  await del('patient_relatives', 'patient_id', f.patients);
  await del('patient_relatives', 'relative_id', f.patients);
  await del('patients', 'id', f.patients);
  if (f.userId) {
    await trx('refresh_tokens').where({ user_id: f.userId }).del();
    await trx('password_reset_tokens').where({ user_id: f.userId }).del();
    await trx('users').where({ id: f.userId }).del();
  }
}
