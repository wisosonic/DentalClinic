import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

let t: TestApp;
let s: Seed;
let admin: Client, doctor: Client, staff: Client, patient: Client;
let apptId: number;

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  [admin, doctor, staff, patient] = await Promise.all(
    ['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)),
  );
  apptId = (await t.db('appointments').insert({
    date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: s.patientId, doctor_id: s.doctorId,
    clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30,
  }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  await t.db('audit_log').del();
});

const views = () => t.db('audit_log').where('action', 'like', '%.view').orderBy('id');

describe('who viewed a patient record is logged', () => {
  it('logs the profile, timeline, chart and appointment list, all filed under the patient', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    await doctor.get(`/patients/${s.patientId}/timeline`);
    await doctor.get(`/patients/${s.patientId}/chart`);
    await doctor.get(`/patients/${s.patientId}/appointments`);
    const rows = await views();
    expect(rows.map((r) => r.action)).toEqual(['patient.view', 'patient.timeline.view', 'patient.chart.view', 'patient.appointments.view']);
    for (const r of rows) expect(r).toMatchObject({ entity: 'patient', entity_id: String(s.patientId) });
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(1);
  });

  it('logs opening an appointment and its report under the patient, with the appointment id', async () => {
    await staff.get(`/appointments/${apptId}`);
    await staff.get(`/appointments/${apptId}/report`);
    const rows = await views();
    expect(rows.map((r) => r.action)).toEqual(['appointment.view', 'report.view']);
    for (const r of rows) {
      expect(r).toMatchObject({ entity: 'patient', entity_id: String(s.patientId) });
      expect(JSON.parse(r.diff)).toEqual({ appointmentId: apptId });
    }
  });

  it('writes no health data or names into the log, only ids', async () => {
    await admin.get(`/patients/${s.patientId}`);
    const all = JSON.stringify(await t.db('audit_log'));
    for (const secret of ['secret note', 'Pat', 'Patient', '70111111']) expect(all).not.toContain(secret);
  });

  it('counts a repeat within ten minutes once, but separate people and separate records separately', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    await doctor.get(`/patients/${s.patientId}`);
    expect(await views()).toHaveLength(1);
    await staff.get(`/patients/${s.patientId}`);
    expect(await views()).toHaveLength(2);
    await t.db('audit_log').update({ created_at: '2000-01-01 00:00:00' }); // long ago
    await doctor.get(`/patients/${s.patientId}`);
    expect(await views()).toHaveLength(3);
  });

  it('does not log a patient looking at their own record', async () => {
    await patient.get('/patients/me');
    await patient.get('/patients/me/timeline');
    expect(await views()).toHaveLength(0);
  });

  it('does not log a request that was refused', async () => {
    await patient.get(`/patients/${s.otherPatientId}`);
    await doctor.get('/patients/99999');
    expect(await views()).toHaveLength(0);
  });
});

describe('reviewing the log (admin only)', () => {
  it('lists views with the person and patient names, newest first', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    await staff.get(`/patients/${s.patientId}/timeline`);
    const res = await admin.get('/audit-log?kind=views');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { action: string }) => r.action)).toEqual(['patient.timeline.view', 'patient.view']);
    expect(res.body.data[0]).toMatchObject({ userName: expect.any(String), entity: 'patient', entityId: String(s.patientId), entityLabel: 'Pat Patient' });
    expect(res.body.meta.total).toBe(2);
  });

  it('filters by kind, person, patient and dates', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    await staff.get(`/patients/${s.otherPatientId}`);
    await admin.post('/users', { name: 'X Y', email: 'xy@clinic.test', role: 'staff', password: 'Sup3r-Secret-Pass' });
    const doctorId = (await t.db('users').where({ email: 'doctor@clinic.test' }).first('id')).id;

    expect((await admin.get('/audit-log?kind=views')).body.meta.total).toBe(2);
    expect((await admin.get('/audit-log?kind=changes')).body.data.every((r: { action: string }) => !r.action.endsWith('.view'))).toBe(true);
    expect((await admin.get(`/audit-log?kind=views&userId=${doctorId}`)).body.meta.total).toBe(1);
    expect((await admin.get(`/audit-log?entity=patient&entityId=${s.otherPatientId}`)).body.meta.total).toBe(1);
    expect((await admin.get('/audit-log?from=2000-01-01&to=2000-01-02')).body.meta.total).toBe(0);
  });

  it('sorts by person and action, and rejects unknown columns', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    await staff.get(`/patients/${s.patientId}/timeline`);
    const byAction = (await admin.get('/audit-log?kind=views&sort=action&order=asc')).body.data.map((r: { action: string }) => r.action);
    expect(byAction).toEqual([...byAction].sort());
    expect((await admin.get('/audit-log?sort=password')).status).toBe(400);
  });

  it('is closed to everyone else', async () => {
    for (const c of [doctor, staff, patient]) expect((await c.get('/audit-log?kind=views')).status).toBe(403);
    expect((await t.client().get('/audit-log')).status).toBe(401);
  });
});

describe('clearing the log (admin only)', () => {
  const clear = (c: Client) => c.agent.delete('/api/v1/audit-log').set('x-csrf-token', c.csrf).send({});

  it('erases every entry for everyone and leaves one saying who did it and how many', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    await staff.get(`/patients/${s.patientId}/timeline`);
    const before = Number((await t.db('audit_log').count({ n: '*' }).first())!.n);
    expect(before).toBeGreaterThan(1);

    const res = await clear(admin);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(before);
    const rows = await t.db('audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'audit.clear' });
    expect(JSON.parse(rows[0].diff)).toEqual({ removed: before });
    expect(rows[0].user_id).toBe((await t.db('users').where({ email: 'admin@clinic.test' }).first('id')).id);
  });

  it('is refused for doctors, staff, patients and signed-out visitors, and erases nothing', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    const before = Number((await t.db('audit_log').count({ n: '*' }).first())!.n);
    for (const c of [doctor, staff, patient]) expect((await clear(c)).status).toBe(403);
    expect((await t.client().agent.delete('/api/v1/audit-log')).status).toBeGreaterThanOrEqual(401);
    expect(Number((await t.db('audit_log').count({ n: '*' }).first())!.n)).toBe(before);
  });
});

describe('deleting one log entry (admin only)', () => {
  const remove = (c: Client, id: number) => c.agent.delete(`/api/v1/audit-log/${id}`).set('x-csrf-token', c.csrf).send({});

  it('removes just that entry and notes that it happened, without its content', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    await staff.get(`/patients/${s.patientId}/timeline`);
    const [first, second] = await t.db('audit_log').orderBy('id');
    expect((await remove(admin, first.id)).status).toBe(204);
    const rows = await t.db('audit_log').orderBy('id');
    expect(rows.find((r) => r.id === first.id)).toBeUndefined();
    expect(rows.find((r) => r.id === second.id)).toBeTruthy();
    const note = rows.find((r) => r.action === 'audit.delete')!;
    expect(JSON.parse(note.diff)).toEqual({ entryId: first.id, entryAction: first.action });
  });

  it('answers 404 for an entry that is not there, and is refused for everyone else', async () => {
    await doctor.get(`/patients/${s.patientId}`);
    const entry = await t.db('audit_log').first();
    expect((await remove(admin, 999999)).status).toBe(404);
    for (const c of [doctor, staff, patient]) expect((await remove(c, entry.id)).status).toBe(403);
    expect(await t.db('audit_log').where({ id: entry.id }).first()).toBeTruthy();
  });
});
