import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/** The counts behind the badges on the patient page's buttons (owner request 2026-10-09). */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let kin: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  kin = (await t.db('patients').insert({ patient_identifier: '3001', fname: 'Kin', lname: 'Of', phone: '70999', doctor_id: s.doctorId, ...stamp }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['payments', 'offer_items', 'treatment_offers', 'patient_documents', 'patient_relatives', 'appointments']) await t.db(table).del();
  const appt = (extra: object) => t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp, ...extra });
  await appt({});
  await appt({ time: '11:00', status: 'cancelled' }); // a cancelled visit is still a visit in the history
  await appt({ time: '12:00', deleted_at: '2026-10-01 00:00:00' }); // in the Trash: not counted
  const offer = async (extra: object) => (await t.db('treatment_offers').insert({ title: 'Crown', type: 'treatment', price: 100, cost: 0, currency: '$', status: 'accepted', patient_id: s.patientId, ...stamp, ...extra }))[0]!;
  const offerId = await offer({});
  await offer({ deleted_at: '2026-10-01 00:00:00' });
  await t.db('payments').insert([
    { date: TODAY, type: 'clinic', amount: 30, remaining: 70, currency: '$', offer_id: offerId, ...stamp },
    { date: TODAY, type: 'clinic', amount: 20, remaining: 50, currency: '$', offer_id: offerId, ...stamp },
    { date: TODAY, type: 'clinic', amount: 5, remaining: 45, currency: '$', offer_id: offerId, deleted_at: '2026-10-01 00:00:00', ...stamp },
  ]);
  const doc = (n: number, extra: object = {}) => t.db('patient_documents').insert({ patient_id: s.patientId, category: 'xray', title: `Scan ${n}`, file_name: `doc-${n}.png`, original_name: 'x.png', mime: 'image/png', size_bytes: 10, sha256: String(n).padEnd(64, '0'), ...stamp, ...extra });
  await doc(1);
  await doc(2, { deleted_at: '2026-10-01 00:00:00' });
  await t.db('patient_relatives').insert({ patient_id: s.patientId, relative_id: kin, relation: 'sibling', ...stamp });
});

const counts = (c: Client, id = s.patientId) => c.get(`/patients/${id}/counts`);

describe('GET /patients/:id/counts', () => {
  it('gives an admin every figure, leaving out what is in the Trash', async () => {
    const res = await counts(admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ appointments: 2, family: 1, payments: 2, offers: 1, documents: 1 });
  });

  it('gives the primary doctor the same, and staff everything but payments, which they cannot browse', async () => {
    expect((await counts(aya)).body).toEqual({ appointments: 2, family: 1, payments: 2, offers: 1, documents: 1 });
    expect((await counts(staff)).body).toEqual({ appointments: 2, family: 1, payments: null, offers: 1, documents: 1 });
  });

  it('hides a relative who has been deleted from the family figure', async () => {
    await t.db('patients').where({ id: kin }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await counts(admin)).body.family).toBe(0);
    await t.db('patients').where({ id: kin }).update({ deleted_at: null });
  });

  it('counts only what a doctor may open: another doctor’s patient has no payments or offers for him', async () => {
    await t.db('doctors').where({ id: s.saraId }).update({ user_id: null });
    const [sara] = await t.db('users').insert({ name: 'Dr Sara', email: 'sara@clinic.test', role: 'doctor', password: bcrypt.hashSync(PASSWORD, 4), ...stamp });
    await t.db('doctors').where({ id: s.saraId }).update({ user_id: sara });
    const saraClient = await loggedIn(t, 'sara@clinic.test');
    const body = (await counts(saraClient)).body; // an owner doctor works clinic-wide, but money follows the primary doctor
    expect(body).toMatchObject({ appointments: 2, payments: 0, offers: 0, documents: 1 });
  });

  it('keeps an external specialist to his own patients', async () => {
    expect((await counts(ext)).status).toBe(404); // Pat is Aya's patient
    const mine = (await t.db('patients').insert({ patient_identifier: '3002', fname: 'My', lname: 'Own', phone: '7011', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
    expect((await counts(ext, mine)).body).toEqual({ appointments: 0, family: 0, payments: 0, offers: 0, documents: 0 });
  });

  it('answers 404 for an unknown or deleted patient, and refuses patients and anyone signed out', async () => {
    expect((await counts(admin, 999999)).status).toBe(404);
    await t.db('patients').where({ id: kin }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await counts(admin, kin)).status).toBe(404);
    await t.db('patients').where({ id: kin }).update({ deleted_at: null });
    expect((await counts(patient)).status).toBe(403);
    expect([401, 403]).toContain((await t.client().get(`/patients/${s.patientId}/counts`)).status);
  });
});
