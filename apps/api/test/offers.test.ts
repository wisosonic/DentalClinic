import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Treatment offers (plans and quotes in one, owner decision 2026-10-06). Admin and staff see every offer (staff never
 * the cost), a doctor only those of patients whose primary doctor he is (another doctor's is a 404); admin and the
 * patient's doctor write; staff book the visits. The price is the sum of the items; the payment state and the work
 * state are worked out, never set by hand; an offer follows its visits. It is made in the chair after the patient agreed, so
 * a new offer is accepted at once; a doctor may keep an unfinished one as a draft, and cancel one that is not going ahead.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let extPatient: number;
let saraPatient: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
const del = (c: Client, url: string) => c.send('delete', url);

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  extPatient = (await t.db('patients').insert({ patient_identifier: 'E1', fname: 'Ext', lname: 'Pat', phone: '701', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
  saraPatient = (await t.db('patients').insert({ patient_identifier: 'S1', fname: 'Sara', lname: 'Pat', phone: '702', doctor_id: s.saraId, ...stamp }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['notifications', 'payments', 'offer_items', 'appointment_tooth', 'appointment_category', 'appointments', 'quotes', 'audit_log']) await t.db(table).del();
});

const items = () => [
  { description: 'Root canal', toothId: s.toothIds[0], categoryId: s.categoryIds[0], price: 120, cost: 40 },
  { description: 'Crown', toothId: s.toothIds[0], price: 300.5, cost: 100.25 },
];
const offer = (extra: object = {}) => ({ patientId: s.patientId, title: 'Full rehabilitation', items: items(), ...extra });
const slot = (extra: object = {}) => ({ doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00', durationMinutes: 30, ...extra });
/** A new offer: accepted at once. */
const created = async (c: Client = aya, extra: object = {}) => (await c.post('/treatment-offers', offer(extra))).body.offer;
const accepted = created;
/** An unfinished one the doctor keeps as a draft. */
const drafted = async (c: Client = aya, extra: object = {}) => (await c.post('/treatment-offers', offer({ asDraft: true, ...extra }))).body.offer;
const pay = (offerId: number, amount = 40) => ({ offerId, amount, date: TODAY, method: 'cash' });

describe('creating and reading offers', () => {
  it('is created by a doctor for his own patient and by admin, with ordered items, a price that is their sum, and the cost for doctors', async () => {
    const res = await aya.post('/treatment-offers', offer());
    expect(res.status).toBe(201);
    expect(res.body.offer).toMatchObject({
      status: 'accepted', price: 420.5, cost: 140.25, paid: 0, remaining: 420.5, paymentState: 'unpaid', workState: 'not_started',
      progress: { done: 0, total: 2, percent: 0 }, doctor: { id: s.doctorId }, currency: '$',
    });
    expect(res.body.offer.items.map((i: { description: string; sequence: number }) => [i.description, i.sequence])).toEqual([['Root canal', 1], ['Crown', 2]]);
    expect(res.body.offer.items[0]).toMatchObject({ status: 'pending', appointment: null, tooth: { id: s.toothIds[0] }, price: 120, cost: 40 });
    expect((await admin.post('/treatment-offers', offer())).status).toBe(201);
    expect(await t.db('quotes').where({ id: res.body.offer.id }).first()).toMatchObject({ price: 420.5, cost: 140.25 });
  });

  it('is accepted as soon as it is made (the patient agreed in the chair), and tells the staff who book its visits', async () => {
    const res = await aya.post('/treatment-offers', offer());
    expect(res.body.offer.status).toBe('accepted');
    const n = await t.db('notifications').where({ type: 'offer.accepted' });
    expect(n.length).toBeGreaterThan(0);
  });

  it('needs at least one item, unless it is kept as a draft', async () => {
    const none = await aya.post('/treatment-offers', offer({ items: [] }));
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('EMPTY_OFFER');
    const draft = (await aya.post('/treatment-offers', offer({ items: [], asDraft: true }))).body.offer;
    expect(draft).toMatchObject({ status: 'draft', price: 0, workState: 'not_started' });
    expect((await aya.post(`/treatment-offers/${draft.id}/accept`)).body.error.code).toBe('EMPTY_OFFER'); // a draft needs an item before it is final
  });

  it('can be kept as a draft: not binding, so no payments and no visits until it is accepted', async () => {
    const d = await drafted();
    expect(d.status).toBe('draft');
    expect((await aya.post('/payments', pay(d.id))).body.error.code).toBe('OFFER_NOT_OPEN');
    expect((await aya.post(`/treatment-offers/${d.id}/items/${d.items[0].id}/schedule`, slot())).body.error.code).toBe('OFFER_NOT_ACCEPTED');
    expect(await t.db('notifications').where({ type: 'offer.accepted' }).count({ n: '*' }).first()).toMatchObject({ n: 0 }); // nobody is told about an unfinished one
    expect((await aya.post(`/treatment-offers/${d.id}/accept`)).body.offer.status).toBe('accepted');
    expect(await t.db('notifications').where({ type: 'offer.accepted' }).count({ n: '*' }).first()).not.toMatchObject({ n: 0 });
  });

  it('refuses staff and patients writing, another doctor’s patient, and bad input', async () => {
    expect((await staff.post('/treatment-offers', offer())).status).toBe(403);
    expect((await patient.post('/treatment-offers', offer())).status).toBe(403);
    expect((await patient.get('/treatment-offers')).status).toBe(403);
    expect((await ext.post('/treatment-offers', offer())).body.error.code).toBe('UNKNOWN_PATIENT'); // Aya's patient
    expect((await aya.post('/treatment-offers', offer({ patientId: extPatient }))).body.error.code).toBe('UNKNOWN_PATIENT');
    expect((await aya.post('/treatment-offers', offer({ title: '' }))).status).toBe(400);
    for (const bad of [{ description: 'x', price: -1 }, { description: 'x', price: 'abc' }, { description: 'x', price: 1.234 }, { description: '', price: 1 }, { description: 'x', price: 1, cost: -1 }]) {
      expect((await aya.post('/treatment-offers', offer({ items: [bad] }))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await aya.post('/treatment-offers', offer({ items: [{ description: 'x', price: 1, toothId: 99999 }] }))).body.error.code).toBe('UNKNOWN_TOOTH');
    expect((await aya.post('/treatment-offers', offer({ items: [{ description: 'x', price: 1, categoryId: 99999 }] }))).body.error.code).toBe('UNKNOWN_CATEGORY');
    expect((await t.client().get('/treatment-offers')).status).toBe(401);
  });

  it('shows a doctor only the offers of his own patients (404 for others), staff and admin all', async () => {
    const mine = (await created(aya)).id;
    const exts = (await created(ext, { patientId: extPatient })).id;
    const saras = (await created(admin, { patientId: saraPatient })).id;
    const ids = async (c: Client) => (await c.get('/treatment-offers')).body.data.map((p: { id: number }) => p.id).sort();
    expect(await ids(aya)).toEqual([mine]);
    expect(await ids(ext)).toEqual([exts]);
    expect(await ids(admin)).toEqual([mine, exts, saras].sort());
    expect(await ids(staff)).toEqual([mine, exts, saras].sort());
    expect((await aya.get(`/treatment-offers/${exts}`)).status).toBe(404);
    expect((await ext.get(`/treatment-offers/${mine}`)).status).toBe(404);
    expect((await aya.get('/treatment-offers?q=Sara')).body.data).toEqual([]); // not even by searching
    expect((await staff.get(`/treatment-offers/${mine}`)).body.offer.items).toHaveLength(2);
    expect((await admin.get(`/treatment-offers?patientId=${extPatient}`)).body.data).toHaveLength(1);
    expect((await admin.get('/treatment-offers?q=rehab')).body.data).toHaveLength(3);
    expect((await aya.get('/treatment-offers/99999')).status).toBe(404);
  });

  it('shows the clinic’s cost to admins and doctors, never to staff (offer or item)', async () => {
    const id = (await created()).id;
    for (const c of [aya, admin]) {
      const o = (await c.get(`/treatment-offers/${id}`)).body.offer;
      expect(o.cost).toBe(140.25);
      expect(o.items[0].cost).toBe(40);
    }
    const seen = (await staff.get(`/treatment-offers/${id}`)).body.offer;
    expect(seen).not.toHaveProperty('cost');
    expect(seen.items[0]).not.toHaveProperty('cost');
    expect(seen).toMatchObject({ price: 420.5 });
    expect((await staff.get('/treatment-offers')).body.data[0]).not.toHaveProperty('cost');
  });

  it('keeps one doctor out of another’s offer for every change as well', async () => {
    const exts = (await created(ext, { patientId: extPatient })).id;
    for (const [method, url, body] of [
      ['patch', `/treatment-offers/${exts}`, { title: 'x' }], ['put', `/treatment-offers/${exts}/items`, { items: [] }],
      ['post', `/treatment-offers/${exts}/accept`, {}], ['post', `/treatment-offers/${exts}/cancel`, {}], ['delete', `/treatment-offers/${exts}`, undefined],
    ] as const) expect((await aya.send(method, url, body)).status, url).toBe(404);
  });

  it('records changes in the activity log, ids only, and a doctor opening an offer as a view', async () => {
    const id = (await created()).id;
    await aya.get(`/treatment-offers/${id}`);
    const rows = await t.db('audit_log').whereIn('action', ['offer.create', 'offer.view']);
    expect(rows.map((r) => r.action).sort()).toEqual(['offer.create', 'offer.view']);
    expect(JSON.stringify(rows)).not.toContain('Root canal');
  });

  it('lists with filters, search and every sort', async () => {
    const a = await accepted(aya, { title: 'Alpha', items: [{ description: 'A', price: 300 }] });
    const b = await accepted(aya, { title: 'Bravo', items: [{ description: 'B', price: 100 }] });
    await aya.post('/payments', pay(b.id, 100));
    const draft = await drafted(aya, { title: 'Charlie', items: [{ description: 'C', price: 50 }] });
    const ids = async (qs: string) => (await aya.get(`/treatment-offers?${qs}`)).body.data.map((x: { id: number }) => x.id);
    expect(await ids('paymentState=paid')).toEqual([b.id]);
    expect(await ids('paymentState=unpaid')).toEqual([draft.id, a.id]);
    expect(await ids('status=draft')).toEqual([draft.id]);
    expect(await ids('status=draft,accepted')).toHaveLength(3);
    expect(await ids('debt=1')).toEqual([a.id]); // only an accepted offer with something left to pay (a draft is no debt)
    expect(await ids('q=alp')).toEqual([a.id]);
    expect(await ids('workState=not_started')).toHaveLength(3);
    expect(await ids('sort=price&order=desc')).toEqual([a.id, b.id, draft.id]);
    expect(await ids('sort=title&order=asc')).toEqual([a.id, b.id, draft.id]);
    expect((await ids('sort=paid&order=desc'))[0]).toBe(b.id);
    expect((await ids('sort=remaining&order=desc'))[0]).toBe(a.id);
    for (const sort of ['patient', 'status', 'created']) expect((await aya.get(`/treatment-offers?sort=${sort}`)).status).toBe(200);
    expect((await aya.get('/treatment-offers?sort=password')).status).toBe(400);
    expect((await aya.get('/treatment-offers?status=paid')).status).toBe(400); // paid is not a status
    expect((await aya.get('/treatment-offers?status=sent')).status).toBe(400); // nor is sent: nothing is sent online
  });
});

describe('editing an offer', () => {
  it('changes title, description, start date and notes, but not once it is closed', async () => {
    const id = (await created()).id;
    expect((await aya.patch(`/treatment-offers/${id}`, { title: 'New title', description: 'Short', startDate: '2026-11-01', notes: 'Slowly' })).body.offer).toMatchObject({ title: 'New title', description: 'Short', startDate: '2026-11-01', notes: 'Slowly' });
    expect((await aya.patch(`/treatment-offers/${id}`, {})).status).toBe(400);
    expect((await staff.patch(`/treatment-offers/${id}`, { title: 'x' })).status).toBe(403);
    await aya.post(`/treatment-offers/${id}/cancel`);
    expect((await aya.patch(`/treatment-offers/${id}`, { title: 'y' })).body.error.code).toBe('NOT_EDITABLE');
    expect((await aya.put(`/treatment-offers/${id}/items`, { items: [] })).body.error.code).toBe('NOT_EDITABLE');
  });

  it('replaces the items, keeping the ones sent with their id, re-ordering them, and the price follows', async () => {
    const o = await created();
    const [a, b] = o.items;
    const res = await aya.put(`/treatment-offers/${o.id}/items`, { items: [{ id: b.id, description: 'Crown', price: 250, cost: 90 }, { description: 'Whitening', price: 80 }] });
    expect(res.status).toBe(200);
    expect(res.body.offer.items.map((i: { description: string; id: number }) => [i.description, i.id === b.id])).toEqual([['Crown', true], ['Whitening', false]]);
    expect(res.body.offer).toMatchObject({ price: 330, cost: 90 });
    expect(await t.db('offer_items').where({ id: a.id }).first()).toBeUndefined();
    expect(await t.db('quotes').where({ id: o.id }).first()).toMatchObject({ price: 330 });
    expect((await aya.put(`/treatment-offers/${o.id}/items`, { items: [{ id: 999999, description: 'x', price: 1 }] })).body.error.code).toBe('UNKNOWN_ITEM');
    expect((await aya.put(`/treatment-offers/${o.id}/items`, { items: [] })).body.offer).toMatchObject({ price: 0 }); // an offer can be emptied
  });

  it('keeps the total from falling below what has been paid', async () => {
    const o = await accepted();
    await aya.post('/payments', pay(o.id, 400));
    const res = await aya.put(`/treatment-offers/${o.id}/items`, { items: [{ id: o.items[0].id, description: 'Root canal', price: 120 }, { id: o.items[1].id, description: 'Crown', price: 100 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_BELOW_PAID');
    const ok = await aya.put(`/treatment-offers/${o.id}/items`, { items: [{ id: o.items[0].id, description: 'Root canal', price: 120 }, { id: o.items[1].id, description: 'Crown', price: 280 }] });
    expect(ok.body.offer).toMatchObject({ price: 400, paid: 400, remaining: 0, paymentState: 'paid' });
  });
});

describe('statuses', () => {
  it('has only draft, accepted and cancelled: a draft is accepted by hand, and an offer can be cancelled', async () => {
    const d = await drafted();
    const act = async (id: number, a: string, c: Client = aya) => (await c.post(`/treatment-offers/${id}/${a}`)).body;
    expect((await act(d.id, 'accept')).offer.status).toBe('accepted');
    expect((await act(d.id, 'accept')).error.code).toBe('INVALID_OFFER_TRANSITION');
    for (const gone of ['send', 'reject', 'expire', 'bogus']) expect((await aya.post(`/treatment-offers/${d.id}/${gone}`)).status, gone).toBe(404);
    expect((await staff.post(`/treatment-offers/${d.id}/cancel`)).status).toBe(403);
    expect((await act(d.id, 'cancel')).offer.status).toBe('cancelled');
    expect((await act(d.id, 'cancel')).error.code).toBe('INVALID_OFFER_TRANSITION');
    expect((await act(d.id, 'accept')).error.code).toBe('INVALID_OFFER_TRANSITION');
    expect((await act((await drafted()).id, 'cancel')).offer.status).toBe('cancelled'); // a draft can be dropped too
  });

  it('never takes paid or partly paid as a status', async () => {
    const o = await accepted();
    expect(o.status).toBe('accepted');
    await aya.post('/payments', pay(o.id, 420.5));
    const now = (await aya.get(`/treatment-offers/${o.id}`)).body.offer;
    expect(now).toMatchObject({ status: 'accepted', paymentState: 'paid' });
  });

  it('refuses to cancel an offer that has payments or visits', async () => {
    const o = await accepted();
    await aya.post('/payments', pay(o.id, 10));
    expect((await aya.post(`/treatment-offers/${o.id}/cancel`)).body.error.code).toBe('HAS_PAYMENTS');
    const p = await accepted(aya, { title: 'With a visit' });
    await aya.post(`/treatment-offers/${p.id}/items/${p.items[0].id}/schedule`, slot());
    expect((await aya.post(`/treatment-offers/${p.id}/cancel`)).body.error.code).toBe('WORK_STARTED');
  });

  it('works out the payment state and the work state, never storing them', async () => {
    const o = await accepted();
    expect(o).toMatchObject({ paymentState: 'unpaid', workState: 'not_started' });
    await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/done`);
    expect((await aya.get(`/treatment-offers/${o.id}`)).body.offer).toMatchObject({ workState: 'in_progress', progress: { done: 1, total: 2, percent: 50 } });
    await aya.post(`/treatment-offers/${o.id}/items/${o.items[1].id}/done`);
    expect((await aya.get(`/treatment-offers/${o.id}`)).body.offer).toMatchObject({ workState: 'completed', status: 'accepted', paymentState: 'unpaid' });
  });
});

describe('booking the visits of an offer', () => {
  it('books an item as a confirmed appointment with its procedure and tooth, and the work goes in progress', async () => {
    const o = await accepted();
    const res = await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot());
    expect(res.status).toBe(201);
    expect(res.body.offer.workState).toBe('in_progress');
    expect(res.body.offer.items[0]).toMatchObject({ status: 'scheduled', appointment: { id: res.body.appointmentId, date: TOMORROW, time: '10:00', status: 'confirmed' } });
    const a = await t.db('appointments').where({ id: res.body.appointmentId }).first();
    expect(a).toMatchObject({ patient_id: s.patientId, intended: 'Root canal', status: 'confirmed' });
    expect(await t.db('appointment_category').where({ appointment_id: a.id }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
    expect(await t.db('appointment_tooth').where({ appointment_id: a.id }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('applies the usual booking rules, and books nothing when they fail', async () => {
    const o = await accepted();
    await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot());
    const clash = await aya.post(`/treatment-offers/${o.id}/items/${o.items[1].id}/schedule`, slot({ time: '10:15' }));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('DOCTOR_BUSY');
    expect(await t.db('appointments').count({ n: '*' }).first()).toMatchObject({ n: 1 });
    expect((await aya.post(`/treatment-offers/${o.id}/items/${o.items[1].id}/schedule`, slot({ time: '11:00', doctorId: 99999 }))).body.error.code).toBe('UNKNOWN_DOCTOR');
    expect((await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot({ time: '12:00' }))).body.error.code).toBe('ITEM_NOT_PENDING');
    expect((await aya.post(`/treatment-offers/${o.id}/items/999999/schedule`, slot({ time: '12:00' }))).status).toBe(404);
  });

  it('needs the offer to be accepted first (a draft is not enough)', async () => {
    for (const o of [await drafted()]) {
      const res = await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('OFFER_NOT_ACCEPTED');
    }
  });

  it('lets staff book the visits but not change the offer; an outside specialist only for himself', async () => {
    const o = await accepted();
    expect((await staff.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot())).status).toBe(201);
    expect((await staff.put(`/treatment-offers/${o.id}/items`, { items: [] })).status).toBe(403);
    const e = await accepted(ext, { patientId: extPatient });
    expect((await ext.post(`/treatment-offers/${e.id}/items/${e.items[0].id}/schedule`, slot({ doctorId: s.doctorId, time: '14:00' }))).status).toBe(403);
    expect((await ext.post(`/treatment-offers/${e.id}/items/${e.items[0].id}/schedule`, slot({ doctorId: s.externalDoctorId, unitId: s.unitId, time: '14:00' }))).status).toBe(201);
    expect((await patient.post(`/treatment-offers/${o.id}/items/${o.items[1].id}/schedule`, slot({ time: '16:00' }))).status).toBe(403);
  });

  it('cannot remove an item that is booked or done', async () => {
    const o = await accepted();
    await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot());
    const res = await aya.put(`/treatment-offers/${o.id}/items`, { items: [{ id: o.items[1].id, description: 'Crown', price: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_IN_USE');
  });
});

describe('an offer follows its visits', () => {
  const book = async () => {
    const o = await accepted();
    const first = (await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot())).body.appointmentId as number;
    return { o, first };
  };
  const get = async (id: number) => (await aya.get(`/treatment-offers/${id}`)).body.offer;

  it('marks the item done when its visit is completed, and the work completed when all are', async () => {
    const { o, first } = await book();
    await t.db('appointments').where({ id: first }).update({ date: '2026-10-01' }); // in the past, so it can be completed
    expect((await aya.post(`/appointments/${first}/complete`)).status).toBe(200);
    const mid = await get(o.id);
    expect(mid.items[0].status).toBe('done');
    expect(mid).toMatchObject({ workState: 'in_progress', progress: { done: 1, total: 2, percent: 50 } });
    const second = (await aya.post(`/treatment-offers/${o.id}/items/${o.items[1].id}/schedule`, slot({ time: '11:00', date: '2026-10-02' }))).body.appointmentId;
    await t.db('appointments').where({ id: second }).update({ date: '2026-10-02' });
    await aya.post(`/appointments/${second}/complete`);
    expect(await get(o.id)).toMatchObject({ workState: 'completed', status: 'accepted', progress: { done: 2, total: 2, percent: 100 } });
  });

  it('frees the item again when its visit is cancelled, marked no-show or deleted', async () => {
    const { o, first } = await book();
    await aya.post(`/appointments/${first}/cancel`);
    let now = await get(o.id);
    expect(now.items[0]).toMatchObject({ status: 'pending', appointment: null });
    expect(now.workState).toBe('not_started'); // nothing booked any more
    const again = (await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/schedule`, slot({ time: '13:00' }))).body.appointmentId;
    expect((await get(o.id)).workState).toBe('in_progress');
    expect((await del(aya, `/appointments/${again}`)).status).toBe(204);
    now = await get(o.id);
    expect(now.items[0].status).toBe('pending');
    expect(now.workState).toBe('not_started');
  });

  it('can mark an item done by hand, when no visit is behind it', async () => {
    const o = await accepted();
    const res = await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/done`);
    expect(res.body.offer.items[0].status).toBe('done');
    expect(res.body.offer.workState).toBe('in_progress');
    expect((await aya.post(`/treatment-offers/${o.id}/items/${o.items[0].id}/done`)).status).toBe(409);
    expect((await staff.post(`/treatment-offers/${o.id}/items/${o.items[1].id}/done`)).status).toBe(403);
    const draft = await drafted();
    expect((await aya.post(`/treatment-offers/${draft.id}/items/${draft.items[0].id}/done`)).body.error.code).toBe('OFFER_NOT_ACCEPTED');
  });
});

describe('the offer as a PDF', () => {
  it('lists the items and the total for the patient, never the cost, and is logged', async () => {
    const o = await accepted();
    await aya.post('/payments', pay(o.id, 100));
    const res = await aya.agent.get(`/api/v1/treatment-offers/${o.id}/pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const raw = (res.body as Buffer).toString('latin1');
    // pdfkit stores text as hex pieces inside TJ arrays; join them back into words
    const text = [...raw.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) => [...m[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join('')).join('\n');
    expect(text).toContain('Root canal');
    expect(text).toContain('$420.50');
    expect(text).not.toContain('140.25'); // no clinic cost
    expect(await t.db('audit_log').where({ action: 'offer.pdf' }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
    expect((await staff.get(`/treatment-offers/${o.id}/pdf`)).status).toBe(200); // staff may print it too
    expect((await patient.get(`/treatment-offers/${o.id}/pdf`)).status).toBe(403);
  });
});

describe('deleting an offer', () => {
  it('is soft: gone from lists and reads, row kept, and only the patient’s doctor or admin can', async () => {
    const id = (await created()).id;
    expect((await staff.send('delete', `/treatment-offers/${id}`)).status).toBe(403);
    expect((await del(aya, `/treatment-offers/${id}`)).status).toBe(204);
    expect((await aya.get(`/treatment-offers/${id}`)).status).toBe(404);
    expect((await admin.get('/treatment-offers')).body.data).toEqual([]);
    expect((await t.db('quotes').where({ id }).first()).deleted_at).not.toBeNull();
    expect(await t.db('offer_items').where({ offer_id: id }).count({ n: '*' }).first()).toMatchObject({ n: 2 }); // the items stay with it
  });

  it('hides the offers of a deleted patient', async () => {
    const id = (await created()).id;
    await del(staff, `/patients/${s.patientId}`);
    expect((await admin.get(`/treatment-offers/${id}`)).status).toBe(404);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: null });
  });
});
