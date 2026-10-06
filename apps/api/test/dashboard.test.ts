import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * The dashboard's charts. TODAY is 2026-10-05. An admin sees the clinic, a doctor only his own patients
 * (and no expenses), staff the front desk's view without any money, and a patient nothing.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let extPatient: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  extPatient = (await t.db('patients').insert({ patient_identifier: 'E1', fname: 'Ext', lname: 'Pat', phone: '701', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['payments', 'offer_items', 'quotes', 'expenses', 'appointment_category', 'appointments', 'lab_orders']) await t.db(table).del();
});

const charts = async (c: Client) => (await c.get('/dashboard/charts')).body;
const quote = async (patient_id: number, price: number, status = 'accepted') =>
  (await t.db('quotes').insert({ title: 'Q', type: 'clinic', price, cost: 0, currency: '$', status, patient_id, ...stamp }))[0]!;
const pay = (quote_id: number, amount: number, date: string) => t.db('payments').insert({ date, type: 'clinic', amount, currency: '$', quote_id, dr_part: 100, ...stamp });
const visit = async (patient_id: number, doctor_id: number, date: string, status = 'completed', time = '10:00') =>
  (await t.db('appointments').insert({ date, time, status, patient_id, doctor_id, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp }))[0]!;

describe('who may open the charts', () => {
  it('is for admin, doctors and staff, not patients or visitors', async () => {
    for (const c of [admin, aya, ext, staff]) expect((await c.get('/dashboard/charts')).status).toBe(200);
    expect((await patient.get('/dashboard/charts')).status).toBe(403);
    expect((await t.client().get('/dashboard/charts')).status).toBe(401);
  });

  it('gives a doctor with no linked profile empty lists', async () => {
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await t.db('users').insert({ name: 'Loose Doc', email: 'loose@clinic.test', role: 'doctor', password: hash, ...stamp });
    const loose = await loggedIn(t, 'loose@clinic.test');
    expect(await charts(loose)).toEqual({ role: 'doctor', byMonth: [], topDebts: [], appointmentsByStatus: [], topProcedures: [] });
  });
});

describe('admin and doctor', () => {
  it('lists the last six months, empty ones included, with payments and expenses for an admin', async () => {
    const q = await quote(s.patientId, 5000);
    await pay(q, 100, '2026-10-02');
    await pay(q, 40, '2026-07-15');
    await pay(q, 999, '2026-03-01'); // older than six months
    await t.db('expenses').insert({ date: '2026-10-03', type: 'clinic', amount: 30, currency: '$', ...stamp });
    const r = await charts(admin);
    expect(r.role).toBe('admin');
    expect(r.byMonth.map((m: { month: string }) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(r.byMonth.find((m: { month: string }) => m.month === '2026-10')).toEqual({ month: '2026-10', payments: 100, expenses: 30 });
    expect(r.byMonth.find((m: { month: string }) => m.month === '2026-07')).toEqual({ month: '2026-07', payments: 40, expenses: 0 });
  });

  it('agrees with the Summary for the same period', async () => {
    const q = await quote(s.patientId, 5000);
    await pay(q, 120.5, '2026-10-01');
    await t.db('expenses').insert({ date: '2026-10-04', type: 'lab', amount: 20, currency: '$', ...stamp });
    const dash = (await charts(admin)).byMonth.find((m: { month: string }) => m.month === '2026-10');
    const summary = (await admin.get('/finance/summary?from=2026-10-01&to=2026-10-31')).body;
    expect(dash).toEqual(summary.byMonth[0]);
  });

  it('shows a doctor only collections from his own patients, never expenses', async () => {
    const mine = await quote(s.patientId, 1000);
    const theirs = await quote(extPatient, 1000);
    await pay(mine, 200, '2026-10-02');
    await pay(theirs, 700, '2026-10-02');
    await t.db('expenses').insert({ date: '2026-10-03', type: 'clinic', amount: 50, currency: '$', ...stamp });
    const a = await charts(aya);
    expect(a.role).toBe('doctor');
    expect(a.byMonth.at(-1)).toEqual({ month: '2026-10', payments: 200, expenses: 0 });
    expect((await charts(ext)).byMonth.at(-1)).toEqual({ month: '2026-10', payments: 700, expenses: 0 });
    expect((await charts(admin)).byMonth.at(-1)).toEqual({ month: '2026-10', payments: 900, expenses: 50 });
  });

  it('lists the five biggest debts, biggest first, from open offers only, and a doctor his own patients’ only', async () => {
    const big = await quote(s.patientId, 800);
    await pay(big, 300, '2026-10-01'); // 500 left
    await quote(extPatient, 900); // 900 left
    await quote(s.otherPatientId, 40, 'draft'); // a draft is no debt
    await quote(s.otherPatientId, 70, 'rejected');
    expect((await charts(admin)).topDebts.map((d: { owed: number }) => d.owed)).toEqual([900, 500]);
    expect((await charts(aya)).topDebts).toEqual([{ patient: { id: s.patientId, fname: 'Pat', lname: 'Patient' }, owed: 500 }]);
    expect((await charts(ext)).topDebts.map((d: { owed: number }) => d.owed)).toEqual([900]);
  });

  it('counts the last 30 days of appointments by status, with every status listed', async () => {
    await visit(s.patientId, s.doctorId, '2026-10-01', 'completed');
    await visit(s.patientId, s.doctorId, '2026-09-20', 'cancelled', '11:00');
    await visit(s.patientId, s.doctorId, '2026-08-01', 'completed', '12:00'); // too old
    await visit(extPatient, s.externalDoctorId, '2026-10-02', 'no_show');
    const count = (r: { appointmentsByStatus: { status: string; count: number }[] }, status: string) => r.appointmentsByStatus.find((x) => x.status === status)!.count;
    const all = await charts(admin);
    expect(all.appointmentsByStatus.map((x: { status: string }) => x.status)).toEqual(['pending', 'confirmed', 'completed', 'cancelled', 'no_show']);
    expect([count(all, 'completed'), count(all, 'cancelled'), count(all, 'no_show')]).toEqual([1, 1, 1]);
    const mine = await charts(aya);
    expect([count(mine, 'completed'), count(mine, 'cancelled'), count(mine, 'no_show')]).toEqual([1, 1, 0]);
  });

  it('ranks the most booked procedures of the last 90 days, leaving out cancelled visits', async () => {
    const [c1, c2] = s.categoryIds;
    const a1 = await visit(s.patientId, s.doctorId, '2026-10-01', 'completed', '09:00');
    const a2 = await visit(s.patientId, s.doctorId, '2026-10-02', 'confirmed', '09:00');
    const a3 = await visit(s.patientId, s.doctorId, '2026-10-03', 'cancelled', '09:00');
    const old = await visit(s.patientId, s.doctorId, '2026-05-01', 'completed', '09:00');
    const link = (appointment_id: number, category_id: number) => t.db('appointment_category').insert({ appointment_id, category_id, ...stamp });
    await link(a1, c1!); await link(a2, c1!); await link(a1, c2!); await link(a3, c2!); await link(old, c2!);
    const r = await charts(admin);
    expect(r.topProcedures.map((p: { id: number; count: number }) => [p.id, p.count])).toEqual([[c1, 2], [c2, 1]]);
    expect((await charts(ext)).topProcedures).toEqual([]);
  });

  it('is empty, not broken, on an empty clinic', async () => {
    const r = await charts(admin);
    expect(r.topDebts).toEqual([]);
    expect(r.topProcedures).toEqual([]);
    expect(r.byMonth.every((m: { payments: number; expenses: number }) => m.payments === 0 && m.expenses === 0)).toBe(true);
  });
});

describe('staff', () => {
  it('gets no money at all', async () => {
    const q = await quote(s.patientId, 100);
    await pay(q, 50, '2026-10-02');
    const r = await charts(staff);
    expect(r.role).toBe('staff');
    for (const key of ['byMonth', 'topDebts', 'topProcedures', 'appointmentsByStatus']) expect(r[key]).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/owed|payments|expenses/);
  });

  it('lists the next seven days, today first, with the empty days', async () => {
    await visit(s.patientId, s.doctorId, TODAY, 'confirmed', '09:00');
    await visit(s.patientId, s.doctorId, TODAY, 'pending', '10:00');
    await visit(s.patientId, s.doctorId, '2026-10-08', 'confirmed', '09:00');
    await visit(s.patientId, s.doctorId, '2026-10-09', 'cancelled', '09:00'); // not counted
    await visit(s.patientId, s.doctorId, '2026-10-12', 'confirmed', '09:00'); // eight days ahead
    const days = (await charts(staff)).appointmentsPerDay;
    expect(days.map((d: { date: string }) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(days.map((d: { count: number }) => d.count)).toEqual([2, 0, 0, 1, 0, 0, 0]);
  });

  it('counts overdue lab orders and names the five oldest', async () => {
    const [lab] = await t.db('labs').insert({ name: 'Kadi Lab', phone: '1', ...stamp });
    const order = (due_at: string | null, status: string, item: string) => t.db('lab_orders').insert({ lab_id: lab, patient_id: s.patientId, item, cost: 10, currency: '$', due_at, status, ...stamp });
    await order('2026-09-20', 'sent', 'Oldest');
    await order('2026-10-01', 'draft', 'Newer');
    await order('2026-10-05', 'sent', 'Due today'); // not overdue yet
    await order('2026-09-01', 'received', 'Already back');
    await order(null, 'draft', 'No date');
    const r = (await charts(staff)).overdueLabOrders;
    expect(r.count).toBe(2);
    expect(r.oldest.map((o: { item: string }) => o.item)).toEqual(['Oldest', 'Newer']);
    expect(r.oldest[0]).toMatchObject({ lab: 'Kadi Lab', dueAt: '2026-09-20', patient: { fname: 'Pat' } });
    await t.db('lab_orders').del();
    await t.db('labs').where({ id: lab }).del();
  });

  it('counts accepted offers that still have work to book', async () => {
    const offer = async (status: string, items: string[]) => {
      const id = (await t.db('quotes').insert({ patient_id: s.patientId, title: 'P', type: 'clinic', price: 10, cost: 0, currency: '$', status, ...stamp }))[0]!;
      for (const [i, st] of items.entries()) await t.db('offer_items').insert({ offer_id: id, description: `w${i}`, price: 5, sequence: i, status: st, ...stamp });
    };
    await offer('accepted', ['pending', 'done']); await offer('accepted', ['pending']); // two with something left to book
    await offer('accepted', ['done']); // all finished
    await offer('accepted', ['scheduled']); // booked, nothing pending
    await offer('draft', ['pending']); // not final yet
    await offer('cancelled', ['pending']);
    const r = await charts(staff);
    expect(r.offersToBook).toBe(2);
    expect(r).not.toHaveProperty('offersAwaitingAcceptance');
  });
});
