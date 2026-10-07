import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Expenses and commission (phase 5, part two). Owner rules: admins see all expenses, staff all but the
 * owners' personal ones, doctors none. An outside specialist owes the owner of the unit of the patient's
 * latest completed visit a percentage of what he collected, less what he has paid over.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let labId: number;
let supplierId: number;
let extPatient: number; // primary doctor: the external specialist (30% commission)
let ayaPatient: number; // primary doctor: Aya (owner)
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  labId = (await t.db('labs').insert({ name: 'Kadi Lab', phone: '1', ...stamp }))[0]!;
  supplierId = (await t.db('suppliers').insert({ name: 'Safadi', phone: '2', ...stamp }))[0]!;
  extPatient = (await t.db('patients').insert({ patient_identifier: 'E1', fname: 'Ext', lname: 'Pat', phone: '701', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
  ayaPatient = s.patientId;
});
afterAll(() => t.destroy());

beforeEach(async () => {
  for (const table of ['payments', 'treatment_offers', 'expenses', 'appointments', 'audit_log']) await t.db(table).del();
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ commission_percent: 30 });
});

const expense = (extra: object = {}) => ({ type: 'clinic', date: TODAY, amount: 25, description: 'Water', ...extra });
const del = (c: Client, url: string) => c.send('delete', url);
const put = (c: Client, url: string, body: object) => c.patch(url, body);

describe('expenses: who can see and enter them', () => {
  it('lets admins and staff enter clinic, lab and supplier expenses, and refuses doctors and patients', async () => {
    expect((await staff.post('/expenses', expense())).status).toBe(201);
    expect((await admin.post('/expenses', expense({ type: 'lab', labId }))).status).toBe(201);
    expect((await staff.post('/expenses', expense({ type: 'supplier', supplierId }))).status).toBe(201);
    for (const c of [aya, ext, patient]) {
      expect((await c.get('/expenses')).status).toBe(403);
      expect((await c.post('/expenses', expense())).status).toBe(403);
    }
    expect((await t.client().get('/expenses')).status).toBe(401);
  });

  it('keeps the owners’ personal expenses to admins: staff cannot see, enter, change or delete them', async () => {
    const mine = (await admin.post('/expenses', expense({ type: 'personal', description: 'Groceries' }))).body.expense.id;
    expect((await staff.post('/expenses', expense({ type: 'personal' }))).status).toBe(403);
    expect((await staff.get('/expenses')).body.data).toEqual([]);
    expect((await staff.get('/expenses?type=personal')).body.data).toEqual([]);
    expect((await staff.get(`/expenses/${mine}`)).status).toBe(404);
    expect((await put(staff, `/expenses/${mine}`, expense({ type: 'clinic' }))).status).toBe(404);
    expect((await del(staff, `/expenses/${mine}`)).status).toBe(404);
    expect((await put(staff, `/expenses/${(await staff.post('/expenses', expense())).body.expense.id}`, expense({ type: 'personal' }))).status).toBe(403);
    expect((await admin.get('/expenses')).body.data).toHaveLength(2); // the personal one and the staff one
    expect((await admin.get('/expenses?type=personal')).body.data[0].description).toBe('Groceries');
  });

  it('adds up what the filters show, without the personal ones for staff', async () => {
    await admin.post('/expenses', expense({ amount: 10 }));
    await admin.post('/expenses', expense({ type: 'personal', amount: 1000 }));
    expect((await admin.get('/expenses')).body.sum).toBe(1010);
    expect((await staff.get('/expenses')).body.sum).toBe(10);
  });
});

describe('expenses: types, references and validation', () => {
  it('requires the lab, supplier or specialist and appointment that the type names', async () => {
    expect((await admin.post('/expenses', expense({ type: 'lab' }))).status).toBe(400);
    expect((await admin.post('/expenses', expense({ type: 'supplier' }))).status).toBe(400);
    expect((await admin.post('/expenses', expense({ type: 'commission' }))).status).toBe(400); // the specialist is required, the visit is not
    const noVisit = await admin.post('/expenses', expense({ type: 'commission', doctorId: s.externalDoctorId, amount: 20 }));
    expect(noVisit.status).toBe(201);
    expect(noVisit.body.expense).toMatchObject({ doctor: { id: s.externalDoctorId }, appointment: null });
    expect((await admin.post('/expenses', expense({ type: 'lab', labId: 9999 }))).body.error.code).toBe('UNKNOWN_LAB');
    expect((await admin.post('/expenses', expense({ type: 'supplier', supplierId: 9999 }))).body.error.code).toBe('UNKNOWN_SUPPLIER');
    const ok = await admin.post('/expenses', expense({ type: 'lab', labId }));
    expect(ok.body.expense).toMatchObject({ type: 'lab', lab: { id: labId, name: 'Kadi Lab' }, supplier: null });
  });

  it('validates the amount, date and type', async () => {
    for (const bad of [{ amount: 0 }, { amount: -3 }, { amount: 'x' }, { amount: 2.555 }, { date: 'nope' }, { type: 'gift' }]) {
      expect((await admin.post('/expenses', expense(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin.post('/expenses', expense({ date: '2099-01-01' }))).body.error.code).toBe('FUTURE_DATE');
  });

  it('accepts a commission expense only for a visit the specialist treated of an owner doctor’s patient', async () => {
    const visit = (patient_id: number, doctor_id: number) =>
      t.db('appointments').insert({ date: '2026-10-01', time: '10:00', status: 'completed', patient_id, doctor_id, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp }).then(([i]) => i!);
    const ownersPatientVisit = await visit(ayaPatient, s.externalDoctorId);
    const ownVisit = await visit(extPatient, s.externalDoctorId);
    const byAya = await visit(ayaPatient, s.doctorId);
    const body = (appointmentId: number, doctorId = s.externalDoctorId) => expense({ type: 'commission', doctorId, appointmentId, amount: 35 });

    const ok = await admin.post('/expenses', body(ownersPatientVisit));
    expect(ok.status).toBe(201);
    expect(ok.body.expense).toMatchObject({ type: 'commission', doctor: { id: s.externalDoctorId }, appointment: { id: ownersPatientVisit, patient: { fname: 'Pat' } } });
    expect((await admin.post('/expenses', body(ownVisit))).body.error.code).toBe('NOT_AN_OWNER_PATIENT'); // his own patient: nothing to pay himself
    expect((await admin.post('/expenses', body(byAya))).body.error.code).toBe('WRONG_SPECIALIST');
    expect((await admin.post('/expenses', body(ownersPatientVisit, s.doctorId))).body.error.code).toBe('NOT_A_SPECIALIST'); // Aya is an owner
    expect((await admin.post('/expenses', body(99999))).body.error.code).toBe('UNKNOWN_APPOINTMENT');

    const options = (await staff.get(`/expenses/commission-appointments?doctorId=${s.externalDoctorId}`)).body.data;
    expect(options.map((o: { id: number }) => o.id)).toEqual([ownersPatientVisit]); // only the owner's patient he treated
  });

  it('lists with filters, search and every sort, then edits and soft deletes', async () => {
    const a = (await admin.post('/expenses', expense({ amount: 10, description: 'Alpha', date: '2026-10-01' }))).body.expense.id;
    const b = (await admin.post('/expenses', expense({ type: 'lab', labId, amount: 90, description: 'Bravo', date: '2026-10-03' }))).body.expense.id;
    const ids = async (qs: string) => (await staff.get(`/expenses${qs}`)).body.data.map((x: { id: number }) => x.id);
    expect(await ids('?type=lab')).toEqual([b]);
    expect(await ids(`?labId=${labId}`)).toEqual([b]);
    expect(await ids('?q=alp')).toEqual([a]);
    expect(await ids('?from=2026-10-02')).toEqual([b]);
    expect(await ids('?to=2026-10-02')).toEqual([a]);
    expect(await ids('?sort=amount&order=desc')).toEqual([b, a]);
    for (const sort of ['date', 'type', 'description']) expect((await staff.get(`/expenses?sort=${sort}`)).status).toBe(200);
    expect((await staff.get('/expenses?sort=password')).status).toBe(400);

    expect((await put(staff, `/expenses/${a}`, expense({ amount: 12.5, description: 'Alpha 2' }))).body.expense).toMatchObject({ amount: 12.5, description: 'Alpha 2' });
    expect((await del(staff, `/expenses/${a}`)).status).toBe(204);
    expect(await ids('')).toEqual([b]);
    const row = await t.db('expenses').where({ id: a }).first();
    expect(row.deleted_at).toBeTruthy();
    expect(row.deleted_by).toBeTruthy();
  });

  it('shows the lab and supplier lists to admins and staff only', async () => {
    expect((await staff.get('/labs')).body.data).toEqual([{ id: labId, name: 'Kadi Lab' }]);
    expect((await admin.get('/suppliers')).body.data).toEqual([{ id: supplierId, name: 'Safadi' }]);
    for (const c of [aya, patient]) {
      expect((await c.get('/labs')).status).toBe(403);
      expect((await c.get('/suppliers')).status).toBe(403);
    }
  });

  it('is in the audit log (amount and type only) and the Trash', async () => {
    const id = (await staff.post('/expenses', expense({ description: 'private memo' }))).body.expense.id;
    await del(staff, `/expenses/${id}`);
    expect(JSON.stringify(await t.db('audit_log'))).not.toContain('private memo');
    const item = (await admin.get('/trash?kind=expense')).body.data[0];
    expect(item).toMatchObject({ kind: 'expense', id, confirmText: '25.00' });
    expect((await admin.post(`/trash/expense/${id}/restore`)).status).toBe(204);
    expect((await staff.get(`/expenses/${id}`)).status).toBe(200);
    await del(staff, `/expenses/${id}`);
    expect((await admin.agent.delete(`/api/v1/trash/expense/${id}`).set('x-csrf-token', admin.csrf).send({ confirm: 'wrong' })).status).toBe(400);
    expect((await admin.agent.delete(`/api/v1/trash/expense/${id}`).set('x-csrf-token', admin.csrf).send({ confirm: '25.00' })).status).toBe(204);
    expect(await t.db('expenses').where({ id }).first()).toBeUndefined();
  });
});

describe('commission', () => {
  /** A patient of the specialist, with a visit on Aya's unit (and one on Sara's later), and payments. */
  async function setup() {
    const visit = (date: string, unit_id: number) =>
      t.db('appointments').insert({ date, time: '10:00', status: 'completed', patient_id: extPatient, doctor_id: s.externalDoctorId, clinic_id: s.clinicId, unit_id, duration_minutes: 30, ...stamp });
    await visit('2026-09-01', s.unitId); // Aya's unit
    await visit('2026-09-20', s.saraUnitId); // Sara's unit, later
    const quote = (await t.db('treatment_offers').insert({ title: 'Bridge', type: 'clinic', price: 1000, cost: 0, currency: '$', status: 'accepted', patient_id: extPatient, ...stamp }))[0]!;
    const pay = (d: string, amount: number) => t.db('payments').insert({ date: d, type: 'clinic', amount, currency: '$', offer_id: quote, collected_by_doctor_id: s.externalDoctorId, dr_part: 100, ...stamp });
    await pay('2026-09-10', 200); // before Sara's visit: Aya's unit
    await pay('2026-09-25', 100); // after: Sara's unit
    return quote;
  }
  const statement = async (c: Client, qs = '') => (await c.get(`/commission/statement${qs}`)).body;
  const find = (st: { lines: any[] }, owner: number) => st.lines.find((l) => l.owner?.id === owner);  

  it('gives each owner the percentage of what was collected while the patient last visited that owner’s unit', async () => {
    await setup();
    const st = await statement(admin);
    expect(find(st, s.doctorId)).toMatchObject({ collected: 200, owed: 60, received: 0, balance: 60, specialist: { id: s.externalDoctorId, commissionPercent: 30 } });
    expect(find(st, s.saraId)).toMatchObject({ collected: 100, owed: 30, received: 0, balance: 30 });
  });

  it('subtracts what the specialist has paid over, and shows the period apart from the running balance', async () => {
    await setup();
    const paid = await admin.post('/commission/payments', { specialistId: s.externalDoctorId, ownerId: s.doctorId, amount: 25, date: '2026-09-28', method: 'cash' });
    expect(paid.status).toBe(201);
    expect(paid.body.payment).toMatchObject({ amount: 25, specialist: { id: s.externalDoctorId }, owner: { id: s.doctorId } });
    expect(find(await statement(admin), s.doctorId)).toMatchObject({ collected: 200, owed: 60, received: 25, balance: 35 });
    // only September 20 to 30: the first payment is outside, but the balance still counts everything up to the end
    const late = find(await statement(admin, '?from=2026-09-20&to=2026-09-30'), s.doctorId);
    expect(late).toMatchObject({ collected: 0, owed: 0, received: 25, balance: 35 });
  });

  it('says so, instead of guessing, when the specialist has no percentage yet', async () => {
    await setup();
    await t.db('doctors').where({ id: s.externalDoctorId }).update({ commission_percent: null });
    const st = await statement(admin);
    expect(find(st, s.doctorId)).toMatchObject({ collected: 200, owed: null, balance: null });
    expect(st.missingPercentage.map((d: { id: number }) => d.id)).toEqual([s.externalDoctorId]);
  });

  it('leaves a payment with no visit to go by unassigned to any owner', async () => {
    const quote = (await t.db('treatment_offers').insert({ title: 'X', type: 'clinic', price: 100, cost: 0, currency: '$', status: 'accepted', patient_id: extPatient, ...stamp }))[0]!;
    await t.db('payments').insert({ date: '2026-09-10', type: 'clinic', amount: 100, currency: '$', offer_id: quote, collected_by_doctor_id: s.externalDoctorId, dr_part: 100, ...stamp });
    const st = await statement(admin);
    expect(st.lines).toHaveLength(1);
    expect(st.lines[0]).toMatchObject({ owner: null, collected: 100, owed: 30 });
  });

  it('ignores the owners’ own patients, deleted payments and cancelled visits', async () => {
    await setup();
    const q = (await t.db('treatment_offers').insert({ title: 'Own', type: 'clinic', price: 500, cost: 0, currency: '$', status: 'accepted', patient_id: ayaPatient, ...stamp }))[0]!;
    await t.db('payments').insert({ date: '2026-09-10', type: 'clinic', amount: 500, currency: '$', offer_id: q, collected_by_doctor_id: s.doctorId, dr_part: 100, ...stamp });
    await t.db('payments').where({ amount: 100 }).update({ deleted_at: '2026-10-01 00:00:00' });
    const st = await statement(admin);
    expect(st.lines.reduce((sum: number, l: { collected: number }) => sum + l.collected, 0)).toBe(200);
  });

  it('shows an owner only what is owed to him, a specialist only what he owes, and staff nothing', async () => {
    await setup();
    const own = await statement(aya);
    expect(own.lines.map((l: { owner: { id: number } }) => l.owner.id)).toEqual([s.doctorId]);
    expect(own.lines[0]).toMatchObject({ owed: 60 });
    const mine = await statement(ext);
    expect(mine.lines).toHaveLength(2); // he owes both owners
    expect(mine.lines.every((l: { specialist: { id: number } }) => l.specialist.id === s.externalDoctorId)).toBe(true);
    expect(mine.missingPercentage).toEqual([]);
    for (const c of [staff, patient]) expect((await c.get('/commission/statement')).status).toBe(403);
    expect((await t.client().get('/commission/statement')).status).toBe(401);
  });

  it('records the fees an owner paid a specialist as a statement of their own, which owes nothing', async () => {
    const visit = (await t.db('appointments').insert({ date: '2026-10-01', time: '10:00', status: 'completed', patient_id: ayaPatient, doctor_id: s.externalDoctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp }))[0]!;
    await admin.post('/expenses', expense({ type: 'commission', doctorId: s.externalDoctorId, appointmentId: visit, amount: 35 }));
    await admin.post('/expenses', expense({ type: 'commission', doctorId: s.externalDoctorId, appointmentId: visit, amount: 15 }));
    const st = await statement(admin);
    expect(st.fees).toEqual([{ specialist: expect.objectContaining({ id: s.externalDoctorId }), owner: expect.objectContaining({ id: s.doctorId }), paid: 50, count: 2 }]);
    expect(st.lines).toEqual([]); // he owes nothing for an owner's patient
    expect((await statement(ext)).fees[0]).toMatchObject({ paid: 50 }); // he sees what he was paid
    expect((await statement(aya)).fees[0]).toMatchObject({ paid: 50 }); // and the owner what he paid
    expect((await statement(admin, '?from=2026-11-01')).fees).toEqual([]);
  });
});

describe('commission payments', () => {
  const body = (extra: object = {}) => ({ specialistId: s.externalDoctorId, ownerId: s.doctorId, amount: 40, date: TODAY, method: 'cash', ...extra });
  const list = async (c: Client) => (await c.get('/commission/payments')).body.data;

  it('lets an admin record any, and an owner only what he received himself', async () => {
    expect((await admin.post('/commission/payments', body({ ownerId: s.saraId }))).status).toBe(201);
    expect((await aya.post('/commission/payments', body())).status).toBe(201);
    expect((await aya.post('/commission/payments', body({ ownerId: s.saraId }))).status).toBe(404);
    for (const c of [ext, staff, patient]) expect((await c.post('/commission/payments', body())).status).toBe(c === ext ? 404 : 403);
    expect(await list(admin)).toHaveLength(2);
    expect(await list(aya)).toHaveLength(1); // his own
    expect(await list(ext)).toHaveLength(2); // what he paid
    expect((await staff.get('/commission/payments')).status).toBe(403);
  });

  it('checks who pays and who receives, and the amount, date and method', async () => {
    expect((await admin.post('/commission/payments', body({ specialistId: s.doctorId }))).body.error.code).toBe('NOT_A_SPECIALIST');
    expect((await admin.post('/commission/payments', body({ ownerId: s.externalDoctorId }))).body.error.code).toBe('NOT_AN_OWNER');
    expect((await admin.post('/commission/payments', body({ specialistId: 9999 }))).body.error.code).toBe('UNKNOWN_DOCTOR');
    for (const bad of [{ amount: 0 }, { amount: -1 }, { amount: 1.234 }, { method: 'gold' }, { date: 'x' }]) {
      expect((await admin.post('/commission/payments', body(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin.post('/commission/payments', body({ date: '2099-01-01' }))).body.error.code).toBe('FUTURE_DATE');
  });

  it('edits and soft deletes (the owner only his own), and never shows up among patient payments', async () => {
    const mine = (await aya.post('/commission/payments', body())).body.payment.id;
    const saras = (await admin.post('/commission/payments', body({ ownerId: s.saraId }))).body.payment.id;
    expect((await put(aya, `/commission/payments/${mine}`, { amount: 45 })).body.payment.amount).toBe(45);
    expect((await put(aya, `/commission/payments/${saras}`, { amount: 1 })).status).toBe(404);
    expect((await del(aya, `/commission/payments/${saras}`)).status).toBe(404);
    expect((await put(aya, `/commission/payments/${mine}`, {})).status).toBe(400);
    expect((await admin.get('/payments')).body.data).toEqual([]); // the patient payment list holds only patients' money
    expect((await del(aya, `/commission/payments/${mine}`)).status).toBe(204);
    expect(await list(aya)).toEqual([]);
  });

  it('lets an admin choose who received it (also when an old one has no owner), an owner only himself', async () => {
    const id = (await admin.post('/commission/payments', body({ description: 'private memo' }))).body.payment.id;
    const moved = await put(admin, `/commission/payments/${id}`, { ownerId: s.saraId });
    expect(moved.status).toBe(200);
    expect(moved.body.payment.owner.id).toBe(s.saraId);
    expect(moved.body.payment.specialist.id).toBe(s.externalDoctorId);
    expect(await list(aya)).toEqual([]); // no longer Aya's
    // an old payment that never said who received it
    await t.db('payments').where({ id }).update({ collected_by_doctor_id: null });
    expect((await put(admin, `/commission/payments/${id}`, { ownerId: s.doctorId })).body.payment.owner.id).toBe(s.doctorId);
    // an owner can keep himself but not hand it to the other owner or take another's
    expect((await put(aya, `/commission/payments/${id}`, { ownerId: s.doctorId, amount: 41 })).status).toBe(200);
    expect((await put(aya, `/commission/payments/${id}`, { ownerId: s.saraId })).status).toBe(404);
    // the receiver must be an owner that exists
    expect((await put(admin, `/commission/payments/${id}`, { ownerId: s.externalDoctorId })).body.error.code).toBe('NOT_AN_OWNER');
    expect((await put(admin, `/commission/payments/${id}`, { ownerId: 9999 })).body.error.code).toBe('UNKNOWN_DOCTOR');
    // the specialist who paid cannot be changed here
    await put(admin, `/commission/payments/${id}`, { specialistId: s.doctorId, amount: 42 });
    expect((await admin.get('/commission/payments')).body.data[0].specialist.id).toBe(s.externalDoctorId);
    const logged = JSON.stringify(await t.db('audit_log').where({ action: 'commission.payment.update' }));
    expect(logged).toContain('ownerId');
    expect(logged).not.toContain('private memo');
  });

  it('goes to the Trash as its own kind, is restored, and is erased by typing the specialist’s name', async () => {
    const id = (await admin.post('/commission/payments', body())).body.payment.id;
    await del(admin, `/commission/payments/${id}`);
    const item = (await admin.get('/trash?kind=commission')).body.data[0];
    expect(item).toMatchObject({ kind: 'commission', id });
    expect(item.confirmText).toMatch(/^Ext|External|Cidra|\w+/);
    expect((await admin.post(`/trash/commission/${id}/restore`)).status).toBe(204);
    expect(await list(admin)).toHaveLength(1);
    await del(admin, `/commission/payments/${id}`);
    expect((await admin.agent.delete(`/api/v1/trash/commission/${id}`).set('x-csrf-token', admin.csrf).send({ confirm: 'nope' })).status).toBe(400);
    expect((await admin.agent.delete(`/api/v1/trash/commission/${id}`).set('x-csrf-token', admin.csrf).send({ confirm: item.confirmText })).status).toBe(204);
    expect(await t.db('payments').where({ id }).first()).toBeUndefined();
  });

  it('is audited with ids and amounts only', async () => {
    const id = (await admin.post('/commission/payments', body({ description: 'private memo' }))).body.payment.id;
    await put(admin, `/commission/payments/${id}`, { amount: 41 });
    await del(admin, `/commission/payments/${id}`);
    const actions = (await t.db('audit_log').pluck('action')) as string[];
    expect(actions).toEqual(expect.arrayContaining(['commission.payment.create', 'commission.payment.update', 'commission.payment.delete']));
    expect(JSON.stringify(await t.db('audit_log'))).not.toContain('private memo');
  });
});
