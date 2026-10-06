import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/** The monthly figures of the summary, and each doctor's own figures. */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  [admin, aya, staff, patient] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(() => t.destroy());

beforeEach(async () => {
  for (const table of ['payments', 'quotes', 'expenses', 'appointments']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ commission_percent: 30 });
});

const quote = async (patient_id: number, price: number, status = 'accepted') =>
  (await t.db('quotes').insert({ title: 'Q', type: 'clinic', price, cost: 0, currency: '$', status, patient_id, ...stamp }))[0]!;
const pay = (quote_id: number, amount: number, date: string, type = 'clinic') =>
  t.db('payments').insert({ date, type, amount, currency: '$', quote_id: type === 'clinic' ? quote_id : null, dr_part: 100, ...stamp });
const spend = (type: string, amount: number, date: string) => t.db('expenses').insert({ date, type, amount, currency: '$', ...stamp });
const summary = async (qs = '') => (await admin.get(`/finance/summary${qs}`)).body;

describe('month by month', () => {
  it('lists every month of the period, even the empty ones, with money in and out', async () => {
    const q = await quote(s.patientId, 5000);
    await pay(q, 100, '2026-08-10');
    await pay(q, 50, '2026-08-20');
    await pay(q, 300, '2026-10-02');
    await pay(0, 25, '2026-10-03', 'commission'); // commission counts as money in
    await spend('clinic', 40, '2026-08-11');
    await spend('lab', 60, '2026-09-05');
    await spend('clinic', 999, '2026-07-01'); // outside the period
    const r = await summary('?from=2026-08-01&to=2026-10-31');
    expect(r.byMonth).toEqual([
      { month: '2026-08', payments: 150, expenses: 40 },
      { month: '2026-09', payments: 0, expenses: 60 },
      { month: '2026-10', payments: 325, expenses: 0 },
    ]);
    expect(r.byMonth.reduce((n: number, m: { payments: number }) => n + m.payments, 0)).toBe(r.payments.total);
    expect(r.byMonth.reduce((n: number, m: { expenses: number }) => n + m.expenses, 0)).toBe(r.expenses.total);
  });

  it('runs from the first to the last month with anything in it when no period is given', async () => {
    const q = await quote(s.patientId, 5000);
    await pay(q, 10, '2026-03-15');
    await spend('clinic', 5, '2026-06-01');
    expect((await summary()).byMonth.map((m: { month: string }) => m.month)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
  });

  it('is empty when there is nothing at all, and leaves out deleted money', async () => {
    expect((await summary()).byMonth).toEqual([]);
    const q = await quote(s.patientId, 100);
    await t.db('payments').insert({ date: '2026-10-03', type: 'clinic', amount: 50, currency: '$', quote_id: q, dr_part: 100, deleted_at: '2026-10-04 00:00:00', ...stamp });
    await t.db('expenses').insert({ date: '2026-10-03', type: 'clinic', amount: 70, currency: '$', deleted_at: '2026-10-04 00:00:00', ...stamp });
    expect((await summary()).byMonth).toEqual([]);
  });

  it('keeps at most the last three years', async () => {
    await spend('clinic', 1, '2020-01-15');
    await spend('clinic', 1, '2026-10-15');
    const months = (await summary()).byMonth;
    expect(months).toHaveLength(36);
    expect(months.at(-1).month).toBe('2026-10');
  });
});

describe('each doctor’s figures', () => {
  const figures = async (c: Client, qs = '') => (await c.get(`/finance/doctors${qs}`)).body;
  const row = (r: { doctors: any[] }, id: number) => r.doctors.find((d) => d.doctor.id === id);  

  async function seed() {
    const mine = await quote(s.patientId, 400, 'accepted'); // Aya's patient
    await pay(mine, 150, '2026-10-02');
    await t.db('payments').where({ quote_id: mine }).update({ collected_by_doctor_id: s.doctorId });
    await quote(s.patientId, 100, 'draft'); // a draft is not a quote issued
    const existing = await t.db('patients').where({ patient_identifier: 'X1' }).first('id');
    const extPatient: number = existing?.id ?? (await t.db('patients').insert({ patient_identifier: 'X1', fname: 'Ext', lname: 'Pat', phone: '701', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
    const theirs = await quote(extPatient, 1000, 'accepted');
    await pay(theirs, 200, '2026-10-03');
    await t.db('payments').where({ quote_id: theirs }).update({ collected_by_doctor_id: s.externalDoctorId });
    return { extPatient };
  }

  it('gives an admin every doctor: quotes made, money collected, what their patients owe', async () => {
    await seed();
    const r = await figures(admin);
    expect(r.doctors.length).toBeGreaterThanOrEqual(4);
    expect(row(r, s.doctorId)).toMatchObject({ doctor: { kind: 'owner' }, offers: { count: 1, value: 400 }, collected: 150, debts: 250 });
    expect(row(r, s.externalDoctorId)).toMatchObject({ doctor: { kind: 'external' }, offers: { count: 1, value: 1000 }, collected: 200, debts: 800 });
    expect(row(r, s.saraId)).toMatchObject({ offers: { count: 0, value: 0 }, collected: 0, debts: 0 });
  });

  it('applies the period to quotes and collections, but debts are as things stand', async () => {
    await seed();
    const early = await figures(admin, '?from=2026-10-03&to=2026-10-03');
    expect(row(early, s.doctorId).collected).toBe(0);
    expect(row(early, s.externalDoctorId).collected).toBe(200);
    expect(row(early, s.doctorId).debts).toBe(250);
    await t.db('quotes').update({ created_at: '2026-01-05 10:00:00' });
    expect(row(await figures(admin, '?from=2026-10-01'), s.doctorId).offers.count).toBe(0);
    expect(row(await figures(admin, '?from=2026-01-05&to=2026-01-05'), s.doctorId).offers.count).toBe(1); // the last day counts, whatever the hour
  });

  it('shows an owner what specialists still owe him and a specialist what he owes, with fees', async () => {
    const { extPatient } = await seed();
    await t.db('appointments').insert({ date: '2026-09-20', time: '10:00', status: 'completed', patient_id: extPatient, doctor_id: s.externalDoctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp });
    const visit = (await t.db('appointments').insert({ date: '2026-10-01', time: '10:00', status: 'completed', patient_id: s.patientId, doctor_id: s.externalDoctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp }))[0]!;
    await admin.post('/expenses', { type: 'commission', date: '2026-10-02', amount: 35, doctorId: s.externalDoctorId, appointmentId: visit });
    const r = await figures(admin);
    expect(row(r, s.doctorId)).toMatchObject({ commissionBalance: 60, fees: 35 }); // 30% of the 200 collected, on Aya's unit
    expect(row(r, s.externalDoctorId)).toMatchObject({ commissionBalance: 60, fees: 35 }); // the same 60, owed by him; the fee he was paid
    expect(row(r, s.saraId)).toMatchObject({ commissionBalance: 0, fees: 0 });
    await t.db('doctors').where({ id: s.externalDoctorId }).update({ commission_percent: null });
    expect(row(await figures(admin), s.externalDoctorId).commissionBalance).toBeNull(); // not guessed
  });

  it('shows a doctor only himself, and staff and patients nothing', async () => {
    await seed();
    const mine = await figures(aya);
    expect(mine.doctors).toHaveLength(1);
    expect(mine.doctors[0]).toMatchObject({ doctor: { id: s.doctorId }, collected: 150 });
    expect(mine.doctors[0].doctor).not.toHaveProperty('email');
    for (const c of [staff, patient]) expect((await c.get('/finance/doctors')).status).toBe(403);
    expect((await t.client().get('/finance/doctors')).status).toBe(401);
  });

  it('gives a doctor login that is not linked to a doctor profile nothing', async () => {
    const id = (await t.db('users').where({ email: 'doctor@clinic.test' }).first('id')).id;
    await t.db('doctors').where({ id: s.doctorId }).update({ user_id: null });
    expect((await figures(aya)).doctors).toEqual([]);
    await t.db('doctors').where({ id: s.doctorId }).update({ user_id: id });
  });
});

describe('lab and supplier spending', () => {
  it('breaks the expenses down by lab and by supplier, biggest first, inside the period only', async () => {
    const [kadi] = await t.db('labs').insert({ name: 'Kadi Lab', phone: '1', ...stamp });
    const [other] = await t.db('labs').insert({ name: 'Other Lab', phone: '2', ...stamp });
    const [safadi] = await t.db('suppliers').insert({ name: 'Safadi', phone: '3', ...stamp });
    const lab = (model_id: number, amount: number, date: string) => t.db('expenses').insert({ date, type: 'lab', model_id, amount, currency: '$', ...stamp });
    await lab(kadi!, 60, '2026-10-01');
    await lab(kadi!, 40, '2026-10-02');
    await lab(other!, 250, '2026-10-03');
    await lab(other!, 999, '2026-01-01'); // outside the period
    await t.db('expenses').insert({ date: '2026-10-04', type: 'supplier', model_id: safadi, amount: 75.5, currency: '$', ...stamp });
    await spend('clinic', 10, '2026-10-05'); // not a lab or supplier
    const r = await summary('?from=2026-10-01&to=2026-10-31');
    expect(r.expenses.byLab).toEqual([{ id: other, name: 'Other Lab', total: 250 }, { id: kadi, name: 'Kadi Lab', total: 100 }]);
    expect(r.expenses.bySupplier).toEqual([{ id: safadi, name: 'Safadi', total: 75.5 }]);
    expect(r.expenses.total).toBe(435.5);
    await t.db('labs').whereIn('id', [kadi!, other!]).del();
    await t.db('suppliers').where({ id: safadi }).del();
  });

  it('leaves out deleted expenses and gives empty lists when there are none', async () => {
    expect((await summary()).expenses).toMatchObject({ byLab: [], bySupplier: [] });
  });
});
