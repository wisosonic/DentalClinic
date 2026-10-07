import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

let t: TestApp;
let s: Seed;
let admin: Client, doctor: Client, staff: Client, patient: Client;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  savedPatient = await t.db('patients').where({ id: s.patientId }).first();
  savedLogin = await t.db('users').where({ id: s.patientUserId }).first();
  [admin, doctor, staff, patient] = await Promise.all(
    ['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)),
  );
});
afterAll(() => t.destroy());

let apptId: number;
let reportId: number;
let offerId: number;
let savedPatient: Record<string, unknown>;
let savedLogin: Record<string, unknown>;

/** A patient with a visit, a report with a tooth note and a prescription, a quote and a payment. */
beforeEach(async () => {
  // An earlier test may have erased the patient for good: put them back.
  if (!(await t.db('users').where({ id: s.patientUserId }).first())) await t.db('users').insert(savedLogin);
  if (!(await t.db('patients').where({ id: s.patientId }).first())) await t.db('patients').insert(savedPatient);
  for (const table of ['medication_report', 'report_tooth', 'reports', 'payments', 'treatment_offers', 'appointment_category', 'appointment_tooth', 'appointments', 'audit_log']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
  apptId = (await t.db('appointments').insert({
    date: TOMORROW, time: '10:00', status: 'completed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp,
  }))[0]!;
  await t.db('appointment_category').insert({ appointment_id: apptId, category_id: s.categoryIds[0], ...stamp });
  reportId = (await t.db('reports').insert({ appointment_id: apptId, summary: 'Top secret summary', ...stamp }))[0]!;
  await t.db('report_tooth').insert({ report_id: reportId, tooth_id: s.toothIds[0], date: TOMORROW, occlusal: 'Secret cavity', ...stamp });
  const med = (await t.db('medications').insert({ name: 'Amoxicillin', ...stamp }))[0]!;
  await t.db('medication_report').insert({ report_id: reportId, medication_id: med, dose: '500 mg', frequency: 3, time_unit: 'day', ...stamp });
  offerId = (await t.db('treatment_offers').insert({ title: 'Crown', type: 'treatment', price: 100, cost: 40, currency: '$', status: 'accepted', patient_id: s.patientId, ...stamp }))[0]!;
  await t.db('payments').insert({ date: TODAY, type: 'clinic', amount: 50, remaining: 50, currency: '$', offer_id: offerId, ...stamp });
});

const count = async (table: string) => Number((await t.db(table).count({ n: '*' }).first())!.n);
const del = (c: Client, url: string) => c.send('delete', url);
const purge = (c: Client, kind: string, id: number, confirm: string) => c.agent.delete(`/api/v1/trash/${kind}/${id}`).set('x-csrf-token', c.csrf).send({ confirm });

describe('soft delete by staff and doctors', () => {
  it('lets staff and doctors delete an appointment, which then leaves the schedule and frees its time', async () => {
    expect((await del(staff, `/appointments/${apptId}`)).status).toBe(204);
    expect((await admin.get('/appointments')).body.data).toHaveLength(0);
    expect((await admin.get(`/appointments/${apptId}`)).status).toBe(404);
    const row = await t.db('appointments').where({ id: apptId }).first();
    expect(row.deleted_at).toBeTruthy();
    expect(row.deleted_by).toBeTruthy();
    // The same doctor, unit and time can be booked again.
    const rebook = await doctor.post('/appointments', { patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00', durationMinutes: 30 });
    expect(rebook.status).toBe(201);
    expect((await del(doctor, `/appointments/${rebook.body.appointment.id}`)).status).toBe(204);
  });

  it('never lets a patient delete, and 404s on something already deleted', async () => {
    expect((await del(patient, `/appointments/${apptId}`)).status).toBe(403);
    expect((await del(patient, `/appointments/${apptId}/report`)).status).toBe(403);
    await del(staff, `/appointments/${apptId}`);
    expect((await del(staff, `/appointments/${apptId}`)).status).toBe(404);
  });

  it('lets staff and doctors delete a report, which then disappears from the appointment, timeline, chart and flag', async () => {
    expect((await del(staff, `/appointments/${apptId}/report`)).status).toBe(204);
    expect((await admin.get(`/appointments/${apptId}/report`)).body.report).toBeNull();
    expect((await admin.get(`/appointments/${apptId}`)).body.appointment.hasReport).toBe(false);
    expect((await admin.get(`/patients/${s.patientId}/chart`)).body.data).toEqual([]);
    const timeline = (await admin.get(`/patients/${s.patientId}/timeline`)).body.data;
    expect(timeline[0].hasReport).toBe(false);
    expect((await del(doctor, `/appointments/${apptId}/report`)).status).toBe(404);
  });

  it('does not let a new report be written over a deleted one: it must be restored or erased first', async () => {
    await del(staff, `/appointments/${apptId}/report`);
    const res = await doctor.agent.put(`/api/v1/appointments/${apptId}/report`).set('x-csrf-token', doctor.csrf).send({ summary: 'again' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPORT_IN_TRASH');
  });

  it('hides a deleted patient with their visits', async () => {
    expect((await del(staff, `/patients/${s.patientId}`)).status).toBe(204);
    expect((await admin.get('/appointments')).body.data).toHaveLength(0);
    expect((await admin.get(`/patients/${s.patientId}`)).status).toBe(404);
  });

  it('records each deletion in the audit log without content', async () => {
    await del(staff, `/appointments/${apptId}/report`);
    await del(staff, `/appointments/${apptId}`);
    const actions = (await t.db('audit_log').pluck('action')) as string[];
    expect(actions).toEqual(expect.arrayContaining(['report.delete', 'appointment.delete']));
    expect(JSON.stringify(await t.db('audit_log'))).not.toContain('secret');
  });
});

describe('the Trash is the admin’s alone', () => {
  it('is closed to everyone else', async () => {
    await del(staff, `/appointments/${apptId}`);
    for (const c of [doctor, staff, patient]) {
      expect((await c.get('/trash')).status).toBe(403);
      expect((await c.post(`/trash/appointment/${apptId}/restore`)).status).toBe(403);
      expect((await purge(c, 'appointment', apptId, 'Pat Patient')).status).toBe(403);
    }
    expect(await count('appointments')).toBe(1);
  });

  it('lists what was deleted, with who deleted it, and can be filtered, searched and sorted', async () => {
    await del(staff, `/appointments/${apptId}/report`);
    await del(doctor, `/patients/${s.otherPatientId}`);
    const all = (await admin.get('/trash')).body;
    expect(all.meta.total).toBe(2);
    expect(all.data.map((i: { kind: string }) => i.kind).sort()).toEqual(['patient', 'report']);
    const report = all.data.find((i: { kind: string }) => i.kind === 'report');
    expect(report).toMatchObject({ label: 'Pat Patient', confirmText: 'Pat Patient', deletedBy: 'Sam Staff' });
    expect((await admin.get('/trash?kind=patient')).body.data).toHaveLength(1);
    expect((await admin.get('/trash?q=olga')).body.data).toHaveLength(1);
    expect((await admin.get('/trash?sort=label&order=asc')).body.data[0].label).toBe('Olga Other');
    expect((await admin.get('/trash?sort=password')).status).toBe(400);
  });
});

describe('restoring', () => {
  it('brings an appointment back', async () => {
    await del(staff, `/appointments/${apptId}`);
    expect((await admin.post(`/trash/appointment/${apptId}/restore`)).status).toBe(204);
    expect((await admin.get(`/appointments/${apptId}`)).status).toBe(200);
    expect((await admin.get('/trash')).body.meta.total).toBe(0);
    expect((await t.db('audit_log').where({ action: 'trash.restore' }).first())).toBeTruthy();
  });

  it('refuses to restore an appointment whose time was taken in the meantime', async () => {
    await del(staff, `/appointments/${apptId}`);
    await doctor.post('/appointments', { patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00', durationMinutes: 30 });
    const res = await admin.post(`/trash/appointment/${apptId}/restore`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOCTOR_BUSY');
  });

  it('restores a report, and needs its appointment and patient restored first', async () => {
    await del(staff, `/appointments/${apptId}/report`);
    await del(staff, `/appointments/${apptId}`);
    expect((await admin.post(`/trash/report/${reportId}/restore`)).body.error.code).toBe('RESTORE_APPOINTMENT_FIRST');
    await del(staff, `/patients/${s.patientId}`);
    expect((await admin.post(`/trash/appointment/${apptId}/restore`)).body.error.code).toBe('RESTORE_PATIENT_FIRST');
    expect((await admin.post(`/trash/patient/${s.patientId}/restore`)).status).toBe(204);
    expect((await admin.post(`/trash/appointment/${apptId}/restore`)).status).toBe(204);
    expect((await admin.post(`/trash/report/${reportId}/restore`)).status).toBe(204);
    expect((await admin.get(`/appointments/${apptId}/report`)).body.report.summary).toBe('Top secret summary');
  });

  it('only restores what is in the Trash', async () => {
    expect((await admin.post(`/trash/appointment/${apptId}/restore`)).status).toBe(404);
    expect((await admin.post('/trash/nonsense/1/restore')).status).toBe(400);
  });
});

describe('erasing for good', () => {
  it('shows what would be erased before anything happens', async () => {
    await del(staff, `/patients/${s.patientId}`);
    const { counts } = (await admin.get(`/trash/patient/${s.patientId}/impact`)).body;
    expect(counts).toMatchObject({ patients: 1, appointments: 1, reports: 1, reportToothNotes: 1, prescriptionLines: 1, offers: 1, payments: 1, logins: 1 });
    expect(await count('patients')).toBeGreaterThan(0); // nothing was erased by looking
  });

  it('refuses anything that is not in the Trash, and a wrong confirmation', async () => {
    expect((await purge(admin, 'patient', s.patientId, 'Pat Patient')).status).toBe(404);
    await del(staff, `/patients/${s.patientId}`);
    const wrong = await purge(admin, 'patient', s.patientId, 'Somebody Else');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CONFIRM_MISMATCH');
    expect((await purge(admin, 'patient', s.patientId, '')).status).toBe(400);
    expect(await count('appointments')).toBe(1);
  });

  it('erases a patient and everything attached, and nobody else’s data', async () => {
    const otherAppt = (await t.db('appointments').insert({
      date: TOMORROW, time: '12:00', status: 'confirmed', patient_id: s.otherPatientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp,
    }))[0]!;
    await del(staff, `/patients/${s.patientId}`);
    expect((await purge(admin, 'patient', s.patientId, ' pat patient ')).status).toBe(204); // case and spaces don't matter

    for (const table of ['appointments', 'reports', 'report_tooth', 'medication_report', 'treatment_offers', 'payments', 'appointment_category']) {
      expect(await count(table), table).toBe(table === 'appointments' ? 1 : 0);
    }
    expect(await t.db('patients').where({ id: s.patientId }).first()).toBeUndefined();
    expect(await t.db('users').where({ email: 'patient@clinic.test' }).first()).toBeUndefined(); // their login goes too
    expect(await t.db('appointments').where({ id: otherAppt }).first()).toBeTruthy();
    expect(await t.db('patients').where({ id: s.otherPatientId }).first()).toBeTruthy();
    expect(await t.db('medications').first()).toBeTruthy(); // shared lists are untouched
    expect((await admin.get('/trash')).body.meta.total).toBe(0);
  });

  it('erases just an appointment with its report, or just a report', async () => {
    await del(staff, `/appointments/${apptId}/report`);
    expect((await purge(admin, 'report', reportId, 'Pat Patient')).status).toBe(204);
    expect(await count('reports')).toBe(0);
    expect(await count('report_tooth')).toBe(0);
    expect(await count('appointments')).toBe(1);

    await del(staff, `/appointments/${apptId}`);
    expect((await purge(admin, 'appointment', apptId, 'Pat Patient')).status).toBe(204);
    expect(await count('appointments')).toBe(0);
    expect(await count('appointment_category')).toBe(0);
    expect(await count('treatment_offers')).toBe(1); // the quote belongs to the patient, not the appointment
  });

  it('leaves a record of who erased what and how much, never the content', async () => {
    await del(staff, `/patients/${s.patientId}`);
    await purge(admin, 'patient', s.patientId, 'Pat Patient');
    const entry = await t.db('audit_log').where({ action: 'trash.purge' }).first();
    expect(entry).toMatchObject({ entity: 'patient', entity_id: String(s.patientId) });
    expect(JSON.parse(entry.diff).counts).toMatchObject({ patients: 1, appointments: 1, reports: 1, payments: 1 });
    const everything = JSON.stringify(await t.db('audit_log'));
    for (const secret of ['Top secret', 'Secret cavity', 'Amoxicillin', 'Pat Patient', '70111111']) expect(everything).not.toContain(secret);
  });

  it('is atomic: nothing is erased if a step fails', async () => {
    await del(staff, `/patients/${s.patientId}`);
    // Make the final delete of the patient fail by adding a row that blocks it.
    await t.db.raw('PRAGMA foreign_keys = ON');
    await t.db.raw('CREATE TEMP TRIGGER block_patient_delete BEFORE DELETE ON patients BEGIN SELECT RAISE(ABORT, \'blocked\'); END;');
    const res = await purge(admin, 'patient', s.patientId, 'Pat Patient');
    await t.db.raw('DROP TRIGGER block_patient_delete');
    expect(res.status).toBe(500);
    expect(await count('appointments')).toBe(1);
    expect(await count('reports')).toBe(1);
    expect(await count('payments')).toBe(1);
  });
});
