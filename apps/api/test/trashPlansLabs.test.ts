import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/** Treatment offers and lab orders in the Trash: restore, and erase for good with the patient's name typed. */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client;
let labId: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
const del = (c: Client, url: string) => c.send('delete', url);
const purge = (c: Client, kind: string, id: number, confirm: string) => c.agent.delete(`/api/v1/trash/${kind}/${id}`).set('x-csrf-token', c.csrf).send({ confirm });

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  [admin, aya, staff] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test'].map((e) => loggedIn(t, e)));
  labId = (await t.db('labs').insert({ name: 'Kadi Lab', phone: '1', ...stamp }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['payments', 'offer_items', 'quotes', 'lab_orders', 'audit_log']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
});

const makePlan = async () => (await aya.post('/treatment-offers', { patientId: s.patientId, title: 'Plan', items: [{ description: 'Crown', price: 100 }] })).body.offer.id as number;
const makeOrder = async () => (await staff.post('/lab-orders', { labId, patientId: s.patientId, item: 'Crown', cost: 50 })).body.order.id as number;

describe('offers and lab orders in the Trash', () => {
  it('lists them with who deleted them, and restores them', async () => {
    const plan = await makePlan();
    const order = await makeOrder();
    await del(aya, `/treatment-offers/${plan}`);
    await del(staff, `/lab-orders/${order}`);
    const items = (await admin.get('/trash')).body.data;
    expect(items.find((i: { kind: string }) => i.kind === 'offer')).toMatchObject({ id: plan, label: 'Pat Patient', detail: 'Plan · 100.00', blockedBy: null });
    expect(items.find((i: { kind: string }) => i.kind === 'lab_order')).toMatchObject({ id: order, detail: 'Crown · Kadi Lab', deletedBy: 'Sam Staff' });
    expect((await admin.get('/trash?kind=offer')).body.data).toHaveLength(1);
    expect((await admin.post(`/trash/offer/${plan}/restore`)).status).toBe(204);
    expect((await admin.post(`/trash/lab_order/${order}/restore`)).status).toBe(204);
    expect((await aya.get(`/treatment-offers/${plan}`)).status).toBe(200);
    expect((await staff.get(`/lab-orders/${order}`)).status).toBe(200);
  });

  it('needs the patient restored first, and is closed to everyone but the admin', async () => {
    const plan = await makePlan();
    await del(aya, `/treatment-offers/${plan}`);
    await del(staff, `/patients/${s.patientId}`);
    expect((await admin.get('/trash?kind=offer')).body.data[0].blockedBy).toBe('patient');
    expect((await admin.post(`/trash/offer/${plan}/restore`)).body.error.code).toBe('RESTORE_PATIENT_FIRST');
    expect((await aya.get('/trash')).status).toBe(403);
    expect((await staff.post(`/trash/offer/${plan}/restore`)).status).toBe(403);
  });

  it('erases an offer with its items, and a lab order, only after the patient’s name is typed', async () => {
    const plan = await makePlan();
    const order = await makeOrder();
    await del(aya, `/treatment-offers/${plan}`);
    await del(staff, `/lab-orders/${order}`);
    expect((await admin.get(`/trash/offer/${plan}/impact`)).body.counts).toMatchObject({ offers: 1, labOrders: 0 });
    expect((await purge(admin, 'offer', plan, 'Wrong Name')).body.error.code).toBe('CONFIRM_MISMATCH');
    expect((await purge(admin, 'offer', plan, 'Pat Patient')).status).toBe(204);
    expect((await purge(admin, 'lab_order', order, 'pat patient')).status).toBe(204);
    expect(await t.db('quotes').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect(await t.db('offer_items').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect(await t.db('lab_orders').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect(JSON.stringify(await t.db('audit_log'))).not.toContain('Crown');
  });

  it('refuses to erase something that is not in the Trash', async () => {
    const plan = await makePlan();
    expect((await purge(admin, 'offer', plan, 'Pat Patient')).status).toBe(404);
  });
});
