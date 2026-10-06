import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

let t: TestApp;
let s: Seed;
let admin: Client, doctor: Client, staff: Client, patient: Client;

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  [admin, doctor, staff, patient] = await Promise.all(
    ['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)),
  );
});
afterAll(() => t.destroy());
beforeEach(async () => {
  await t.db('medication_report').del();
  await t.db('reports').del();
  await t.db('appointment_category').del();
  await t.db('appointments').del();
  await t.db('medications').del();
  await t.db('categories').whereNotIn('id', s.categoryIds).del();
  await t.db('audit_log').del();
});

describe('medications (prescribing list)', () => {
  const add = (c: Client, body: object) => c.post('/medications', body);

  it('is readable by admins, doctors and staff, not patients', async () => {
    await add(admin, { name: 'Amoxicillin', type: 'capsule' });
    for (const c of [admin, doctor, staff]) expect((await c.get('/medications')).body.data).toEqual([{ id: expect.any(Number), name: 'Amoxicillin', type: 'capsule' }]);
    expect((await patient.get('/medications')).status).toBe(403);
    expect((await t.client().get('/medications')).status).toBe(401);
  });

  it('lists in alphabetical order', async () => {
    for (const name of ['Paracetamol', 'Amoxicillin', 'Ibuprofen']) await add(admin, { name });
    expect((await admin.get('/medications')).body.data.map((m: { name: string }) => m.name)).toEqual(['Amoxicillin', 'Ibuprofen', 'Paracetamol']);
  });

  it('lets admins and doctors add and edit, but staff and patients not', async () => {
    const created = await add(doctor, { name: ' Ibuprofen ', type: '' });
    expect(created.status).toBe(201);
    expect(created.body.medication).toMatchObject({ name: 'Ibuprofen', type: null });
    const id = created.body.medication.id;
    expect((await admin.patch(`/medications/${id}`, { type: 'tablet' })).body.medication.type).toBe('tablet');
    expect((await doctor.patch(`/medications/${id}`, { name: 'Ibuprofen 400' })).body.medication.name).toBe('Ibuprofen 400');
    for (const c of [staff, patient]) {
      expect((await add(c, { name: 'Nope' })).status).toBe(403);
      expect((await c.patch(`/medications/${id}`, { name: 'Nope' })).status).toBe(403);
    }
  });

  it('keeps names unique, ignoring case, on create and rename', async () => {
    const first = (await add(admin, { name: 'Amoxicillin' })).body.medication.id;
    expect((await add(doctor, { name: 'AMOXICILLIN' })).body.error.code).toBe('NAME_TAKEN');
    const other = (await add(admin, { name: 'Ibuprofen' })).body.medication.id;
    expect((await admin.patch(`/medications/${other}`, { name: 'amoxicillin' })).body.error.code).toBe('NAME_TAKEN');
    expect((await admin.patch(`/medications/${first}`, { name: 'Amoxicillin' })).status).toBe(200); // its own name is fine
  });

  it('validates', async () => {
    expect((await add(admin, { name: '' })).status).toBe(400);
    expect((await add(admin, {})).status).toBe(400);
    expect((await add(admin, { name: 'x'.repeat(256) })).status).toBe(400);
    const id = (await add(admin, { name: 'Valid' })).body.medication.id;
    expect((await admin.patch(`/medications/${id}`, {})).status).toBe(400);
    expect((await admin.patch('/medications/99999', { name: 'x' })).status).toBe(404);
    expect((await admin.patch('/medications/abc', { name: 'x' })).status).toBe(400);
  });

  it('can be deleted by an admin only, and not while prescribed', async () => {
    const id = (await add(admin, { name: 'Temporary' })).body.medication.id;
    for (const c of [doctor, staff, patient]) expect((await c.send('delete', `/medications/${id}`)).status).toBe(403);
    expect((await admin.send('delete', `/medications/${id}`)).status).toBe(204);
    expect((await admin.send('delete', `/medications/${id}`)).status).toBe(404);

    const used = (await add(admin, { name: 'Used' })).body.medication.id;
    const appt = await t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'completed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId }).then(([i]) => i);
    const [report] = await t.db('reports').insert({ appointment_id: appt });
    await t.db('medication_report').insert({ medication_id: used, report_id: report, dose: '1', frequency: '1', time_unit: 'day' });
    expect((await admin.send('delete', `/medications/${used}`)).body.error.code).toBe('MEDICATION_IN_USE');
  });

  it('logs changes', async () => {
    await add(doctor, { name: 'Logged' });
    expect(await t.db('audit_log').where({ action: 'medication.create' })).toHaveLength(1);
  });
});

describe('procedures (categories)', () => {
  const body = (extra: object = {}) => ({ name: 'Bridge', priceMin: 200, priceMax: 400, features: ['Zirconia'], featurePrices: [150], ...extra });

  it('is readable by clinic staff with its extras', async () => {
    const id = (await admin.post('/categories', body())).body.category.id;
    for (const c of [admin, doctor, staff]) {
      const found = (await c.get('/categories')).body.data.find((x: { id: number }) => x.id === id);
      expect(found).toEqual({ id, name: 'Bridge', priceMin: 200, priceMax: 400, features: ['Zirconia'], featurePrices: [150] });
    }
    expect((await patient.get('/categories')).status).toBe(403);
  });

  it('reads the existing procedures, even those stored without extras', async () => {
    const rows = (await admin.get('/categories')).body.data;
    expect(rows.find((x: { name: string }) => x.name === 'Scaling')).toMatchObject({ features: [], featurePrices: [] });
  });

  it('lets only admins create, change and delete', async () => {
    for (const c of [doctor, staff, patient]) {
      expect((await c.post('/categories', body())).status).toBe(403);
      expect((await c.patch(`/categories/${s.categoryIds[0]}`, { name: 'Hijack' })).status).toBe(403);
      expect((await c.send('delete', `/categories/${s.categoryIds[0]}`)).status).toBe(403);
    }
    const created = await admin.post('/categories', body());
    expect(created.status).toBe(201);
    const id = created.body.category.id;
    expect((await admin.patch(`/categories/${id}`, { priceMax: 500 })).body.category).toMatchObject({ priceMin: 200, priceMax: 500 });
    expect((await admin.send('delete', `/categories/${id}`)).status).toBe(204);
  });

  it('keeps the price range and the extras consistent, including against stored values', async () => {
    expect((await admin.post('/categories', body({ priceMin: 500, priceMax: 100 }))).status).toBe(400);
    expect((await admin.post('/categories', body({ priceMin: -1 }))).status).toBe(400);
    expect((await admin.post('/categories', body({ features: ['A', 'B'], featurePrices: [1] }))).status).toBe(400);
    const id = (await admin.post('/categories', body())).body.category.id;
    expect((await admin.patch(`/categories/${id}`, { priceMin: 900 })).body.error.code).toBe('INVALID_PRICE_RANGE'); // above the stored maximum
    expect((await admin.patch(`/categories/${id}`, { features: ['A', 'B'] })).body.error.code).toBe('INVALID_EXTRAS'); // stored prices no longer match
    expect((await admin.patch(`/categories/${id}`, { features: ['A', 'B'], featurePrices: [1, 2] })).status).toBe(200);
  });

  it('validates the name and unknown ids', async () => {
    expect((await admin.post('/categories', body({ name: '' }))).status).toBe(400);
    expect((await admin.patch(`/categories/${s.categoryIds[0]}`, {})).status).toBe(400);
    expect((await admin.patch('/categories/99999', { name: 'x' })).status).toBe(404);
    expect((await admin.send('delete', '/categories/99999')).status).toBe(404);
  });

  it('cannot be deleted while appointments use it', async () => {
    const id = (await admin.post('/categories', body())).body.category.id;
    const appt = await t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId }).then(([i]) => i);
    await t.db('appointment_category').insert({ appointment_id: appt, category_id: id });
    expect((await admin.send('delete', `/categories/${id}`)).body.error.code).toBe('CATEGORY_IN_USE');
  });
});
