import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * The debts page (owner request 2026-10-11): one row for each patient who still owes, from their accepted treatment offers
 * with a balance, as things stand today. An admin sees every patient; a doctor only the patients whose primary doctor he is;
 * staff and patients nothing.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, sara: Client, staff: Client, patient: Client, ext: Client;
let extPatient: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const user = async (name: string, email: string) => (await t.db('users').insert({ name, email, role: 'doctor', password: hash, ...stamp }))[0]!;
  await t.db('doctors').where({ id: s.saraId }).update({ user_id: await user('Dr Sara', 'sara@clinic.test') });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: await user('Ext Doc', 'ext@clinic.test') });
  [admin, aya, sara, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'sara@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  extPatient = (await t.db('patients').insert({ patient_identifier: 'E1', fname: 'Ext', lname: 'Pat', phone: '701', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['payments', 'offer_items', 'treatment_offers']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
});

const offer = async (patientId: number, price: number, extra: object = {}) =>
  (await t.db('treatment_offers').insert({ title: 'Crown', type: 'treatment', price, cost: 0, currency: '$', status: 'accepted', patient_id: patientId, ...stamp, ...extra }))[0]!;
const pay = (offerId: number, amount: number, date: string, extra: object = {}) =>
  t.db('payments').insert({ date, type: 'clinic', amount, remaining: 0, currency: '$', offer_id: offerId, ...stamp, ...extra });
const debts = (c: Client) => c.get('/finance/debts');

describe('GET /finance/debts', () => {
  it('has one row for each patient who owes, with what they owe, since when and their last payment, the biggest first', async () => {
    const a = await offer(s.patientId, 300, { created_at: '2026-03-01 09:00:00' });
    await offer(s.patientId, 100, { created_at: '2026-06-01 09:00:00' });
    await pay(a, 100, '2026-04-10');
    await pay(a, 50, '2026-05-20');
    await offer(s.otherPatientId, 80);
    const res = await debts(admin);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ owed: 330, patients: 2, offers: 3 });
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toEqual({
      patient: { id: s.patientId, fname: 'Pat', lname: 'Patient', phone: '70111111' },
      doctor: { id: s.doctorId, fname: 'Aya', lname: 'Ghali' },
      offers: 2, price: 400, paid: 150, owed: 250, since: '2026-03-01', lastPayment: '2026-05-20',
    });
    expect(res.body.data[1]).toMatchObject({ patient: { id: s.otherPatientId }, doctor: null, offers: 1, owed: 80, paid: 0, lastPayment: null });
  });

  it('leaves out everything that is not a debt: drafts, cancelled and paid-up offers, overpaid ones, deleted offers and patients, and deleted payments', async () => {
    await offer(s.patientId, 100, { status: 'draft' });
    await offer(s.patientId, 100, { status: 'cancelled' });
    await offer(s.patientId, 100, { deleted_at: '2026-10-01 00:00:00' });
    const paidUp = await offer(s.patientId, 100);
    await pay(paidUp, 100, '2026-04-10');
    const over = await offer(s.patientId, 100);
    await pay(over, 130, '2026-04-10'); // clients are sometimes generous: not owed, not negative
    const partly = await offer(s.patientId, 100);
    await pay(partly, 60, '2026-04-10');
    await pay(partly, 25, '2026-05-10', { deleted_at: '2026-10-01 00:00:00' }); // a deleted payment does not count
    const res = await debts(admin);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ offers: 1, price: 100, paid: 60, owed: 40, lastPayment: '2026-04-10' });
    expect(res.body.totals).toEqual({ owed: 40, patients: 1, offers: 1 });
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await debts(admin)).body).toEqual({ data: [], totals: { owed: 0, patients: 0, offers: 0 } });
  });

  it('rounds to cents', async () => {
    const o = await offer(s.patientId, 100.1);
    await pay(o, 33.3, '2026-04-10');
    await pay(o, 33.3, '2026-04-11');
    expect((await debts(admin)).body.data[0].owed).toBe(33.5);
  });

  it('gives a doctor only the patients whose primary doctor he is', async () => {
    await offer(s.patientId, 100); // Aya's
    await offer(s.otherPatientId, 50); // nobody's
    await offer(extPatient, 70); // the specialist's
    const rows = (c: Client) => c.get('/finance/debts').then((r) => r.body);
    expect((await rows(aya)).data.map((d: { patient: { id: number } }) => d.patient.id)).toEqual([s.patientId]);
    expect((await rows(aya)).totals).toEqual({ owed: 100, patients: 1, offers: 1 });
    expect((await rows(sara)).data).toEqual([]); // another doctor's patients are not his
    expect((await rows(ext)).data.map((d: { patient: { id: number } }) => d.patient.id)).toEqual([extPatient]);
    expect((await rows(admin)).totals.patients).toBe(3);
  });

  it('is closed to staff and patients, and to anyone signed out', async () => {
    await offer(s.patientId, 100);
    expect((await debts(staff)).status).toBe(403);
    expect((await debts(patient)).status).toBe(403);
    expect([401, 403]).toContain((await t.client().get('/finance/debts')).status);
  });

  it('follows the Roles page: a doctor without payment access sees nothing', async () => {
    const permissions = (await admin.get('/roles')).body.roles.find((r: { role: string }) => r.role === 'doctor').permissions as string[];
    expect((await admin.put('/roles/doctor', { permissions: permissions.filter((p) => !p.startsWith('payments:')) })).status).toBe(200);
    try {
      expect((await debts(aya)).status).toBe(403);
      expect((await debts(admin)).status).toBe(200);
    } finally {
      await admin.post('/roles/doctor/reset', {});
    }
  });
});
