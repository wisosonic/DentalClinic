import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * The waiting room (owner request 2026-10-07): staff give an arriving patient a number, the treating doctor sees
 * the patients waiting for him and calls them by number, and a screen shows the number called and the dental unit.
 */
let t: TestApp;
let s: Seed;
let now = NOW;
let admin: Client, aya: Client, sara: Client, staff: Client, ext: Client, patient: Client, orphan: Client;
let thirdPatient: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => now);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const link = async (email: string, name: string, doctorId: number | null) => {
    const [uid] = await t.db('users').insert({ name, email, role: 'doctor', password: hash, ...stamp });
    if (doctorId) await t.db('doctors').where({ id: doctorId }).update({ user_id: uid });
  };
  const [ayaUser] = await t.db('users').where({ email: 'doctor@clinic.test' }).pluck('id');
  await t.db('doctors').where({ id: s.doctorId }).update({ user_id: ayaUser });
  await link('sara@clinic.test', 'Dr Sara', s.saraId);
  await link('ext@clinic.test', 'Dr Ext', s.externalDoctorId);
  await link('orphan@clinic.test', 'Dr Nobody', null); // a doctor login with no doctor profile
  thirdPatient = (await t.db('patients').insert({ patient_identifier: '100003', fname: 'Nora', lname: 'Third', phone: '70333333', doctor_id: s.saraId, ...stamp }))[0]!;
  [admin, aya, sara, staff, ext, patient, orphan] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'sara@clinic.test', 'staff@clinic.test', 'ext@clinic.test', 'patient@clinic.test', 'orphan@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(() => t.destroy());
beforeEach(async () => {
  now = NOW;
  for (const table of ['waiting_tickets', 'appointment_category', 'appointments', 'audit_log']) await t.db(table).del();
  await t.db('app_settings').where({ key: 'waiting.display_key' }).del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
});

const checkIn = (c: Client, body: object) => c.post('/waiting-room', body);
const walkIn = async (c: Client, patientId: number, doctorId = s.doctorId, unitId = s.unitId) => {
  const res = await checkIn(c, { patientId, doctorId, unitId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.ticket as { id: number; number: number; status: string };
};
const appointment = async (patientId: number, extra: Record<string, unknown> = {}) =>
  (await t.db('appointments').insert({ date: TODAY, time: '11:00', status: 'confirmed', patient_id: patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp, ...extra }))[0]!;
const list = async (c: Client) => (await c.get('/waiting-room')).body as { date: string; data: { id: number; number: number; status: string; patient: { fname: string }; doctor: { id: number }; unit: { name: string } | null }[] };
const screen = async (admin_ = admin) => (await admin_.post('/waiting-room/screen/reset')).body as { key: string; path: string };
const display = (key: string | undefined) => t.client().agent.get(`/api/v1/waiting-display${key === undefined ? '' : `?key=${key}`}`);

describe('giving a number', () => {
  it('numbers the arrivals 1, 2, 3 in order, and says who, for which doctor and which dental unit', async () => {
    const first = await checkIn(staff, { patientId: s.patientId, doctorId: s.doctorId, unitId: s.unitId });
    expect(first.status).toBe(201);
    expect(first.body.ticket).toMatchObject({
      number: 1, date: TODAY, status: 'waiting', patient: { fname: 'Pat', lname: 'Patient' }, doctor: { fname: 'Aya', lname: 'Ghali' }, unit: { id: s.unitId }, appointment: null, callCount: 0, calledAt: null, finishedAt: null,
    });
    expect((await walkIn(admin, s.otherPatientId, s.saraId, s.saraUnitId)).number).toBe(2);
    expect((await walkIn(staff, thirdPatient, s.doctorId, s.unitId)).number).toBe(3);
  });

  it('starts again at 1 the next day', async () => {
    await walkIn(staff, s.patientId);
    await walkIn(staff, s.otherPatientId);
    now = new Date('2026-10-06T07:00:00Z');
    expect((await walkIn(staff, s.patientId)).number).toBe(1);
    expect((await list(admin)).date).toBe(TOMORROW);
    expect((await list(admin)).data.map((x) => x.number)).toEqual([1]); // yesterday's numbers are gone from today's list
  });

  it('refuses a second number for a patient who is still waiting or being called, and tells which', async () => {
    const first = await walkIn(staff, s.patientId);
    const again = await checkIn(staff, { patientId: s.patientId, doctorId: s.saraId, unitId: s.saraUnitId });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ALREADY_WAITING', details: { number: 1 } });
    await aya.post(`/waiting-room/${first.id}/call`);
    expect((await checkIn(staff, { patientId: s.patientId, doctorId: s.doctorId, unitId: s.unitId })).status).toBe(409);
    await aya.post(`/waiting-room/${first.id}/finish`);
    expect((await walkIn(staff, s.patientId)).number).toBe(2); // done: may come again, with a new number
  });

  it('takes the doctor and dental unit from an appointment expected today', async () => {
    const a = await appointment(s.patientId, { doctor_id: s.saraId, unit_id: s.saraUnitId });
    await t.db('appointment_category').insert({ appointment_id: a, category_id: s.categoryIds[0], ...stamp });
    const res = await checkIn(staff, { patientId: s.patientId, appointmentId: a });
    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({ doctor: { fname: 'Sara' }, unit: { id: s.saraUnitId }, appointment: { id: a, time: '11:00', procedures: ['Scaling'] } });
  });

  it('refuses an appointment that is not today’s, not active, someone else’s, or unknown', async () => {
    const other = await appointment(s.patientId, { date: TOMORROW });
    const cancelled = await appointment(s.patientId, { status: 'cancelled' });
    const done = await appointment(s.patientId, { status: 'completed' });
    const theirs = await appointment(s.otherPatientId);
    for (const [id, code] of [[other, 'NOT_TODAYS_APPOINTMENT'], [cancelled, 'NOT_TODAYS_APPOINTMENT'], [done, 'NOT_TODAYS_APPOINTMENT'], [theirs, 'UNKNOWN_APPOINTMENT'], [99999, 'UNKNOWN_APPOINTMENT']] as const) {
      const res = await checkIn(staff, { patientId: s.patientId, appointmentId: id });
      expect([res.status, res.body.error.code], String(id)).toEqual([400, code]);
    }
    expect(await t.db('waiting_tickets').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it('needs a doctor and a dental unit when there is no appointment, and rejects unknown ones', async () => {
    expect((await checkIn(staff, { patientId: s.patientId })).status).toBe(400);
    expect((await checkIn(staff, { patientId: s.patientId, doctorId: s.doctorId })).status).toBe(400);
    expect((await checkIn(staff, { patientId: 99999, doctorId: s.doctorId, unitId: s.unitId })).body.error.code).toBe('UNKNOWN_PATIENT');
    expect((await checkIn(staff, { patientId: s.patientId, doctorId: 99999, unitId: s.unitId })).body.error.code).toBe('UNKNOWN_DOCTOR');
    expect((await checkIn(staff, { patientId: s.patientId, doctorId: s.doctorId, unitId: 99999 })).body.error.code).toBe('UNKNOWN_UNIT');
    await t.db('patients').where({ id: s.otherPatientId }).update({ deleted_at: '2026-10-04 05:00:00' });
    expect((await checkIn(staff, { patientId: s.otherPatientId, doctorId: s.doctorId, unitId: s.unitId })).body.error.code).toBe('UNKNOWN_PATIENT');
  });

  it('is for staff and admin only: doctors, patients and visitors are refused', async () => {
    const body = { patientId: s.patientId, doctorId: s.doctorId, unitId: s.unitId };
    expect((await checkIn(aya, body)).status).toBe(403);
    expect((await checkIn(patient, body)).status).toBe(403);
    expect([401, 403]).toContain((await t.client().post('/waiting-room', body)).status);
    expect((await checkIn(admin, body)).status).toBe(201);
  });

  it('lists today’s expected appointments that have no number yet, for the desk', async () => {
    const a1 = await appointment(s.patientId, { time: '12:00' });
    const a2 = await appointment(s.otherPatientId, { time: '10:30', status: 'pending' });
    await appointment(thirdPatient, { date: TOMORROW });
    await appointment(thirdPatient, { status: 'cancelled' });
    await appointment(thirdPatient, { status: 'completed' });
    const res = await staff.get('/waiting-room/candidates');
    expect(res.body.data.map((c: { appointmentId: number }) => c.appointmentId)).toEqual([a2, a1]); // by time
    expect(res.body.data[1]).toMatchObject({ time: '12:00', patient: { fname: 'Pat' }, doctor: { fname: 'Aya' }, unit: { id: s.unitId } });
    await checkIn(staff, { patientId: s.patientId, appointmentId: a1 });
    expect((await staff.get('/waiting-room/candidates')).body.data.map((c: { appointmentId: number }) => c.appointmentId)).toEqual([a2]);
    expect((await aya.get('/waiting-room/candidates')).status).toBe(403);
  });
});

describe('who sees which tickets', () => {
  it('shows admin and staff every ticket, and a doctor only the patients waiting for him', async () => {
    await walkIn(staff, s.patientId, s.doctorId, s.unitId);
    await walkIn(staff, s.otherPatientId, s.saraId, s.saraUnitId);
    await walkIn(staff, thirdPatient, s.externalDoctorId, s.unitId); // an outside specialist, in one of the owners' units
    expect((await list(admin)).data.map((x) => x.number)).toEqual([1, 2, 3]);
    expect((await list(staff)).data.map((x) => x.number)).toEqual([1, 2, 3]);
    expect((await list(aya)).data.map((x) => x.number)).toEqual([1]);
    expect((await list(sara)).data.map((x) => x.number)).toEqual([2]);
    expect((await list(ext)).data.map((x) => x.number)).toEqual([3]);
    expect((await list(orphan)).data).toEqual([]); // a doctor login with no profile sees nothing
    expect((await aya.get('/waiting-room')).body.data[0]).toMatchObject({ patient: { fname: 'Pat', lname: 'Patient' }, unit: { name: expect.any(String) } });
    expect((await patient.get('/waiting-room')).status).toBe(403);
  });

  it('hides a deleted patient’s ticket', async () => {
    await walkIn(staff, s.patientId);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-05 05:00:00' });
    expect((await list(admin)).data).toEqual([]);
  });
});

describe('calling by number', () => {
  it('lets the doctor call his patient, call again, and finish', async () => {
    const tk = await walkIn(staff, s.patientId);
    const called = await aya.post(`/waiting-room/${tk.id}/call`);
    expect(called.status).toBe(200);
    expect(called.body.ticket).toMatchObject({ status: 'called', callCount: 1, calledAt: expect.any(String) });
    const again = await aya.post(`/waiting-room/${tk.id}/call`);
    expect(again.body.ticket).toMatchObject({ status: 'called', callCount: 2 });
    const finished = await aya.post(`/waiting-room/${tk.id}/finish`);
    expect(finished.body.ticket).toMatchObject({ status: 'done', finishedAt: expect.any(String) });
  });

  it('keeps one patient called at a time in a doctor’s unit: calling the next finishes the one before', async () => {
    const one = await walkIn(staff, s.patientId);
    const two = await walkIn(staff, s.otherPatientId);
    const elsewhere = await walkIn(staff, thirdPatient, s.saraId, s.saraUnitId);
    await aya.post(`/waiting-room/${one.id}/call`);
    await sara.post(`/waiting-room/${elsewhere.id}/call`);
    await aya.post(`/waiting-room/${two.id}/call`);
    const byNumber = Object.fromEntries((await list(admin)).data.map((x) => [x.number, x.status]));
    expect(byNumber).toEqual({ 1: 'done', 2: 'called', 3: 'called' }); // Sara's unit is untouched
  });

  it('can send a patient away (did not come) and can put a called patient back to waiting', async () => {
    const one = await walkIn(staff, s.patientId);
    const two = await walkIn(staff, s.otherPatientId);
    await aya.post(`/waiting-room/${one.id}/call`);
    const back = await aya.post(`/waiting-room/${one.id}/requeue`);
    expect(back.body.ticket).toMatchObject({ status: 'waiting', calledAt: null, number: 1 }); // keeps its number
    const left = await aya.post(`/waiting-room/${two.id}/leave`);
    expect(left.body.ticket).toMatchObject({ status: 'left', finishedAt: expect.any(String) });
    expect((await staff.post(`/waiting-room/${one.id}/leave`)).body.ticket.status).toBe('left'); // the desk may remove a ticket too
  });

  it('refuses what does not make sense: finishing a patient who was never called, calling one who is done', async () => {
    const tk = await walkIn(staff, s.patientId);
    for (const [action, code] of [['finish', 'INVALID_TICKET_ACTION'], ['requeue', 'INVALID_TICKET_ACTION']] as const) {
      const res = await aya.post(`/waiting-room/${tk.id}/${action}`);
      expect([res.status, res.body.error.code]).toEqual([409, code]);
    }
    await aya.post(`/waiting-room/${tk.id}/call`);
    await aya.post(`/waiting-room/${tk.id}/finish`);
    expect((await aya.post(`/waiting-room/${tk.id}/call`)).status).toBe(409);
    expect((await aya.post(`/waiting-room/${tk.id}/leave`)).status).toBe(409);
    expect((await aya.post(`/waiting-room/${tk.id}/dance`)).status).toBe(404);
  });

  it('is limited to the doctor’s own patients, and allowed for the desk and admin', async () => {
    const tk = await walkIn(staff, s.patientId); // Aya's
    expect((await sara.post(`/waiting-room/${tk.id}/call`)).status).toBe(404); // another doctor's looks like none
    expect((await ext.post(`/waiting-room/${tk.id}/call`)).status).toBe(404);
    expect((await orphan.post(`/waiting-room/${tk.id}/call`)).status).toBe(404);
    expect((await patient.post(`/waiting-room/${tk.id}/call`)).status).toBe(403);
    expect((await staff.post(`/waiting-room/${tk.id}/call`)).status).toBe(200);
    expect((await admin.post(`/waiting-room/${tk.id}/call`)).body.ticket.callCount).toBe(2);
    expect((await aya.post('/waiting-room/99999/call')).status).toBe(404);
  });

  it('will not act on a number from an earlier day', async () => {
    const tk = await walkIn(staff, s.patientId);
    now = new Date('2026-10-06T07:00:00Z');
    const res = await aya.post(`/waiting-room/${tk.id}/call`);
    expect([res.status, res.body.error.code]).toEqual([409, 'TICKET_EXPIRED']);
  });

  it('logs who did what by number and ids only', async () => {
    const tk = await walkIn(staff, s.patientId);
    await aya.post(`/waiting-room/${tk.id}/call`);
    await aya.post(`/waiting-room/${tk.id}/finish`);
    const log = await t.db('audit_log').whereIn('action', ['waiting.checkin', 'waiting.call', 'waiting.finish']).orderBy('id');
    expect(log.map((l) => l.action)).toEqual(['waiting.checkin', 'waiting.call', 'waiting.finish']);
    expect(JSON.stringify(log)).not.toMatch(/Pat|Patient|Ghali/); // no names
  });
});

describe('the waiting-room screen', () => {
  it('is set up by an admin only, with a secret address that can be replaced', async () => {
    expect((await admin.get('/waiting-room/screen')).body).toEqual({ key: null, path: null });
    const made = await screen();
    expect(made.key).toHaveLength(32);
    expect(made.path).toBe(`/waiting-display?key=${made.key}`);
    expect((await admin.get('/waiting-room/screen')).body).toEqual(made);
    for (const c of [staff, aya, patient]) {
      expect((await c.get('/waiting-room/screen')).status).toBe(403);
      expect((await c.post('/waiting-room/screen/reset')).status).toBe(403);
    }
    const fresh = await screen();
    expect(fresh.key).not.toBe(made.key);
    expect((await display(made.key)).status).toBe(404); // the old address stops working
    expect((await display(fresh.key)).status).toBe(200);
    expect(JSON.stringify(await t.db('audit_log').where({ action: 'waiting.screen_key' }))).not.toContain(fresh.key);
  });

  it('needs the secret: no key, a wrong key, or no key set yet all look like no page', async () => {
    expect((await display('anything')).status).toBe(404); // none set yet
    const { key } = await screen();
    for (const bad of [undefined, '', 'wrong', `${key}x`, key.slice(1)]) expect((await display(bad)).status, String(bad)).toBe(404);
    expect((await display(key)).status).toBe(200);
  });

  it('shows the numbers being called with their dental units, newest first, and how many wait: never a name', async () => {
    const { key } = await screen();
    expect((await display(key)).body).toEqual({ calls: [], waiting: 0, clinic: 'Test Clinic', chime: true });
    const one = await walkIn(staff, s.patientId, s.doctorId, s.unitId);
    const two = await walkIn(staff, s.otherPatientId, s.saraId, s.saraUnitId);
    await walkIn(staff, thirdPatient, s.doctorId, s.unitId);
    await aya.post(`/waiting-room/${one.id}/call`);
    await t.db('waiting_tickets').where({ id: one.id }).update({ called_at: '2026-10-05 07:00:00' }); // the clock of the server is real: make the order certain
    await sara.post(`/waiting-room/${two.id}/call`);
    await t.db('waiting_tickets').where({ id: two.id }).update({ called_at: '2026-10-05 07:01:00' });
    const res = await display(key);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.calls).toEqual([
      { number: 2, label: '2', unit: "Dr Sara's unit", calledAt: '2026-10-05 07:01:00', callCount: 1 },
      { number: 1, label: '1', unit: "Dr Aya's unit", calledAt: '2026-10-05 07:00:00', callCount: 1 },
    ]);
    expect(res.body.waiting).toBe(1);
    expect(JSON.stringify(res.body)).not.toMatch(/Pat|Olga|Nora|Ghali|Doughan|patient/i);
  });

  it('shows one call per dental unit (the latest), and drops a patient once finished', async () => {
    const { key } = await screen();
    const one = await walkIn(staff, s.patientId);
    const two = await walkIn(staff, s.otherPatientId);
    await aya.post(`/waiting-room/${one.id}/call`);
    await aya.post(`/waiting-room/${two.id}/call`); // moves on: the first is finished
    expect((await display(key)).body.calls.map((c: { number: number }) => c.number)).toEqual([2]);
    await aya.post(`/waiting-room/${two.id}/call`); // called again: the count goes up so the screen can announce it again
    expect((await display(key)).body.calls[0]).toMatchObject({ number: 2, callCount: 2 });
    await aya.post(`/waiting-room/${two.id}/finish`);
    expect((await display(key)).body.calls).toEqual([]);
  });

  it('shows today’s calls only, and not those of a deleted patient', async () => {
    const { key } = await screen();
    const one = await walkIn(staff, s.patientId);
    await aya.post(`/waiting-room/${one.id}/call`);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-05 05:00:00' });
    expect((await display(key)).body.calls).toEqual([]);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: null });
    expect((await display(key)).body.calls).toHaveLength(1);
    now = new Date('2026-10-06T07:00:00Z');
    expect((await display(key)).body).toMatchObject({ calls: [], waiting: 0 });
  });
});

describe('erasing a patient', () => {
  it('removes their numbers too', async () => {
    await walkIn(staff, s.otherPatientId);
    await staff.agent.delete(`/api/v1/patients/${s.otherPatientId}`).set('x-csrf-token', staff.csrf);
    const res = await admin.agent.delete(`/api/v1/trash/patient/${s.otherPatientId}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Olga Other' });
    expect(res.status).toBe(204);
    expect(await t.db('waiting_tickets').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });
});
