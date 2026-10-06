import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Payments on treatment offers (phase 5, part one, now on offers). Owner rules: an admin sees everything; a doctor
 * sees only the offers and payments of patients whose primary doctor he is; staff record payments but cannot
 * browse payment history and cannot create offers; patients are not served here yet. (The offers themselves are
 * in offers.test.ts.)
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let ayaPatient: number; // primary doctor: Aya (doctor@clinic.test)
let saraPatient: number; // primary doctor: Sara (no login in this test)
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  const mk = async (fname: string, doctor_id: number) => (await t.db('patients').insert({ patient_identifier: `F${fname}`, fname, lname: 'Money', phone: `70${fname.length}00`, doctor_id, ...stamp }))[0]!;
  ayaPatient = s.patientId; // Pat Patient already belongs to Aya
  await mk('Ext', s.externalDoctorId);
  saraPatient = await mk('Sara', s.saraId);
});
afterAll(() => t.destroy());

beforeEach(async () => {
  for (const table of ['payments', 'offer_items', 'quotes', 'audit_log']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null });
});

/** An offer with one item (title and price as the old quote had them). */
const q = (patientId: number, extra: { title?: string; price?: number; cost?: number; description?: string } = {}) => ({
  patientId, title: extra.title ?? 'Crown', description: extra.description, items: [{ description: extra.title ?? 'Crown', price: extra.price ?? 100, cost: extra.cost }],
});
const pay = (offerId: number, extra: object = {}) => ({ offerId, amount: 40, date: TODAY, method: 'cash', ...extra });
const make = async (c: Client, patientId: number, status: 'accepted' | 'draft' = 'accepted', extra: object = {}) => {
  const res = await c.post('/treatment-offers', { ...q(patientId, extra), asDraft: status === 'draft' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.offer.id as number;
  return id;
};
const del = (c: Client, url: string) => c.send('delete', url);
const patch = (c: Client, url: string, body: object) => c.patch(url, body);

describe('recording payments', () => {
  it('records a payment, snapshots the collecting doctor and share, and works out the balance', async () => {
    const id = await make(aya, ayaPatient);
    const res = await aya.post('/payments', pay(id, { amount: 40, description: 'First instalment' }));
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ amount: 40, remaining: 60, method: 'cash', type: 'clinic', description: 'First instalment', offerId: id });
    expect(res.body.payment.collectedBy).toMatchObject({ id: s.doctorId });
    const row = await t.db('payments').first();
    expect(row).toMatchObject({ collected_by_doctor_id: s.doctorId, dr_part: 100, method: 'cash', currency: '$' });
    expect(row.created_by).toBeTruthy();
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paid: 40, remaining: 60, paymentState: 'partly_paid', status: 'accepted' });
    await aya.post('/payments', pay(id, { amount: 60 }));
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paid: 100, remaining: 0, paymentState: 'paid' });
  });

  it('copies the doctor’s share setting, and shows it to admins only', async () => {
    await t.db('clinic_doctor').where({ doctor_id: s.doctorId }).update({ dr_part: 70 });
    const id = await make(aya, ayaPatient);
    const res = await aya.post('/payments', pay(id));
    expect(res.body.payment).not.toHaveProperty('drPart');
    expect((await t.db('payments').first()).dr_part).toBe(70);
    expect((await admin.get('/payments')).body.data[0].drPart).toBe(70);
    expect((await aya.get('/payments')).body.data[0]).not.toHaveProperty('drPart');
    await t.db('clinic_doctor').where({ doctor_id: s.doctorId }).update({ dr_part: 100 });
  });

  it('takes more than what is owed, and counts the offer as paid with nothing left', async () => {
    const id = await make(aya, ayaPatient);
    await aya.post('/payments', pay(id, { amount: 99.99 }));
    const over = await aya.post('/payments', pay(id, { amount: 20 })); // a generous client
    expect(over.status).toBe(201);
    expect(over.body.payment.remaining).toBe(0); // never negative
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paymentState: 'paid', paid: 119.99, remaining: 0 });
    // an offer that is already paid still takes a payment
    expect((await aya.post('/payments', pay(id, { amount: 5 }))).status).toBe(201);
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paymentState: 'paid', remaining: 0 });
  });

  it('keeps the totals right when two payments are entered at once', async () => {
    const id = await make(aya, ayaPatient);
    const results = await Promise.all([aya.post('/payments', pay(id, { amount: 70 })), admin.post('/payments', pay(id, { amount: 70 }))]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paid: 140, remaining: 0, paymentState: 'paid' });
  });

  it('only takes payments on offers that are open, with a valid date, method and amount', async () => {
    const draft = await make(aya, ayaPatient, 'draft');
    expect((await aya.post('/payments', pay(draft))).body.error.code).toBe('OFFER_NOT_OPEN');
    const sent = await make(aya, ayaPatient);
    expect((await aya.post('/payments', pay(sent))).status).toBe(201); // a sent offer can be paid
    const rejected = await make(aya, ayaPatient);
    await aya.post(`/treatment-offers/${rejected}/cancel`);
    expect((await aya.post('/payments', pay(rejected))).body.error.code).toBe('OFFER_NOT_OPEN');
    const ok = await make(aya, ayaPatient);
    for (const bad of [{ amount: 0 }, { amount: -1 }, { amount: 'x' }, { amount: 1.234 }, { method: 'bitcoin' }, { method: undefined }, { date: '2026-13-40' }, { date: undefined }]) {
      expect((await aya.post('/payments', pay(ok, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const future = await aya.post('/payments', pay(ok, { date: '2099-01-01' }));
    expect(future.body.error.code).toBe('FUTURE_DATE');
    expect((await aya.post('/payments', pay(99999))).status).toBe(404);
  });

  it('keeps a doctor to his own patients’ offers (404 for anyone else’s), while an admin may take any', async () => {
    const theirs = await make(admin, saraPatient);
    expect((await aya.post('/payments', pay(theirs))).status).toBe(404);
    expect((await ext.post('/payments', pay(theirs))).status).toBe(404);
    expect((await admin.post('/payments', pay(theirs))).status).toBe(201);
    expect((await t.db('payments').first()).collected_by_doctor_id).toBe(s.saraId); // collected by the patient's primary doctor
  });

  it('refuses patients and signed-out visitors', async () => {
    const id = await make(aya, ayaPatient);
    expect((await patient.post('/payments', pay(id))).status).toBe(403);
    expect((await patient.get('/payments')).status).toBe(403);
    expect((await t.client().post('/payments', pay(id))).status).toBeGreaterThanOrEqual(401);
  });
});

describe('staff entering payments', () => {
  it('lets staff pick from a patient’s open offers, showing only title, price and what is left', async () => {
    const open = await make(aya, ayaPatient, 'accepted', { title: 'Bridge', price: 500, cost: 200 });
    const paidUp = await make(aya, ayaPatient, 'accepted', { title: 'Done', price: 50 });
    await aya.post('/payments', pay(paidUp, { amount: 50 }));
    await make(aya, ayaPatient, 'draft', { title: 'Not yet' });
    await aya.post('/payments', pay(open, { amount: 125 }));
    const res = await staff.get(`/payments/open-offers?patientId=${ayaPatient}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: open, title: 'Bridge', price: 500, paid: 125, remaining: 375 }]); // no cost, no description, no status
  });

  it('lets staff record a payment on any patient’s offer, but not read, list or search payments (they do see offers, never the cost)', async () => {
    const id = await make(admin, saraPatient);
    const res = await staff.post('/payments', pay(id, { amount: 25, method: 'card' }));
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ amount: 25, remaining: 75, method: 'card' });
    expect(await t.db('payments').first()).toMatchObject({ created_by: (await t.db('users').where({ email: 'staff@clinic.test' }).first('id')).id });
    for (const url of ['/payments', '/payments?q=Money']) expect((await staff.get(url)).status, url).toBe(403);
    const seen = (await staff.get(`/treatment-offers/${id}`)).body.offer;
    expect(seen).toMatchObject({ price: 100, paid: 25 });
    expect(seen).not.toHaveProperty('cost');
  });

  it('shows staff only what they entered themselves, recently', async () => {
    const id = await make(admin, ayaPatient);
    await staff.post('/payments', pay(id, { amount: 10 }));
    await aya.post('/payments', pay(id, { amount: 20 }));
    const mine = (await staff.get('/payments/mine')).body.data;
    expect(mine.map((p: { amount: number }) => p.amount)).toEqual([10]);
    await t.db('payments').where({ amount: 10 }).update({ created_at: '2000-01-01 00:00:00' });
    expect((await staff.get('/payments/mine')).body.data).toEqual([]);
    expect((await aya.get('/payments/mine')).body.data.map((p: { amount: number }) => p.amount)).toEqual([20]);
  });

  it('lets staff fix or delete their own entries, never another person’s', async () => {
    const id = await make(admin, ayaPatient);
    const mine = (await staff.post('/payments', pay(id, { amount: 10 }))).body.payment.id;
    const theirs = (await aya.post('/payments', pay(id, { amount: 20 }))).body.payment.id;
    expect((await patch(staff, `/payments/${mine}`, { amount: 15, method: 'card' })).body.payment).toMatchObject({ amount: 15, method: 'card' });
    expect((await patch(staff, `/payments/${theirs}`, { amount: 1 })).status).toBe(404);
    expect((await del(staff, `/payments/${theirs}`)).status).toBe(404);
    expect((await del(staff, `/payments/${mine}`)).status).toBe(204);
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer.paid).toBe(20);
  });
});

describe('editing and deleting payments', () => {
  it('re-works the balances of the whole offer when a payment changes, oldest first', async () => {
    const id = await make(aya, ayaPatient);
    const first = (await aya.post('/payments', pay(id, { amount: 30, date: '2026-10-01' }))).body.payment.id;
    await aya.post('/payments', pay(id, { amount: 20, date: '2026-10-03' }));
    expect((await patch(aya, `/payments/${first}`, { amount: 50 })).body.payment).toMatchObject({ amount: 50, remaining: 50 });
    const rows = (await admin.get(`/payments?offerId=${id}&sort=date&order=asc`)).body.data;
    expect(rows.map((p: { remaining: number }) => p.remaining)).toEqual([50, 30]);
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paid: 70, remaining: 30, paymentState: 'partly_paid' });
    const more = await patch(aya, `/payments/${first}`, { amount: 90 }); // raising a payment above the price is allowed too
    expect(more.status).toBe(200);
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paid: 110, remaining: 0, paymentState: 'paid' });
    expect((await patch(aya, `/payments/${first}`, {})).status).toBe(400);
  });

  it('puts an offer back to unpaid when its only payment is deleted', async () => {
    const id = await make(aya, ayaPatient);
    const p = (await aya.post('/payments', pay(id, { amount: 100 }))).body.payment.id;
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer.paymentState).toBe('paid');
    expect((await del(aya, `/payments/${p}`)).status).toBe(204);
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paymentState: 'unpaid', paid: 0, remaining: 100 });
    expect((await admin.get('/payments')).body.data).toEqual([]);
    const row = await t.db('payments').where({ id: p }).first();
    expect(row.deleted_at).toBeTruthy();
    expect(row.deleted_by).toBeTruthy();
  });

  it('keeps another doctor’s payments out of reach: list, edit and delete', async () => {
    const theirs = await make(admin, saraPatient);
    const p = (await admin.post('/payments', pay(theirs))).body.payment.id;
    expect((await aya.get('/payments')).body.data).toEqual([]);
    expect((await aya.get(`/payments?patientId=${saraPatient}`)).body.data).toEqual([]);
    expect((await patch(aya, `/payments/${p}`, { amount: 1 })).status).toBe(404);
    expect((await del(aya, `/payments/${p}`)).status).toBe(404);
    expect((await admin.get('/payments')).body.data).toHaveLength(1);
  });

  it('filters and sorts the payment list', async () => {
    const id = await make(aya, ayaPatient);
    await aya.post('/payments', pay(id, { amount: 10, date: '2026-10-01', method: 'cash' }));
    await aya.post('/payments', pay(id, { amount: 20, date: '2026-10-02', method: 'card' }));
    expect((await aya.get('/payments?method=card')).body.data).toHaveLength(1);
    expect((await aya.get('/payments?from=2026-10-02')).body.data).toHaveLength(1);
    expect((await aya.get('/payments?to=2026-10-01')).body.data).toHaveLength(1);
    expect((await aya.get('/payments?q=pat')).body.data).toHaveLength(2);
    expect((await aya.get('/payments?sort=amount&order=desc')).body.data[0].amount).toBe(20);
    for (const sort of ['date', 'patient', 'method', 'offer']) expect((await aya.get(`/payments?sort=${sort}`)).status).toBe(200);
    expect((await aya.get('/payments?sort=password')).status).toBe(400);
  });

  it('writes the changes to the audit log with ids and amounts only', async () => {
    const id = await make(aya, ayaPatient);
    const p = (await aya.post('/payments', pay(id, { description: 'secret note about care' }))).body.payment.id;
    await patch(aya, `/payments/${p}`, { amount: 41 });
    await del(aya, `/payments/${p}`);
    const actions = (await t.db('audit_log').pluck('action')) as string[];
    expect(actions).toEqual(expect.arrayContaining(['offer.create', 'payment.create', 'payment.update', 'payment.delete']));
    expect(JSON.stringify(await t.db('audit_log'))).not.toContain('secret note');
  });
});

describe('the Trash and money', () => {
  it('lists a deleted offer and payment, restores them in order, and works the balance out again', async () => {
    const id = await make(aya, ayaPatient);
    const p = (await aya.post('/payments', pay(id, { amount: 100 }))).body.payment.id;
    await del(aya, `/payments/${p}`);
    await del(aya, `/treatment-offers/${id}`);
    const items = (await admin.get('/trash')).body.data;
    expect(items.map((i: { kind: string }) => i.kind).sort()).toEqual(['offer', 'payment']);
    expect(items.find((i: { kind: string }) => i.kind === 'payment').blockedBy).toBe('offer');
    expect((await admin.post(`/trash/payment/${p}/restore`)).body.error.code).toBe('RESTORE_OFFER_FIRST');
    expect((await admin.post(`/trash/offer/${id}/restore`)).status).toBe(204);
    expect((await admin.post(`/trash/payment/${p}/restore`)).status).toBe(204);
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer).toMatchObject({ paid: 100, remaining: 0, paymentState: 'paid' });
  });

  it('erases an offer with its payments, or one payment, and keeps the rest consistent', async () => {
    const id = await make(aya, ayaPatient);
    const p1 = (await aya.post('/payments', pay(id, { amount: 30 }))).body.payment.id;
    await aya.post('/payments', pay(id, { amount: 20 }));
    await del(aya, `/payments/${p1}`);
    expect((await admin.agent.delete(`/api/v1/trash/payment/${p1}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Pat Patient' })).status).toBe(204);
    expect(await t.db('payments').where({ id: p1 }).first()).toBeUndefined();
    expect((await aya.get(`/treatment-offers/${id}`)).body.offer.paid).toBe(20);

    await del(aya, `/treatment-offers/${id}`);
    const impact = (await admin.get(`/trash/offer/${id}/impact`)).body.counts;
    expect(impact).toMatchObject({ offers: 1, payments: 1 });
    expect((await admin.agent.delete(`/api/v1/trash/offer/${id}`).set('x-csrf-token', admin.csrf).send({ confirm: 'wrong' })).status).toBe(400);
    expect((await admin.agent.delete(`/api/v1/trash/offer/${id}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Pat Patient' })).status).toBe(204);
    expect(await t.db('quotes').first()).toBeUndefined();
    expect(await t.db('offer_items').first()).toBeUndefined();
    expect(await t.db('payments').first()).toBeUndefined();
    expect(await t.db('patients').where({ id: ayaPatient }).first()).toBeTruthy();
  });
});

describe('the old data', () => {
  it('has no way for staff or doctors to reach the Trash or the log', async () => {
    for (const c of [aya, staff]) {
      expect((await c.get('/trash')).status).toBe(403);
      expect((await c.get('/audit-log')).status).toBe(403);
    }
  });
});
