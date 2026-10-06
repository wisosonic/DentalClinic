import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

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
  for (const table of ['payments', 'quotes', 'expenses']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null });
});

const quote = async (patient_id: number, price: number, status = 'accepted') =>
  (await t.db('quotes').insert({ title: 'Q', type: 'clinic', price, cost: 0, currency: '$', status, patient_id, ...stamp }))[0]!;
const pay = (quote_id: number, amount: number, date: string, type = 'clinic') =>
  t.db('payments').insert({ date, type, amount, currency: '$', quote_id: type === 'clinic' ? quote_id : null, dr_part: 100, ...stamp });
const spend = (type: string, amount: number, date: string) => t.db('expenses').insert({ date, type, amount, currency: '$', ...stamp });
const summary = async (qs = '') => (await admin.get(`/finance/summary${qs}`)).body;

describe('finance summary', () => {
  it('is for admins only', async () => {
    for (const c of [aya, staff, patient]) expect((await c.get('/finance/summary')).status).toBe(403);
    expect((await t.client().get('/finance/summary')).status).toBe(401);
  });

  it('adds up payments and expenses in a period, and the net is their difference', async () => {
    const q = await quote(s.patientId, 1000);
    await pay(q, 300, '2026-10-02');
    await pay(q, 200, '2026-10-20');
    await pay(q, 100, '2026-09-15'); // outside the period
    await spend('clinic', 120, '2026-10-05');
    await spend('lab', 80.5, '2026-10-06');
    await spend('personal', 50, '2026-10-07');
    await spend('clinic', 999, '2026-08-01'); // outside
    const r = await summary('?from=2026-10-01&to=2026-10-31');
    expect(r.payments).toEqual({ total: 500, count: 2, byType: [{ type: 'clinic', total: 500, count: 2 }] });
    expect(r.expenses.total).toBe(250.5);
    expect(r.expenses.count).toBe(3);
    expect(r.expenses.byType).toEqual([{ type: 'personal', total: 50 }, { type: 'clinic', total: 120 }, { type: 'lab', total: 80.5 }]);
    expect(r.net).toBe(249.5);
    expect(r.from).toBe('2026-10-01');
    expect(r.to).toBe('2026-10-31');
  });

  it('covers everything when no period is given, and is negative when more went out than came in', async () => {
    const q = await quote(s.patientId, 100);
    await pay(q, 40, '2026-01-01');
    await spend('clinic', 100, '2026-02-02');
    const r = await summary();
    expect(r.payments.total).toBe(40);
    expect(r.payments.byType).toEqual([{ type: 'clinic', total: 40, count: 1 }]); // a type with nothing is not listed
    expect(r.expenses.total).toBe(100);
    expect(r.net).toBe(-60);
  });

  it('counts the period ends themselves', async () => {
    const q = await quote(s.patientId, 100);
    await pay(q, 10, '2026-10-01');
    await pay(q, 20, '2026-10-31');
    await spend('clinic', 5, '2026-10-01');
    await spend('clinic', 5, '2026-10-31');
    const r = await summary('?from=2026-10-01&to=2026-10-31');
    expect(r.payments.total).toBe(30);
    expect(r.expenses.total).toBe(10);
  });

  it('leaves out deleted payments, deleted expenses, and the money of deleted quotes and patients', async () => {
    const q = await quote(s.patientId, 1000);
    await pay(q, 100, '2026-10-02');
    await t.db('payments').insert({ date: '2026-10-03', type: 'clinic', amount: 50, currency: '$', quote_id: q, dr_part: 100, deleted_at: '2026-10-04 00:00:00', ...stamp });
    await t.db('expenses').insert({ date: '2026-10-03', type: 'clinic', amount: 70, currency: '$', deleted_at: '2026-10-04 00:00:00', ...stamp });
    const gone = await quote(s.otherPatientId, 1000);
    await pay(gone, 400, '2026-10-02');
    await t.db('quotes').where({ id: gone }).update({ deleted_at: '2026-10-04 00:00:00' });
    expect((await summary()).payments.total).toBe(100);
    expect((await summary()).expenses.total).toBe(0);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-04 00:00:00' });
    expect((await summary()).payments.total).toBe(0);
  });

  it('counts the commission specialists paid over in the total payments, and lists payments by type', async () => {
    const q = await quote(s.patientId, 100);
    await pay(q, 60, '2026-10-02');
    await pay(0, 25, '2026-10-03', 'commission');
    await pay(0, 15, '2026-10-04', 'commission');
    await spend('clinic', 30, '2026-10-05');
    const r = await summary();
    expect(r.payments).toEqual({
      total: 100, count: 3,
      byType: [{ type: 'clinic', total: 60, count: 1 }, { type: 'commission', total: 40, count: 2 }],
    });
    expect(r.net).toBe(70); // 100 in, 30 out
  });

  it('applies the period to commission too, and leaves out deleted commission payments', async () => {
    await pay(0, 25, '2026-10-03', 'commission');
    await pay(0, 99, '2026-08-03', 'commission'); // outside the period
    await t.db('payments').insert({ date: '2026-10-03', type: 'commission', amount: 500, currency: '$', quote_id: null, dr_part: 100, deleted_at: '2026-10-04 00:00:00', ...stamp });
    const r = await summary('?from=2026-10-01&to=2026-10-31');
    expect(r.payments.byType).toEqual([{ type: 'commission', total: 25, count: 1 }]);
    expect(r.payments.total).toBe(25);
  });

  it('works out what patients still owe from open quotes only, with the biggest debtors first', async () => {
    const a = await quote(s.patientId, 500, 'accepted');
    await pay(a, 150, '2026-10-02'); // 350 left
    const b = await quote(s.patientId, 100, 'accepted'); // 100 left
    const c = await quote(s.otherPatientId, 80, 'accepted');
    await pay(c, 30, '2026-10-02'); // 50 left
    await quote(s.otherPatientId, 999, 'draft'); // not a debt yet
    await quote(s.otherPatientId, 999, 'rejected'); // never a debt
    await quote(s.otherPatientId, 999, 'expired');
    const paidUp = await quote(s.otherPatientId, 20, 'accepted');
    await pay(paidUp, 20, '2026-10-02');
    void b;
    const r = await summary('?from=2026-10-01&to=2026-10-02'); // the period does not limit debts: they are as things stand
    expect(r.debts.total).toBe(500);
    expect(r.debts.patients).toBe(2);
    expect(r.debts.offers).toBe(3);
    expect(r.debts.top.map((d: { owed: number; patient: { id: number } }) => [d.patient.id, d.owed])).toEqual([[s.patientId, 450], [s.otherPatientId, 50]]);
  });

  it('forgets the debts of a deleted patient or quote, and of a quote that has been overpaid', async () => {
    const a = await quote(s.patientId, 100);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-04 00:00:00' });
    expect((await summary()).debts.total).toBe(0);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: null });
    expect((await summary()).debts.total).toBe(100);
    await pay(a, 130, '2026-10-02'); // old data paid more than the price
    expect((await summary()).debts).toMatchObject({ total: 0, offers: 0, patients: 0 });
  });

  it('rejects a malformed period', async () => {
    expect((await admin.get('/finance/summary?from=yesterday')).status).toBe(400);
  });
});

describe('quotes that still have a balance', () => {
  it('can be listed on their own', async () => {
    const owing = await quote(s.patientId, 100, 'accepted');
    const paid = await quote(s.patientId, 100, 'accepted');
    await pay(paid, 100, '2026-10-02');
    await quote(s.patientId, 100, 'draft');
    const ids = (await admin.get('/treatment-offers?debt=1')).body.data.map((x: { id: number }) => x.id);
    expect(ids).toEqual([owing]);
    expect((await admin.get('/treatment-offers?debt=2')).status).toBe(400);
  });
});
