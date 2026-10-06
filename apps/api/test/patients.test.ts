import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

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
  await t.db('appointments').del();
  await t.db('patients').whereNotIn('id', [s.patientId, s.otherPatientId]).del();
  await t.db('patients').update({ deleted_at: null });
  await t.db('audit_log').del();
});

// Every new patient needs a primary doctor.
const valid = { fname: 'Maya', lname: 'Haddad', phone: '+961 70 333 444', doctorId: 1 /* Dr Aya, the first doctor seeded */ };

describe('creating patients', () => {
  it.each([['doctor'], ['staff'], ['admin']])('lets %s create a patient', async (who) => {
    const c = { doctor, staff, admin }[who as 'doctor']!;
    const res = await c.post('/patients', { ...valid, lname: `Haddad-${who}` });
    expect(res.status).toBe(201);
    expect(res.body.patient).toMatchObject({ fname: 'Maya', phone: '+961 70 333 444', hasAccount: false });
    expect(res.body.patient.patientIdentifier).toMatch(/^\d{6}$/);
  });

  it('forbids patients and anonymous callers', async () => {
    expect((await patient.post('/patients', valid)).status).toBe(403);
    // Signed out: stopped at the CSRF check (403) or authentication (401); never allowed.
    expect([401, 403]).toContain((await t.client().post('/patients', valid)).status);
  });

  it('normalises input: trims, lowercases email, turns empty strings into null', async () => {
    const res = await staff.post('/patients', { fname: '  Maya ', lname: 'Haddad', phone: '70333444', doctorId: s.doctorId, email: ' Maya@Example.COM ', address: '', gender: '', dateOfBirth: '' });
    expect(res.status).toBe(201);
    expect(res.body.patient).toMatchObject({ fname: 'Maya', email: 'maya@example.com', address: null, gender: null, dateOfBirth: null });
  });

  it('needs a primary doctor, and says so', async () => {
    const res = await staff.post('/patients', { fname: 'No', lname: 'Doctor', phone: '70123456' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DOCTOR_REQUIRED');
    expect((await staff.post('/patients', { fname: 'No', lname: 'Doctor', phone: '70123456', doctorId: null })).body.error.code).toBe('DOCTOR_REQUIRED');
    expect(await t.db('patients').where({ fname: 'No', lname: 'Doctor' }).first()).toBeUndefined();
  });

  it.each([
    ['missing first name', { ...valid, fname: '' }],
    ['missing phone', { ...valid, phone: '' }],
    ['letters in phone', { ...valid, phone: 'call me' }],
    ['bad email', { ...valid, email: 'nope' }],
    ['bad gender', { ...valid, gender: 'robot' }],
    ['impossible date', { ...valid, dateOfBirth: '2020-02-31' }],
    ['future birth date', { ...valid, dateOfBirth: '2030-01-01' }],
    ['ancient birth date', { ...valid, dateOfBirth: '1850-01-01' }],
    ['unknown doctor', { ...valid, doctorId: 99999 }],
    ['name too long', { ...valid, fname: 'x'.repeat(101) }],
  ])('rejects %s', async (_label, body) => {
    const res = await staff.post('/patients', body);
    expect(res.status).toBe(400);
  });

  it('ignores fields the client has no business setting', async () => {
    const res = await staff.post('/patients', { ...valid, patientIdentifier: '000001', userId: 1, deletedAt: 'x', id: 9999 });
    expect(res.status).toBe(201);
    expect(res.body.patient.patientIdentifier).not.toBe('000001');
    expect(res.body.patient.id).not.toBe(9999);
    expect(res.body.patient.hasAccount).toBe(false);
  });

  it('warns about an exact duplicate but allows it when confirmed', async () => {
    const first = await staff.post('/patients', valid);
    const dup = await staff.post('/patients', { ...valid, fname: 'MAYA' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'DUPLICATE_PATIENT', details: { existingId: first.body.patient.id } });
    expect((await staff.post('/patients?allowDuplicate=true', valid)).status).toBe(201);
    // Family members sharing a phone number are fine.
    expect((await staff.post('/patients', { ...valid, fname: 'Karim' })).status).toBe(201);
  });

  it('generates distinct identifiers', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 15; i++) ids.add((await staff.post('/patients', { ...valid, lname: `L${i}` })).body.patient.patientIdentifier);
    expect(ids.size).toBe(15);
  });

  it('logs the action without logging health data', async () => {
    await staff.post('/patients', { ...valid, description: 'Penicillin allergy' });
    const log = JSON.stringify(await t.db('audit_log').where({ action: 'patient.create' }));
    expect(log).toContain('patient.create');
    expect(log).not.toContain('Penicillin');
    expect(log).not.toContain('Maya');
  });
});

describe('listing and searching', () => {
  beforeEach(async () => {
    for (const [fname, lname, phone] of [['Hicham', 'Cheaib', '03039198'], ['Tarek', 'Moabbi', '03726558'], ['Hiba', 'Ghali', '70999888'], ['Rima', 'Madani', '71000111']]) {
      await staff.post('/patients', { fname, lname, phone, doctorId: s.doctorId });
    }
  });

  it('returns a page with totals', async () => {
    const res = await staff.get('/patients?pageSize=3&page=2');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 2, pageSize: 3, total: 6 });
    expect(res.body.data).toHaveLength(3);
  });

  it('sorts by name by default', async () => {
    const names = (await staff.get('/patients')).body.data.map((p: { lname: string }) => p.lname);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it.each([
    ['hicham', ['Cheaib']],
    ['CHEAIB', ['Cheaib']],
    ['hicham cheaib', ['Cheaib']],
    ['cheaib hicham', ['Cheaib']],
    ['hi', ['Cheaib', 'Ghali']],
    ['0372', ['Moabbi']],
    ['100001', ['Patient']],
    ['hicham ghali', []],
    ['nobody', []],
  ])('searches %j', async (q, lastNames) => {
    const res = await staff.get(`/patients?q=${encodeURIComponent(q)}`);
    expect(res.body.data.map((p: { lname: string }) => p.lname).sort()).toEqual(lastNames);
  });

  it('treats wildcards and quotes in the search as plain text', async () => {
    for (const q of ['%', '_', "' OR 1=1 --", '!%', '\\']) {
      const res = await staff.get(`/patients?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    }
  });

  it('filters by doctor and validates the query', async () => {
    // The patients made in this block belong to Aya, like the seeded one; nobody belongs to Sara.
    expect((await staff.get(`/patients?doctorId=${s.doctorId}`)).body.data.map((p: { lname: string }) => p.lname).sort()).toEqual(['Cheaib', 'Ghali', 'Madani', 'Moabbi', 'Patient']);
    expect((await staff.get(`/patients?doctorId=${s.saraId}`)).body.data).toEqual([]);
    expect((await staff.get('/patients?pageSize=1000')).status).toBe(400);
    expect((await staff.get('/patients?sort=password')).status).toBe(400);
  });

  it('hides patients from patient accounts', async () => {
    expect((await patient.get('/patients')).status).toBe(403);
  });

  it('never lists soft-deleted patients', async () => {
    const id = (await staff.get('/patients?q=hicham')).body.data[0].id;
    await admin.send('delete', `/patients/${id}`);
    expect((await staff.get('/patients?q=hicham')).body.data).toHaveLength(0);
  });
});

describe('reading one patient', () => {
  it('shows staff everything, including internal notes', async () => {
    const res = await staff.get(`/patients/${s.patientId}`);
    expect(res.status).toBe(200);
    expect(res.body.patient.description).toBe('secret note');
  });

  it('shows a patient their own record without internal notes', async () => {
    const res = await patient.get(`/patients/${s.patientId}`);
    expect(res.status).toBe(200);
    expect(res.body.patient).not.toHaveProperty('description');
    const me = await patient.get('/patients/me');
    expect(me.body.patient.id).toBe(s.patientId);
    expect(me.body.patient).not.toHaveProperty('description');
  });

  it("does not reveal other people's records (404, not 403)", async () => {
    expect((await patient.get(`/patients/${s.otherPatientId}`)).status).toBe(404);
    expect((await patient.get(`/patients/${s.otherPatientId}/appointments`)).status).toBe(404);
  });

  it('returns 404 for unknown and 400 for malformed ids', async () => {
    expect((await staff.get('/patients/99999')).status).toBe(404);
    expect((await staff.get('/patients/abc')).status).toBe(400);
    expect((await staff.get('/patients/-1')).status).toBe(400);
  });

  it('gives staff accounts no /me', async () => {
    expect((await staff.get('/patients/me')).status).toBe(403);
  });
});

describe('updating patients', () => {
  it('changes only the supplied fields', async () => {
    const res = await staff.patch(`/patients/${s.otherPatientId}`, { phone: '71555666', address: 'Beirut' });
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ phone: '71555666', address: 'Beirut', fname: 'Olga', lname: 'Other' });
  });

  it('can clear optional fields', async () => {
    await staff.patch(`/patients/${s.otherPatientId}`, { address: 'Beirut' });
    const res = await staff.patch(`/patients/${s.otherPatientId}`, { address: '' });
    expect(res.body.patient.address).toBeNull();
  });

  it('validates and rejects empty updates and unknown patients', async () => {
    expect((await staff.patch(`/patients/${s.otherPatientId}`, {})).status).toBe(400);
    expect((await staff.patch(`/patients/${s.otherPatientId}`, { phone: 'abc' })).status).toBe(400);
    expect((await staff.patch('/patients/99999', { phone: '70111222' })).status).toBe(404);
  });

  it("won't let a patient edit, even their own record", async () => {
    expect((await patient.patch(`/patients/${s.patientId}`, { phone: '70000000' })).status).toBe(403);
  });

  it('logs which fields changed, not their values', async () => {
    await staff.patch(`/patients/${s.otherPatientId}`, { address: 'Secret Street 5' });
    const log = JSON.stringify(await t.db('audit_log').where({ action: 'patient.update' }));
    expect(log).toContain('address');
    expect(log).not.toContain('Secret Street');
  });
});

describe('deleting patients', () => {
  it('lets staff, doctors and admins soft delete, never a patient, and keeps the data', async () => {
    expect((await patient.send('delete', `/patients/${s.otherPatientId}`)).status).toBe(403);
    expect((await t.client().send('delete', `/patients/${s.otherPatientId}`, undefined, false)).status).toBeGreaterThanOrEqual(401);
    expect((await staff.send('delete', `/patients/${s.otherPatientId}`)).status).toBe(204);

    const row = await t.db('patients').where({ id: s.otherPatientId }).first();
    expect(row.deleted_at).toBeTruthy();
    expect(row.deleted_by).toBe((await t.db('users').where({ email: 'staff@clinic.test' }).first('id')).id);
    expect((await staff.get(`/patients/${s.otherPatientId}`)).status).toBe(404);
    expect((await admin.send('delete', `/patients/${s.otherPatientId}`)).status).toBe(404);
    expect((await doctor.send('delete', `/patients/${s.otherPatientId}`)).status).toBe(404);
  });

  it('lets a doctor soft delete too', async () => {
    expect((await doctor.send('delete', `/patients/${s.otherPatientId}`)).status).toBe(204);
    expect((await t.db('patients').where({ id: s.otherPatientId }).first()).deleted_at).toBeTruthy();
  });

  it('hides the appointments of a deleted patient from the schedule', async () => {
    await t.db('appointments').insert({ date: '2026-10-06', time: '10:00', status: 'confirmed', patient_id: s.otherPatientId, doctor_id: s.doctorId, clinic_id: s.clinicId });
    expect((await staff.get('/appointments')).body.data).toHaveLength(1);
    await admin.send('delete', `/patients/${s.otherPatientId}`);
    expect((await staff.get('/appointments')).body.data).toHaveLength(0);
  });
});

describe('a patient’s appointments', () => {
  it('lists them newest first for staff and for the owner', async () => {
    await t.db('appointments').insert([
      { date: '2026-10-06', time: '10:00', status: 'confirmed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId },
      { date: '2026-11-01', time: '11:00', status: 'pending', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId },
      { date: '2026-10-07', time: '10:00', status: 'confirmed', patient_id: s.otherPatientId, doctor_id: s.doctorId, clinic_id: s.clinicId },
    ]);
    const asStaff = await staff.get(`/patients/${s.patientId}/appointments`);
    expect(asStaff.body.data.map((a: { date: string }) => a.date)).toEqual(['2026-11-01', '2026-10-06']);
    expect(asStaff.body.data[0].patient.phone).toBeDefined();
    const asOwner = await patient.get(`/patients/${s.patientId}/appointments`);
    expect(asOwner.body.data).toHaveLength(2);
    expect(asOwner.body.data[0].patient.phone).toBeUndefined();
  });
});
