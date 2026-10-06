import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOW, TOMORROW, TODAY, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

let t: TestApp;
let s: Seed;
let admin: Client;

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  admin = await loggedIn(t, 'admin@clinic.test');
  const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
  // Adds to the seeded Pat Patient (100001, 70111111) and Olga Other (100002, 70222222).
  await t.db('patients').insert([
    { patient_identifier: '100010', fname: 'Zed', lname: 'Aaron', phone: '70999999', doctor_id: s.doctorId, ...stamp },
    { patient_identifier: '100003', fname: 'Mia', lname: 'Zimmer', phone: '70000001', doctor_id: s.doctorId, ...stamp },
  ]);
  const appt = (patient_id: number, doctor_id: number, time: string, status: string, date = TOMORROW) =>
    ({ date, time, status, patient_id, doctor_id, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 15, ...stamp });
  const aaron = (await t.db('patients').where({ lname: 'Aaron' }).first('id')).id;
  await t.db('appointments').insert([
    appt(aaron, s.doctorId, '09:00', 'pending', TOMORROW),
    appt(s.patientId, s.saraId, '11:00', 'confirmed', TODAY),
    appt(s.otherPatientId, s.externalDoctorId, '08:00', 'completed', TOMORROW),
  ].map((a) => (a.doctor_id === s.saraId ? { ...a, unit_id: s.saraUnitId } : a)));
});
afterAll(() => t.destroy());

const names = (res: { body: { data: { fname: string; lname: string }[] } }) => res.body.data.map((p) => p.lname);

describe('patient list sorting', () => {
  it('sorts by name, both ways', async () => {
    expect(names(await admin.get('/patients?sort=name&order=asc')).slice(0, 2)).toEqual(['Aaron', 'Other']);
    expect(names(await admin.get('/patients?sort=name&order=desc'))[0]).toBe('Zimmer');
  });
  it('sorts by phone', async () => {
    const asc = (await admin.get('/patients?sort=phone&order=asc')).body.data.map((p: { phone: string }) => p.phone);
    expect(asc).toEqual([...asc].sort());
    expect((await admin.get('/patients?sort=phone&order=desc')).body.data[0].phone).toBe('70999999');
  });
  it('sorts by patient number', async () => {
    const asc = (await admin.get('/patients?sort=number&order=asc')).body.data.map((p: { patientIdentifier: string }) => p.patientIdentifier);
    expect(asc).toEqual([...asc].sort());
    expect(asc[0]).toBe('100001');
  });
  it('keeps sorting across pages', async () => {
    const all = names(await admin.get('/patients?sort=name&order=asc&pageSize=100'));
    const first = names(await admin.get('/patients?sort=name&order=asc&pageSize=2&page=1'));
    const second = names(await admin.get('/patients?sort=name&order=asc&pageSize=2&page=2'));
    expect([...first, ...second]).toEqual(all.slice(0, 4));
  });
  it('rejects an unknown column', async () => {
    expect((await admin.get('/patients?sort=password')).status).toBe(400);
  });
});

describe('appointment list sorting', () => {
  const column = async (sort: string, order: string, pick: (a: Record<string, never>) => string) =>
    ((await admin.get(`/appointments?sort=${sort}&order=${order}&pageSize=100`)).body.data as Record<string, never>[]).map(pick);

  it('sorts by patient', async () => {
    const asc = await column('patient', 'asc', (a: any) => a.patient.lname);  
    expect(asc).toEqual([...asc].sort());
    expect(asc).toHaveLength(3);
    expect(await column('patient', 'desc', (a: any) => a.patient.lname)).toEqual([...asc].reverse());  
  });
  it('sorts by doctor', async () => {
    const asc = await column('doctor', 'asc', (a: any) => a.doctor.lname);  
    expect(asc).toEqual([...asc].sort());
  });
  it('sorts by time of day, whatever the date', async () => {
    expect(await column('time', 'asc', (a: any) => a.time)).toEqual(['08:00', '09:00', '11:00']);  
  });
  it('sorts by date (default) and by status', async () => {
    expect(await column('date', 'asc', (a: any) => a.date)).toEqual([TODAY, TOMORROW, TOMORROW]);  
    const status = await column('status', 'asc', (a: any) => a.status);  
    expect(status).toEqual([...status].sort());
  });
  it('sorts by unit', async () => {
    expect((await admin.get('/appointments?sort=unit&order=asc')).status).toBe(200);
  });
  it('rejects an unknown column', async () => {
    expect((await admin.get('/appointments?sort=password')).status).toBe(400);
  });
});

describe('report flag on appointments', () => {
  it('tells which appointments have a report, and sorts by it', async () => {
    const rows = (await admin.get('/appointments?pageSize=100')).body.data as { id: number; hasReport: boolean }[];
    expect(rows.every((a) => a.hasReport === false)).toBe(true);
    const target = rows[0]!.id;
    await t.db('reports').insert({ appointment_id: target, summary: 'Done', created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' });
    const after = (await admin.get('/appointments?pageSize=100')).body.data as { id: number; hasReport: boolean }[];
    expect(after.find((a) => a.id === target)!.hasReport).toBe(true);
    expect(after.filter((a) => a.hasReport)).toHaveLength(1);
    expect((await admin.get('/appointments?sort=report&order=desc&pageSize=100')).body.data[0].id).toBe(target);
    const asc = (await admin.get('/appointments?sort=report&order=asc&pageSize=100')).body.data as { hasReport: boolean }[];
    expect(asc[asc.length - 1]!.hasReport).toBe(true);
    expect((await admin.get(`/appointments/${target}`)).body.appointment.hasReport).toBe(true);
  });
});
