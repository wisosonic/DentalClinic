import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Labs, suppliers and lab orders (phase 6). Owner rules: staff and admin manage orders and the
 * directories; a doctor only reads the orders of patients whose primary doctor he is, without the cost.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let labId: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
const del = (c: Client, url: string) => c.send('delete', url);

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  labId = (await t.db('labs').insert({ name: 'Kadi Lab', phone: '1', ...stamp }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['lab_orders', 'expenses', 'audit_log']) await t.db(table).del();
});

const order = (extra: object = {}) => ({ labId, patientId: s.patientId, item: 'Zirconia crown', cost: 85, dueAt: '2026-10-10', ...extra });

describe('labs and suppliers', () => {
  it('lets staff and admin add, change and list them, and nobody else', async () => {
    const made = await staff.post('/labs', { name: 'Smile Lab', phone: '03 123', contact: 'Rami', address: 'Beirut' });
    expect(made.status).toBe(201);
    expect(made.body.entry).toMatchObject({ name: 'Smile Lab', contact: 'Rami', phone: '03 123' });
    const id = made.body.entry.id;
    expect((await admin.patch(`/labs/${id}`, { phone: '03 999' })).body.entry.phone).toBe('03 999');
    expect((await staff.get('/labs')).body.data[0]).toEqual({ id: expect.any(Number), name: 'Kadi Lab' }); // the short form for pickers
    expect((await staff.get('/labs?full=1')).body.data.find((l: { id: number }) => l.id === id).contact).toBe('Rami');
    for (const c of [aya, ext, patient]) {
      expect((await c.get('/labs')).status).toBe(403);
      expect((await c.post('/suppliers', { name: 'X', phone: '123' })).status).toBe(403);
    }
    expect((await t.client().get('/suppliers')).status).toBe(401);
  });

  it('requires a name and a phone', async () => {
    expect((await staff.post('/suppliers', { name: 'No phone' })).status).toBe(400);
    expect((await staff.post('/suppliers', { phone: '123456' })).status).toBe(400);
    expect((await staff.patch(`/labs/${labId}`, {})).status).toBe(400);
  });

  it('refuses to delete one that orders or expenses refer to, and deletes an unused one', async () => {
    await staff.post('/lab-orders', order());
    const used = await del(staff, `/labs/${labId}`);
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('IN_USE');
    const supplier = (await staff.post('/suppliers', { name: 'Temp', phone: '555' })).body.entry.id;
    await staff.post('/expenses', { type: 'supplier', supplierId: supplier, date: TODAY, amount: 5 });
    expect((await del(staff, `/suppliers/${supplier}`)).status).toBe(409);
    const unused = (await staff.post('/suppliers', { name: 'Unused', phone: '555' })).body.entry.id;
    expect((await del(admin, `/suppliers/${unused}`)).status).toBe(204);
    expect((await del(staff, `/labs/999`)).status).toBe(404);
  });
});

describe('lab orders', () => {
  it('is created by staff and admin, starting as a draft, and refused to doctors and patients', async () => {
    const res = await staff.post('/lab-orders', order());
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ status: 'draft', cost: 85, item: 'Zirconia crown', lab: { name: 'Kadi Lab' }, overdue: false });
    expect((await admin.post('/lab-orders', order())).status).toBe(201);
    for (const c of [aya, ext]) expect((await c.post('/lab-orders', order())).status).toBe(403);
    expect((await patient.get('/lab-orders')).status).toBe(403);
    expect((await t.client().get('/lab-orders')).status).toBe(401);
  });

  it('checks the references', async () => {
    expect((await staff.post('/lab-orders', order({ labId: 9999 }))).body.error.code).toBe('LAB_NOT_FOUND');
    expect((await staff.post('/lab-orders', order({ patientId: 9999 }))).body.error.code).toBe('PATIENT_NOT_FOUND');
    expect((await staff.post('/lab-orders', order({ toothId: 99999 }))).body.error.code).toBe('TOOTH_NOT_FOUND');
    expect((await staff.post('/lab-orders', order({ appointmentId: 99999 }))).body.error.code).toBe('APPOINTMENT_NOT_FOUND');
    expect((await staff.post('/lab-orders', order({ item: '' }))).status).toBe(400);
    expect((await staff.post('/lab-orders', order({ cost: -1 }))).status).toBe(400);
  });

  it('moves draft -> sent -> received -> fitted, one step at a time, stamping the dates', async () => {
    const id = (await staff.post('/lab-orders', order())).body.order.id;
    expect((await staff.post(`/lab-orders/${id}/receive`)).body.error.code).toBe('BAD_STATUS'); // not sent yet
    const sent = await staff.post(`/lab-orders/${id}/send`);
    expect(sent.body.order).toMatchObject({ status: 'sent', sentAt: TODAY });
    expect((await staff.post(`/lab-orders/${id}/send`)).status).toBe(409);
    expect((await staff.post(`/lab-orders/${id}/receive`)).body.order).toMatchObject({ status: 'received', receivedAt: TODAY });
    expect((await staff.post(`/lab-orders/${id}/fit`)).body.order.status).toBe('fitted');
    expect((await staff.patch(`/lab-orders/${id}`, { item: 'Changed' })).status).toBe(409); // closed
    expect((await staff.post(`/lab-orders/${id}/bogus`)).status).toBe(400);
  });

  it('is overdue when the due date has passed and it has not been received', async () => {
    const late = (await staff.post('/lab-orders', order({ dueAt: '2026-10-01' }))).body.order.id;
    const onTime = (await staff.post('/lab-orders', order({ dueAt: TODAY }))).body.order.id;
    const noDate = (await staff.post('/lab-orders', order({ dueAt: '' }))).body.order.id;
    const overdue = (await staff.get('/lab-orders?overdue=1')).body.data;
    expect(overdue.map((o: { id: number }) => o.id)).toEqual([late]);
    expect(overdue[0].overdue).toBe(true);
    await staff.post(`/lab-orders/${late}/send`);
    expect((await staff.get('/lab-orders?overdue=1')).body.data).toHaveLength(1); // sent but not received
    await staff.post(`/lab-orders/${late}/receive`);
    expect((await staff.get('/lab-orders?overdue=1')).body.data).toEqual([]);
    expect((await staff.get(`/lab-orders/${onTime}`)).body.order.overdue).toBe(false);
    expect((await staff.get(`/lab-orders/${noDate}`)).body.order.overdue).toBe(false);
  });

  it('filters by lab, patient, status and words', async () => {
    const other = (await staff.post('/labs', { name: 'Other Lab', phone: '777' })).body.entry.id;
    await staff.post('/lab-orders', order());
    const b = (await staff.post('/lab-orders', order({ labId: other, patientId: s.otherPatientId, item: 'Night guard' }))).body.order.id;
    await staff.post(`/lab-orders/${b}/send`);
    expect((await staff.get(`/lab-orders?labId=${other}`)).body.data).toHaveLength(1);
    expect((await staff.get(`/lab-orders?patientId=${s.patientId}`)).body.data).toHaveLength(1);
    expect((await staff.get('/lab-orders?status=sent')).body.data[0].id).toBe(b);
    expect((await staff.get('/lab-orders?q=guard')).body.data).toHaveLength(1);
    expect((await staff.get('/lab-orders')).body.meta.total).toBe(2);
  });

  it('shows a doctor only his own patients’ orders, without the cost, and 404 for anyone else’s', async () => {
    const mine = (await staff.post('/lab-orders', order())).body.order.id; // Aya's patient
    const notMine = (await staff.post('/lab-orders', order({ patientId: s.otherPatientId }))).body.order.id; // no primary doctor
    const list = (await aya.get('/lab-orders')).body;
    expect(list.data.map((o: { id: number }) => o.id)).toEqual([mine]);
    expect(list.data[0].cost).toBeUndefined();
    expect((await aya.get(`/lab-orders/${mine}`)).body.order.cost).toBeUndefined();
    expect((await aya.get(`/lab-orders/${notMine}`)).status).toBe(404);
    expect((await ext.get('/lab-orders')).body.data).toEqual([]); // the specialist's own patients only; he has none here
    expect((await ext.get(`/lab-orders/${mine}`)).status).toBe(404);
    expect((await staff.get(`/lab-orders/${mine}`)).body.order.cost).toBe(85);
    expect((await aya.patch(`/lab-orders/${mine}`, { item: 'x' })).status).toBe(403);
    expect((await aya.post(`/lab-orders/${mine}/send`)).status).toBe(403);
  });

  it('updates fields, and deletes softly: gone from the list, row kept', async () => {
    const id = (await staff.post('/lab-orders', order())).body.order.id;
    expect((await staff.patch(`/lab-orders/${id}`, { item: 'Bridge', cost: 120.5, dueAt: null })).body.order).toMatchObject({ item: 'Bridge', cost: 120.5, dueAt: null });
    expect((await del(staff, `/lab-orders/${id}`)).status).toBe(204);
    expect((await staff.get(`/lab-orders/${id}`)).status).toBe(404);
    expect(await t.db('lab_orders').where({ id }).first()).toMatchObject({ id });
    expect((await t.db('lab_orders').where({ id }).first()).deleted_at).not.toBeNull();
  });

  it('records changes in the activity log without the content, and opening an order as a view', async () => {
    const id = (await staff.post('/lab-orders', order())).body.order.id;
    await aya.get(`/lab-orders/${id}`);
    const rows = await t.db('audit_log').whereIn('action', ['lab_order.create', 'lab_order.view']);
    expect(rows.map((r) => r.action).sort()).toEqual(['lab_order.create', 'lab_order.view']);
    expect(JSON.stringify(rows)).not.toContain('Zirconia');
  });
});
