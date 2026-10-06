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

const SEEDED_DOCTORS = () => [s.doctorId, s.saraId, s.externalDoctorId, s.floatingDoctorId];

beforeEach(async () => {
  await t.db('appointments').del();
  await t.db('dental_units').whereNotIn('id', [s.unitId, s.saraUnitId]).del();
  await t.db('doctors').whereNotIn('id', SEEDED_DOCTORS()).del();
  await t.db('clinics').whereNot({ id: s.clinicId }).del();
  await t.db('clinic_doctor').where({ doctor_id: s.floatingDoctorId }).del();
  await t.db('doctors').where({ id: s.floatingDoctorId }).update({ kind: 'external', commission_percent: 40 });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ kind: 'external', commission_percent: 30 });
  await t.db('audit_log').del();
});

const newExternal = (extra: object = {}) => ({ fname: 'New', lname: 'Specialist', kind: 'external', commissionPercent: 25, ...extra });

describe('reading doctors', () => {
  it('shows staff contact details but patients only public ones', async () => {
    const aya = (c: Client) => c.get('/doctors').then((r) => r.body.data.find((d: { id: number }) => d.id === s.doctorId));
    expect(await aya(staff)).toMatchObject({ email: 'aya@clinic.test', phone: '111', kind: 'owner' });
    const asPatient = await aya(patient);
    expect(asPatient).toMatchObject({ fname: 'Aya', speciality: 'General', kind: 'owner' });
    expect(asPatient).not.toHaveProperty('email');
    expect(asPatient).not.toHaveProperty('phone');
    expect((await t.client().get('/doctors')).status).toBe(401);
  });

  it('shows the commission percentage only to admins and doctors', async () => {
    const ext = (c: Client) => c.get('/doctors').then((r) => r.body.data.find((d: { id: number }) => d.id === s.externalDoctorId));
    expect((await ext(admin)).commissionPercent).toBe(30);
    expect((await ext(doctor)).commissionPercent).toBe(30);
    expect(await ext(staff)).not.toHaveProperty('commissionPercent');
    expect(await ext(patient)).not.toHaveProperty('commissionPercent');
  });
});

describe('creating doctors', () => {
  it('lets an admin add an external doctor, but only with a commission percentage', async () => {
    const res = await admin.post('/doctors', newExternal());
    expect(res.status).toBe(201);
    expect(res.body.doctor).toMatchObject({ kind: 'external', commissionPercent: 25 });

    const missing = await admin.post('/doctors', newExternal({ commissionPercent: undefined }));
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body.error.details)).toContain('commission percentage is required');
    expect((await admin.post('/doctors', newExternal({ commissionPercent: '' }))).status).toBe(400);
    expect((await admin.post('/doctors', newExternal({ commissionPercent: null }))).status).toBe(400);
  });

  it('keeps the percentage between 0 and 100', async () => {
    expect((await admin.post('/doctors', newExternal({ commissionPercent: 0 }))).status).toBe(201);
    expect((await admin.post('/doctors', newExternal({ commissionPercent: 100 }))).status).toBe(201);
    expect((await admin.post('/doctors', newExternal({ commissionPercent: -1 }))).status).toBe(400);
    expect((await admin.post('/doctors', newExternal({ commissionPercent: 101 }))).status).toBe(400);
  });

  it('lets an owner doctor add an external doctor', async () => {
    const res = await doctor.post('/doctors', newExternal());
    expect(res.status).toBe(201);
    expect(res.body.doctor.kind).toBe('external');
  });

  it('defaults to external when no kind is given', async () => {
    const res = await doctor.post('/doctors', { fname: 'No', lname: 'Kind', commissionPercent: 20 });
    expect(res.body.doctor.kind).toBe('external');
  });

  it('lets only an admin add an owner doctor, who needs no percentage', async () => {
    const owner = { fname: 'Third', lname: 'Owner', kind: 'owner' };
    expect((await doctor.post('/doctors', owner)).status).toBe(403);
    const res = await admin.post('/doctors', owner);
    expect(res.status).toBe(201);
    expect(res.body.doctor).toMatchObject({ kind: 'owner', commissionPercent: null });
    // A percentage sent for an owner is ignored.
    expect((await admin.post('/doctors', { ...owner, lname: 'Again', commissionPercent: 50 })).body.doctor.commissionPercent).toBeNull();
  });

  it('refuses staff and patients', async () => {
    expect((await staff.post('/doctors', newExternal())).status).toBe(403);
    expect((await patient.post('/doctors', newExternal())).status).toBe(403);
  });

  it('validates', async () => {
    expect((await admin.post('/doctors', newExternal({ fname: '' }))).status).toBe(400);
    expect((await admin.post('/doctors', newExternal({ email: 'nope' }))).status).toBe(400);
    expect((await admin.post('/doctors', newExternal({ kind: 'visitor' }))).status).toBe(400);
  });
});

describe('editing doctors', () => {
  it('lets owner doctors and admins edit an external doctor', async () => {
    expect((await doctor.patch(`/doctors/${s.externalDoctorId}`, { speciality: 'Surgery' })).body.doctor.speciality).toBe('Surgery');
    expect((await admin.patch(`/doctors/${s.externalDoctorId}`, { commissionPercent: 35 })).body.doctor.commissionPercent).toBe(35);
    expect((await doctor.patch(`/doctors/${s.externalDoctorId}`, { commissionPercent: 20 })).body.doctor.commissionPercent).toBe(20);
  });

  it('lets only admins edit an owner doctor', async () => {
    expect((await doctor.patch(`/doctors/${s.saraId}`, { phone: '5' })).status).toBe(403);
    expect((await doctor.patch(`/doctors/${s.doctorId}`, { phone: '5' })).status).toBe(403);
    expect((await admin.patch(`/doctors/${s.saraId}`, { phone: '5' })).status).toBe(200);
  });

  it('stops an owner doctor from promoting anyone to owner', async () => {
    expect((await doctor.patch(`/doctors/${s.externalDoctorId}`, { kind: 'owner' })).status).toBe(403);
    expect((await admin.patch(`/doctors/${s.floatingDoctorId}`, { kind: 'owner' })).body.doctor).toMatchObject({ kind: 'owner', commissionPercent: null });
  });

  it('will not clear the percentage of an external doctor', async () => {
    const res = await admin.patch(`/doctors/${s.externalDoctorId}`, { commissionPercent: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('COMMISSION_REQUIRED');
  });

  it('requires a percentage when an owner becomes external', async () => {
    const owner = (await admin.post('/doctors', { fname: 'Temp', lname: 'Owner', kind: 'owner' })).body.doctor.id;
    expect((await admin.patch(`/doctors/${owner}`, { kind: 'external' })).body.error.code).toBe('COMMISSION_REQUIRED');
    expect((await admin.patch(`/doctors/${owner}`, { kind: 'external', commissionPercent: 15 })).body.doctor).toMatchObject({ kind: 'external', commissionPercent: 15 });
  });

  it('allows other edits to an external doctor whose percentage was never set (legacy)', async () => {
    await t.db('doctors').where({ id: s.externalDoctorId }).update({ commission_percent: null });
    const res = await doctor.patch(`/doctors/${s.externalDoctorId}`, { phone: '999' });
    expect(res.status).toBe(200);
    expect(res.body.doctor.commissionPercent).toBeNull();
  });

  it('will not turn an owner of a unit into an external doctor', async () => {
    const res = await admin.patch(`/doctors/${s.saraId}`, { kind: 'external', commissionPercent: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOCTOR_OWNS_UNITS');
  });

  it('refuses staff and patients, and validates', async () => {
    expect((await staff.patch(`/doctors/${s.externalDoctorId}`, { phone: '1' })).status).toBe(403);
    expect((await patient.patch(`/doctors/${s.externalDoctorId}`, { phone: '1' })).status).toBe(403);
    expect((await admin.patch(`/doctors/${s.externalDoctorId}`, {})).status).toBe(400);
    expect((await admin.patch('/doctors/99999', { phone: '1' })).status).toBe(404);
  });
});

describe('deleting doctors', () => {
  it('is for admins only', async () => {
    const id = (await admin.post('/doctors', newExternal())).body.doctor.id;
    for (const c of [doctor, staff, patient]) expect((await c.send('delete', `/doctors/${id}`)).status).toBe(403);
    expect((await admin.send('delete', `/doctors/${id}`)).status).toBe(204);
    expect((await admin.get(`/doctors/${id}`)).status).toBe(404);
  });

  it('refuses a doctor who has appointments or owns a unit', async () => {
    await t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: s.patientId, doctor_id: s.externalDoctorId, clinic_id: s.clinicId, unit_id: s.unitId });
    expect((await admin.send('delete', `/doctors/${s.externalDoctorId}`)).body.error.code).toBe('DOCTOR_IN_USE');
    expect((await admin.send('delete', `/doctors/${s.saraId}`)).body.error.code).toBe('DOCTOR_IN_USE');
  });

  it('keeps patients when their doctor is deleted', async () => {
    const id = (await admin.post('/doctors', newExternal())).body.doctor.id;
    await t.db('patients').where({ id: s.otherPatientId }).update({ doctor_id: id });
    expect((await admin.send('delete', `/doctors/${id}`)).status).toBe(204);
    expect((await t.db('patients').where({ id: s.otherPatientId }).first()).doctor_id).toBeNull();
  });
});

describe('clinics', () => {
  it('lets everyone signed in read, and only admins write', async () => {
    for (const c of [admin, doctor, staff, patient]) expect((await c.get('/clinics')).status).toBe(200);
    for (const c of [doctor, staff, patient]) expect((await c.post('/clinics', { name: 'X' })).status).toBe(403);

    const created = await admin.post('/clinics', { name: 'Second', address: 'Somewhere', phone: '' });
    expect(created.status).toBe(201);
    expect(created.body.clinic).toMatchObject({ name: 'Second', phone: null });
    const id = created.body.clinic.id;
    expect((await admin.patch(`/clinics/${id}`, { name: 'Renamed' })).body.clinic.name).toBe('Renamed');
    expect((await admin.send('delete', `/clinics/${id}`)).status).toBe(204);
  });

  it('validates', async () => {
    expect((await admin.post('/clinics', { name: '' })).status).toBe(400);
    expect((await admin.patch(`/clinics/${s.clinicId}`, {})).status).toBe(400);
    expect((await admin.get('/clinics/99999')).status).toBe(404);
  });
});

describe('who works at a clinic', () => {
  const put = (c: Client, doctorId: number, body: object = {}) => c.send('put', `/clinics/${s.clinicId}/doctors/${doctorId}`, body);

  it('lists doctors with their kind; the doctor’s share is for admins only', async () => {
    const asAdmin = (await admin.get(`/clinics/${s.clinicId}/doctors`)).body.data;
    expect(asAdmin).toHaveLength(3);
    expect(asAdmin.find((d: { doctorId: number }) => d.doctorId === s.externalDoctorId)).toMatchObject({ kind: 'external', drPart: 100 });
    for (const c of [doctor, staff, patient]) {
      const rows = (await c.get(`/clinics/${s.clinicId}/doctors`)).body.data;
      expect(rows[0]).not.toHaveProperty('drPart');
      expect(rows[0]).toHaveProperty('kind');
    }
  });

  it('assigns an external doctor without any schedule', async () => {
    const res = await put(admin, s.floatingDoctorId);
    expect(res.status).toBe(201);
    expect(res.body.link).toMatchObject({ doctorId: s.floatingDoctorId, kind: 'external', drPart: 100 });
    expect(res.body.link).not.toHaveProperty('schedule');
    expect(await t.db('dental_units').where({ owner_doctor_id: s.floatingDoctorId }).count({ n: '*' }).first()).toEqual({ n: 0 });
    expect((await put(admin, s.floatingDoctorId, { drPart: 80 })).status).toBe(200);
  });

  it('gives an owner doctor their dental unit on assignment, exactly once', async () => {
    const owner = (await admin.post('/doctors', { fname: 'Nour', lname: 'Owner', kind: 'owner' })).body.doctor.id;
    expect((await put(admin, owner)).status).toBe(201);
    expect((await put(admin, owner, { drPart: 90 })).status).toBe(200);
    const units = await t.db('dental_units').where({ owner_doctor_id: owner });
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe("Dr Nour's unit");
  });

  it('validates the share and the ids, and is admin-only', async () => {
    expect((await put(admin, s.floatingDoctorId, { drPart: 150 })).status).toBe(400);
    expect((await put(admin, s.floatingDoctorId, { drPart: -1 })).status).toBe(400);
    expect((await put(admin, 99999)).status).toBe(404);
    expect((await admin.send('put', '/clinics/99999/doctors/1', {})).status).toBe(404);
    for (const c of [doctor, staff, patient]) expect((await put(c, s.floatingDoctorId)).status).toBe(403);
  });

  it('blocks removing a doctor who still has upcoming appointments here', async () => {
    await t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: s.patientId, doctor_id: s.externalDoctorId, clinic_id: s.clinicId, unit_id: s.unitId });
    const res = await admin.send('delete', `/clinics/${s.clinicId}/doctors/${s.externalDoctorId}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HAS_UPCOMING');
  });

  it('removes an assignment when nothing is upcoming', async () => {
    await put(admin, s.floatingDoctorId);
    expect((await admin.send('delete', `/clinics/${s.clinicId}/doctors/${s.floatingDoctorId}`)).status).toBe(204);
    expect((await admin.send('delete', `/clinics/${s.clinicId}/doctors/${s.floatingDoctorId}`)).status).toBe(404);
  });
});

describe('dental units', () => {
  it('lists units with their owners, for clinic staff only', async () => {
    for (const c of [admin, doctor, staff]) {
      const rows = (await c.get(`/units?clinicId=${s.clinicId}`)).body.data;
      expect(rows.map((u: { name: string }) => u.name)).toEqual(["Dr Aya's unit", "Dr Sara's unit"]);
      expect(rows[0]).toMatchObject({ ownerDoctorId: s.doctorId, ownerName: 'Aya Ghali', clinicId: s.clinicId });
    }
    expect((await patient.get('/units')).status).toBe(403);
    expect((await t.client().get('/units')).status).toBe(401);
    expect((await admin.get('/units?clinicId=abc')).status).toBe(400);
  });

  it('can be renamed by an admin only', async () => {
    expect((await admin.patch(`/units/${s.unitId}`, { name: 'Room 1' })).body.unit).toMatchObject({ name: 'Room 1', ownerName: 'Aya Ghali' });
    for (const c of [doctor, staff]) expect((await c.patch(`/units/${s.unitId}`, { name: 'Hijack' })).status).toBe(403);
    expect((await admin.patch(`/units/${s.unitId}`, { name: '' })).status).toBe(400);
    expect((await admin.patch('/units/99999', { name: 'x' })).status).toBe(404);
    await admin.patch(`/units/${s.unitId}`, { name: "Dr Aya's unit" });
  });

  it('cannot be deleted while it has appointments', async () => {
    await t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId });
    expect((await admin.send('delete', `/units/${s.unitId}`)).body.error.code).toBe('UNIT_IN_USE');
    const [extra] = await t.db('dental_units').insert({ clinic_id: s.clinicId, owner_doctor_id: s.floatingDoctorId, name: 'Spare' });
    expect((await doctor.send('delete', `/units/${extra}`)).status).toBe(403);
    expect((await admin.send('delete', `/units/${extra}`)).status).toBe(204);
  });
});

describe('reference data and configuration', () => {
  it('serves teeth and categories to clinic staff only', async () => {
    for (const c of [admin, doctor, staff]) {
      expect((await c.get('/teeth')).body.data).toHaveLength(2);
      expect((await c.get('/categories')).body.data[0]).toEqual(expect.objectContaining({ name: 'Crown', priceMin: 10, priceMax: 20 }));
    }
    expect((await patient.get('/teeth')).status).toBe(403);
    expect((await t.client().get('/categories')).status).toBe(401);
  });

  it('exposes the appointment rules and today’s date at the clinic', async () => {
    const res = await patient.get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05',
    });
    expect(res.body).not.toHaveProperty('workingDays');
    expect((await t.client().get('/config')).status).toBe(401);
  });

  it('still answers unknown routes with 404 when signed out', async () => {
    expect((await t.client().get('/nope')).status).toBe(404);
  });
});

describe('creating dental units', () => {
  const create = (client: Client, body: object) => client.post('/units', body);
  const base = () => ({ clinicId: s.clinicId, ownerDoctorId: s.doctorId, name: 'Room 2' });

  it('lets an admin add a unit for an owner doctor, who may now have several', async () => {
    const res = await create(admin, base());
    expect(res.status).toBe(201);
    expect(res.body.unit).toMatchObject({ name: 'Room 2', clinicId: s.clinicId, ownerDoctorId: s.doctorId, ownerName: 'Aya Ghali' });
    expect(await t.db('dental_units').where({ owner_doctor_id: s.doctorId }).count({ n: '*' }).first()).toEqual({ n: 2 });
    expect((await create(admin, { ...base(), name: 'Room 3' })).status).toBe(201);
  });

  it('is for admins only', async () => {
    for (const c of [doctor, staff, patient]) expect((await create(c, base())).status).toBe(403);
    expect([401, 403]).toContain((await create(t.client(), base())).status);
  });

  it('only for an owner doctor who works at that clinic', async () => {
    expect((await create(admin, { ...base(), ownerDoctorId: s.externalDoctorId })).body.error.code).toBe('NOT_AN_OWNER');
    const third = (await admin.post('/doctors', { fname: 'Third', lname: 'Owner', kind: 'owner' })).body.doctor.id;
    expect((await create(admin, { ...base(), ownerDoctorId: third })).body.error.code).toBe('DOCTOR_NOT_AT_CLINIC');
    expect((await create(admin, { ...base(), ownerDoctorId: 99999 })).body.error.code).toBe('UNKNOWN_DOCTOR');
    expect((await create(admin, { ...base(), clinicId: 99999 })).body.error.code).toBe('UNKNOWN_CLINIC');
  });

  it('keeps names unique within a clinic, ignoring case, on create and on rename', async () => {
    expect((await create(admin, { ...base(), name: "dr aya's UNIT" })).body.error.code).toBe('NAME_TAKEN');
    const extra = (await create(admin, base())).body.unit.id;
    expect((await admin.patch(`/units/${extra}`, { name: "Dr Sara's unit" })).body.error.code).toBe('NAME_TAKEN');
    expect((await admin.patch(`/units/${extra}`, { name: 'Room 2' })).status).toBe(200); // its own name is fine
  });

  it('validates', async () => {
    expect((await create(admin, { ...base(), name: '' })).status).toBe(400);
    expect((await create(admin, { ...base(), name: undefined })).status).toBe(400);
    expect((await create(admin, { name: 'x' })).status).toBe(400);
  });

  it('can then be used for appointments and logged', async () => {
    const unit = (await create(admin, base())).body.unit.id;
    const res = await staff.post('/appointments', {
      patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: unit, date: TOMORROW, time: '10:00',
    });
    expect(res.status).toBe(201);
    expect(res.body.appointment.unit.name).toBe('Room 2');
    expect(await t.db('audit_log').where({ action: 'unit.create' })).toHaveLength(1);
  });
});
