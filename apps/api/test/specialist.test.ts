import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * External specialists (owner decision, 2026-10-01). Two cases, always:
 *   1. the patient belongs to him: full working access (book, edit, complete, report...);
 *   2. the patient belongs to an owner doctor and he treats them: he sees that appointment and
 *      writes its report, but cannot browse the patient's profile, history or data.
 */
let t: TestApp;
let s: Seed;
let admin: Client, staff: Client, patientLogin: Client;
let aya: Client; // owner doctor (unrestricted)
let ext: Client; // the external specialist under test
let ext2: Client; // another external specialist
let unlinked: Client; // a doctor login with no doctor profile

let extPatient: number; // belongs to `ext`
let ext2Patient: number; // belongs to the other specialist
let ext2DoctorId: number;

let own: number; // ext's patient, treated by ext (case 1)
let case2: number; // Aya's patient (Pat), treated by ext (case 2)
let ownByAya: number; // ext's patient, treated by Aya
let other: number; // Aya's patient, treated by Aya: nothing to do with ext
let ext2Visit: number; // the other specialist's patient

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
  const hash = bcrypt.hashSync(PASSWORD, 4);

  const login = async (email: string, doctorId: number | null) => {
    const [uid] = await t.db('users').insert({ name: email, email, role: 'doctor', password: hash, ...stamp });
    if (doctorId) await t.db('doctors').where({ id: doctorId }).update({ user_id: uid });
  };
  ext2DoctorId = (await t.db('doctors').insert({ fname: 'Second', lname: 'Specialist', kind: 'external', commission_percent: 20, ...stamp }))[0]!;
  await t.db('clinic_doctor').insert({ clinic_id: s.clinicId, doctor_id: ext2DoctorId, dr_part: 100, ...stamp });
  await login('ext@clinic.test', s.externalDoctorId);
  await login('ext2@clinic.test', ext2DoctorId);
  await login('nolink@clinic.test', null);

  [admin, staff, patientLogin, aya, ext, ext2, unlinked] = await Promise.all(
    ['admin@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'doctor@clinic.test', 'ext@clinic.test', 'ext2@clinic.test', 'nolink@clinic.test'].map((e) => loggedIn(t, e)),
  );

  extPatient = (await t.db('patients').insert({ patient_identifier: '200001', fname: 'Eli', lname: 'Extpatient', phone: '71000001', doctor_id: s.externalDoctorId, description: 'note', ...stamp }))[0]!;
  ext2Patient = (await t.db('patients').insert({ patient_identifier: '200002', fname: 'Zed', lname: 'Otherspecialist', phone: '71000002', doctor_id: ext2DoctorId, ...stamp }))[0]!;
});
afterAll(() => t.destroy());

const visit = (extra: Record<string, unknown>) =>
  t.db('appointments')
    .insert({ date: '2026-10-01', time: '10:00', duration_minutes: 30, status: 'confirmed', clinic_id: s.clinicId, unit_id: s.unitId, ...extra })
    .then(([id]) => id as number);

beforeEach(async () => {
  await t.db('medication_report').del();
  await t.db('report_tooth').del();
  await t.db('reports').del();
  await t.db('appointment_category').del();
  await t.db('appointment_tooth').del();
  await t.db('appointments').del();
  await t.db('patients').whereNotIn('id', [s.patientId, s.otherPatientId, extPatient, ext2Patient]).del();
  await t.db('patients').update({ deleted_at: null });
  await t.db('audit_log').del();

  own = await visit({ patient_id: extPatient, doctor_id: s.externalDoctorId, date: '2026-10-01', time: '09:00' });
  case2 = await visit({ patient_id: s.patientId, doctor_id: s.externalDoctorId, date: '2026-10-01', time: '11:00' });
  ownByAya = await visit({ patient_id: extPatient, doctor_id: s.doctorId, date: '2026-09-25', time: '10:00' });
  other = await visit({ patient_id: s.patientId, doctor_id: s.doctorId, date: '2026-10-02', time: '14:00' });
  ext2Visit = await visit({ patient_id: ext2Patient, doctor_id: ext2DoctorId, date: '2026-10-03', time: '12:00', unit_id: s.saraUnitId });
  // Olga belongs to nobody in particular.
  await visit({ patient_id: s.otherPatientId, doctor_id: s.doctorId, date: '2026-10-04', time: '16:00' });
});

const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);
const book = (c: Client, extra: object = {}) =>
  c.post('/appointments', { patientId: extPatient, doctorId: s.externalDoctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00', ...extra });

describe('the specialist signs in', () => {
  it('is told which doctor he is, and that he is external', async () => {
    expect((await ext.get('/auth/me')).body.user.doctor).toEqual({ id: s.externalDoctorId, kind: 'external' });
    expect((await aya.get('/auth/me')).body.user.doctor).toEqual({ id: s.doctorId, kind: 'owner' });
    expect((await unlinked.get('/auth/me')).body.user.doctor).toBeNull();
    for (const c of [admin, staff, patientLogin]) expect((await c.get('/auth/me')).body.user).not.toHaveProperty('doctor');
  });
});

describe('patients: only his own', () => {
  it('lists just the patients who belong to him', async () => {
    const res = await ext.get('/patients');
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: number }) => p.id)).toEqual([extPatient]);
    expect(res.body.meta.total).toBe(1);
  });

  it('cannot find another doctor’s patient by searching either', async () => {
    expect((await ext.get('/patients?q=70111111')).body.data).toEqual([]);
    expect((await ext.get('/patients?q=Olga')).body.data).toEqual([]);
    expect((await ext.get(`/patients?doctorId=${s.doctorId}`)).body.data).toEqual([]); // cannot widen the filter
    expect((await ext.get('/patients?q=Eli')).body.data).toHaveLength(1);
  });

  it('opens his own patient in full', async () => {
    const res = await ext.get(`/patients/${extPatient}`);
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ fname: 'Eli', phone: '71000001', description: 'note' });
  });

  it('cannot open the profile of a patient he treats for an owner doctor, nor anyone else’s', async () => {
    for (const id of [s.patientId, s.otherPatientId, ext2Patient, 99999]) {
      expect((await ext.get(`/patients/${id}`)).status).toBe(404);
    }
  });

  it('cannot reach that patient’s history, chart or appointments by any other door', async () => {
    for (const part of ['timeline', 'chart', 'appointments']) {
      expect((await ext.get(`/patients/${s.patientId}/${part}`)).status).toBe(404);
      expect((await ext.get(`/patients/${extPatient}/${part}`)).status).toBe(200);
    }
  });

  it('adds a patient as his own, whatever he asks for', async () => {
    const mine = await ext.post('/patients', { fname: 'New', lname: 'Mine', phone: '70999111' });
    expect(mine.status).toBe(201);
    expect(mine.body.patient.doctorId).toBe(s.externalDoctorId);
    expect((await ext.post('/patients', { fname: 'New', lname: 'Mine2', phone: '70999112', doctorId: s.externalDoctorId })).status).toBe(201);
    expect((await ext.post('/patients', { fname: 'Grab', lname: 'Theirs', phone: '70999113', doctorId: s.doctorId })).status).toBe(403);
  });

  it('edits his own patient but cannot change whose patient it is, or touch others', async () => {
    expect((await ext.patch(`/patients/${extPatient}`, { address: 'Beirut' })).body.patient.address).toBe('Beirut');
    expect((await ext.patch(`/patients/${extPatient}`, { doctorId: s.doctorId })).status).toBe(403);
    expect((await ext.patch(`/patients/${s.patientId}`, { address: 'Hijack' })).status).toBe(404);
    // He may soft delete only patients he can see: not another doctor's, not the owner's patient he merely treats.
    expect((await ext.send('delete', `/patients/${s.patientId}`)).status).toBe(404);
    expect((await ext.send('delete', `/patients/${ext2Patient}`)).status).toBe(404);
    expect((await ext.send('delete', `/patients/${extPatient}`)).status).toBe(204);
    await t.db('patients').where({ id: extPatient }).update({ deleted_at: null, deleted_by: null });
  });

  it('is unchanged for owner doctors, staff and admins, who still see everyone', async () => {
    for (const c of [aya, staff, admin]) {
      const all = (await c.get('/patients')).body.data.map((p: { id: number }) => p.id);
      expect(all).toEqual(expect.arrayContaining([s.patientId, s.otherPatientId, extPatient, ext2Patient]));
    }
    expect((await aya.get(`/patients/${extPatient}`)).status).toBe(200);
  });
});

describe('appointments: his, in two cases', () => {
  it('lists those he treats and those of his own patients, nothing else', async () => {
    const res = await ext.get('/appointments?pageSize=100');
    expect(ids(res.body.data)).toEqual([own, case2, ownByAya].sort((a, b) => a - b));
    expect(res.body.meta.total).toBe(3);
  });

  it('shows him another doctor’s patient only as a name, with no way to open the patient', async () => {
    const list = (await ext.get('/appointments?pageSize=100')).body.data;
    const byId = Object.fromEntries(list.map((a: { id: number }) => [a.id, a]));
    expect(byId[case2]).toMatchObject({ patientVisible: false, patient: { fname: 'Pat', lname: 'Patient' } });
    expect(byId[case2].patient).not.toHaveProperty('phone');
    expect(byId[own]).toMatchObject({ patientVisible: true, patient: { fname: 'Eli', phone: '71000001' } });
    expect(byId[ownByAya].patientVisible).toBe(true); // his own patient, even though Aya treated
  });

  it('opens an appointment he is involved in and no other', async () => {
    expect((await ext.get(`/appointments/${case2}`)).status).toBe(200);
    expect((await ext.get(`/appointments/${own}`)).status).toBe(200);
    expect((await ext.get(`/appointments/${ownByAya}`)).status).toBe(200);
    for (const id of [other, ext2Visit]) expect((await ext.get(`/appointments/${id}`)).status).toBe(404);
  });

  it('cannot widen the list with filters', async () => {
    expect((await ext.get(`/appointments?patientId=${s.otherPatientId}`)).body.data).toEqual([]);
    expect((await ext.get(`/appointments?doctorId=${s.doctorId}`)).body.data.map((a: { id: number }) => a.id)).toEqual([ownByAya]);
    expect((await ext.get('/appointments?q=Olga')).body.data).toEqual([]);
  });

  it('is unchanged for everyone else', async () => {
    for (const c of [aya, staff, admin]) expect((await c.get('/appointments?pageSize=100')).body.meta.total).toBe(6);
    expect((await aya.get(`/appointments/${other}`)).body.appointment.patientVisible).toBe(true);
  });

  it('hides who else is in the schedule when he checks a time', async () => {
    const q = (c: Client) => c.get(`/appointments/busy?doctorId=${s.doctorId}&unitId=${s.unitId}&date=2026-10-02`).then((r) => r.body.doctorBusy);
    expect((await q(ext))[0]).toMatchObject({ start: '14:00', patientName: 'Another patient' }); // Aya's visit with Pat: not his
    expect((await q(staff))[0].patientName).toBe('Pat Patient');
    const mine = (await ext.get(`/appointments/busy?doctorId=${s.externalDoctorId}&unitId=${s.unitId}&date=2026-10-01`)).body.doctorBusy;
    expect(mine.map((p: { patientName: string }) => p.patientName)).toEqual(['Eli Extpatient', 'Pat Patient']); // his own and the one he treats
  });
});

describe('case 1: his own patient, full working access', () => {
  it('books appointments for them, with himself as the doctor', async () => {
    const res = await book(ext);
    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({ doctorId: s.externalDoctorId, patientVisible: true, patient: { phone: '71000001' } });
  });

  it('cannot book them with another doctor, nor book another doctor’s patient', async () => {
    expect((await book(ext, { doctorId: s.doctorId })).status).toBe(403);
    // Another doctor's patient looks exactly like a patient that does not exist.
    expect((await book(ext, { patientId: s.patientId })).body.error.code).toBe('UNKNOWN_PATIENT');
    expect((await book(ext, { patientId: ext2Patient })).body.error.code).toBe('UNKNOWN_PATIENT');
    expect((await book(ext, { patientId: 99999 })).body.error.code).toBe('UNKNOWN_PATIENT');
  });

  it('reschedules, confirms, cancels and completes his own appointments', async () => {
    const id = (await book(ext, { status: 'pending', time: '15:00' })).body.appointment.id;
    expect((await ext.patch(`/appointments/${id}`, { time: '15:30', intended: 'Moved' })).body.appointment.time).toBe('15:30');
    expect((await ext.post(`/appointments/${id}/confirm`)).body.appointment.status).toBe('confirmed');
    expect((await ext.post(`/appointments/${id}/cancel`)).body.appointment.status).toBe('cancelled');
    expect((await ext.post(`/appointments/${own}/complete`)).body.appointment.status).toBe('completed');
  });

  it('cannot move his own appointment onto another doctor', async () => {
    expect((await ext.patch(`/appointments/${own}`, { doctorId: s.doctorId })).status).toBe(403);
  });

  it('sets procedures and teeth', async () => {
    expect((await ext.send('put', `/appointments/${own}/categories`, { categoryIds: [s.categoryIds[0]] })).status).toBe(200);
    expect((await ext.send('put', `/appointments/${own}/teeth`, { teeth: [{ toothId: s.toothIds[0] }] })).status).toBe(200);
  });

  it('writes the report, and reads the one for a visit of his patient that someone else treated', async () => {
    expect((await ext.send('put', `/appointments/${own}/report`, { summary: 'Done' })).body.canEdit).toBe(true);
    // Aya treated his patient: he reads it (his patient), but only the treating doctor and admin edit.
    await aya.send('put', `/appointments/${ownByAya}/report`, { summary: 'By Aya' });
    const res = await ext.get(`/appointments/${ownByAya}/report`);
    expect(res.body).toMatchObject({ canEdit: false, report: { summary: 'By Aya' } });
    expect((await ext.send('put', `/appointments/${ownByAya}/report`, { summary: 'No' })).status).toBe(403);
  });

  it('sees his patient’s whole history with the reports he may read', async () => {
    await ext.send('put', `/appointments/${own}/report`, { summary: 'Mine' });
    await aya.send('put', `/appointments/${ownByAya}/report`, { summary: 'By Aya' });
    const entries = (await ext.get(`/patients/${extPatient}/timeline`)).body.data;
    expect(entries).toHaveLength(2);
    expect(entries.map((e: { report: { summary: string } }) => e.report.summary).sort()).toEqual(['By Aya', 'Mine']);
  });
});

describe('case 2: an owner doctor’s patient — the appointment and the report, nothing more', () => {
  it('writes and reads the report of the visit he treats', async () => {
    const res = await ext.send('put', `/appointments/${case2}/report`, { summary: 'Extraction of 38' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canEdit: true, report: { summary: 'Extraction of 38' } });
    expect((await ext.get(`/appointments/${case2}/report`)).body.report.summary).toBe('Extraction of 38');
    expect((await ext.send('put', `/appointments/${case2}/report/medications`, { medications: [] }, )).status).toBe(200);
  });

  it('can download the visit summary he wrote', async () => {
    await ext.send('put', `/appointments/${case2}/report`, { summary: 'Extraction of 38' });
    const res = await ext.agent.get(`/api/v1/appointments/${case2}/report/pdf`);
    expect(res.status).toBe(200);
  });

  it('cannot change the appointment in any way', async () => {
    expect((await ext.patch(`/appointments/${case2}`, { time: '12:00' })).status).toBe(403);
    for (const action of ['confirm', 'cancel', 'complete', 'no-show']) {
      expect((await ext.post(`/appointments/${case2}/${action}`)).status).toBe(403);
    }
    expect((await ext.send('put', `/appointments/${case2}/categories`, { categoryIds: [] })).status).toBe(403);
    expect((await ext.send('put', `/appointments/${case2}/teeth`, { teeth: [] })).status).toBe(403);
    expect((await t.db('appointments').where({ id: case2 }).first()).status).toBe('confirmed');
  });

  it('cannot open the patient behind it, however he asks', async () => {
    expect((await ext.get(`/patients/${s.patientId}`)).status).toBe(404);
    expect((await ext.get(`/patients/${s.patientId}/timeline`)).status).toBe(404);
    expect((await ext.get(`/patients/${s.patientId}/chart`)).status).toBe(404);
    expect((await ext.get(`/patients/${s.patientId}/appointments`)).status).toBe(404);
    expect((await ext.get('/patients?q=70111111')).body.data).toEqual([]);
    expect((await ext.send('put', `/appointments/${case2}/report/teeth`, { teeth: [] })).status).toBe(200); // the report is his
  });

  it('cannot read or write reports of visits that are not his and not his patients’', async () => {
    await aya.send('put', `/appointments/${other}/report`, { summary: 'Aya only' });
    expect((await ext.get(`/appointments/${other}/report`)).status).toBe(404);
    expect((await ext.send('put', `/appointments/${other}/report`, { summary: 'x' })).status).toBe(404);
    expect((await ext.get(`/appointments/${ext2Visit}/report`)).status).toBe(404);
  });

  it('is the same the other way round: the owner doctor reads his specialist’s report', async () => {
    await ext.send('put', `/appointments/${case2}/report`, { summary: 'Extraction of 38' });
    expect((await aya.get(`/appointments/${case2}/report`)).body.report.summary).toBe('Extraction of 38'); // Aya is Pat's primary doctor
    expect((await ext2.get(`/appointments/${case2}/report`)).status).toBe(404);
  });
});

describe('two specialists are kept apart', () => {
  it('each sees only his own world', async () => {
    expect(ids((await ext2.get('/appointments?pageSize=100')).body.data)).toEqual([ext2Visit]);
    expect((await ext2.get('/patients')).body.data.map((p: { id: number }) => p.id)).toEqual([ext2Patient]);
    expect((await ext2.get(`/patients/${extPatient}`)).status).toBe(404);
    expect((await ext2.get(`/appointments/${own}`)).status).toBe(404);
    expect((await ext2.post(`/appointments/${own}/cancel`)).status).toBe(404);
  });
});

describe('what else a specialist cannot do', () => {
  it('sees other doctors’ commission percentages? No: only his own', async () => {
    const doctors = (await ext.get('/doctors')).body.data as { id: number; commissionPercent?: number | null }[];
    const mine = doctors.find((d) => d.id === s.externalDoctorId)!;
    expect(mine.commissionPercent).toBe(30);
    for (const d of doctors.filter((x) => x.id !== s.externalDoctorId)) expect(d).not.toHaveProperty('commissionPercent');
    const asAya = (await aya.get('/doctors')).body.data as { id: number; commissionPercent?: number | null }[];
    expect(asAya.find((d) => d.id === ext2DoctorId)!.commissionPercent).toBe(20); // an owner doctor still sees all
    expect((await admin.get('/doctors')).body.data.every((d: object) => 'commissionPercent' in d)).toBe(true);
  });

  it('cannot add, edit or delete doctors, not even himself', async () => {
    expect((await ext.post('/doctors', { fname: 'A', lname: 'B', kind: 'external', commissionPercent: 10 })).status).toBe(403);
    expect((await ext.patch(`/doctors/${s.externalDoctorId}`, { commissionPercent: 0 })).status).toBe(403);
    expect((await ext.patch(`/doctors/${ext2DoctorId}`, { phone: '1' })).status).toBe(403);
    expect((await ext.send('delete', `/doctors/${ext2DoctorId}`)).status).toBe(403);
  });

  it('still prescribes: the medication list and reports work for him', async () => {
    expect((await ext.get('/medications')).status).toBe(200);
  });
});

describe('a doctor login that is not linked to a doctor profile', () => {
  it('sees nothing and can create nothing (the app cannot tell who it is)', async () => {
    expect((await unlinked.get('/patients')).body.data).toEqual([]);
    expect((await unlinked.get('/appointments')).body.data).toEqual([]);
    expect((await unlinked.get(`/appointments/${own}`)).status).toBe(404);
    expect((await unlinked.get(`/patients/${extPatient}`)).status).toBe(404);
    expect((await unlinked.post('/patients', { fname: 'A', lname: 'B', phone: '12345' })).status).toBe(403);
    expect((await book(unlinked)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the audit trail', () => {
  it('records what a specialist books, under his login', async () => {
    const res = await book(ext, { time: '17:00' });
    const log = await t.db('audit_log').where({ action: 'appointment.create', entity_id: String(res.body.appointment.id) });
    expect(log).toHaveLength(1);
  });
});
