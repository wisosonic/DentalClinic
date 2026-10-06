import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Deleting a clinic (owner decision, 2026-10-05): only the clinic's own record goes. Its appointments and the
 * dental units they were on stay, with no clinic, because they were used for payments, commission and tax
 * figures. They are read-only, and an admin can see and delete them.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  [admin, aya, staff, patient] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['payments', 'quotes', 'report_tooth', 'medication_report', 'reports', 'appointment_category', 'appointment_tooth', 'appointments', 'audit_log']) await t.db(table).del();
  // earlier tests' clinics are gone; only the seeded one is left to the next test
  for (const c of await t.db('clinics').whereNot({ id: s.clinicId }).select('id')) await t.db('clinics').where({ id: c.id }).del();
  await t.db('dental_units').whereNull('clinic_id').del();
});

/** A clinic of its own (so the seeded one stays), with Aya working there on her own unit, and one visit booked. */
async function clinicWithVisit(date = TOMORROW) {
  const clinic = (await admin.post('/clinics', { name: 'Branch Clinic' })).body.clinic.id as number;
  expect((await admin.send('put', `/clinics/${clinic}/doctors/${s.doctorId}`, { drPart: 100 })).status).toBeLessThan(300);
  const unit = (await admin.get(`/units?clinicId=${clinic}`)).body.data[0].id as number;
  const res = await staff.post('/appointments', { patientId: s.patientId, doctorId: s.doctorId, clinicId: clinic, unitId: unit, date, time: '10:00', durationMinutes: 30 });
  expect(res.status).toBe(201);
  return { clinic, unit, appointment: res.body.appointment.id as number };
}
const remove = (clinic: number) => admin.send('delete', `/clinics/${clinic}`);

describe('deleting a clinic', () => {
  it('removes the clinic record and nothing else: appointments and their dental unit stay, with no clinic', async () => {
    const { clinic, unit, appointment } = await clinicWithVisit();
    const extraUnit = (await admin.post('/units', { clinicId: clinic, ownerDoctorId: s.doctorId, name: 'Spare unit' })).body.unit.id as number; // nobody was ever booked on it
    await t.db('quotes').insert({ title: 'Crown', type: 'clinic', price: 100, cost: 0, currency: '$', status: 'accepted', patient_id: s.patientId, ...stamp });
    const patientsBefore = (await t.db('patients').count({ n: '*' }).first()) as { n: number };
    expect((await remove(clinic)).status).toBe(204);

    expect(await t.db('clinics').where({ id: clinic }).first()).toBeUndefined();
    expect(await t.db('appointments').where({ id: appointment }).first()).toMatchObject({ clinic_id: null, unit_id: unit, status: 'confirmed' });
    expect(await t.db('dental_units').where({ id: unit }).first()).toMatchObject({ clinic_id: null, owner_doctor_id: s.doctorId });
    expect(await t.db('dental_units').where({ id: extraUnit }).first()).toBeUndefined(); // a unit with nothing on it has nothing to keep
    expect(await t.db('clinic_doctor').where({ clinic_id: clinic }).count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect(await t.db('patients').count({ n: '*' }).first()).toEqual(patientsBefore);
    expect(await t.db('quotes').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('can delete a clinic that has appointments (it used to be refused), and logs only how much was kept', async () => {
    const { clinic } = await clinicWithVisit();
    expect((await remove(clinic)).status).toBe(204);
    const entry = await t.db('audit_log').where({ action: 'clinic.delete' }).first();
    expect(entry).toMatchObject({ entity: 'clinic', entity_id: String(clinic) });
    expect(JSON.parse(entry.diff)).toEqual({ keptAppointments: 1, keptUnits: 1 });
    expect((await remove(clinic)).status).toBe(404);
  });

  it('does not touch the money: payments, quotes and the Summary and tax figures are the same afterwards', async () => {
    const { clinic, appointment } = await clinicWithVisit(TODAY);
    await t.db('appointments').where({ id: appointment }).update({ status: 'completed' });
    const q = (await t.db('quotes').insert({ title: 'Crown', type: 'clinic', price: 500, cost: 0, currency: '$', status: 'accepted', patient_id: s.patientId, ...stamp }))[0]!;
    await t.db('payments').insert({ date: TODAY, type: 'clinic', amount: 200, currency: '$', quote_id: q, collected_by_doctor_id: s.doctorId, dr_part: 100, ...stamp });
    const figures = async () => ({ summary: (await admin.get('/finance/summary?from=2026-01-01&to=2026-12-31')).body, tax: (await admin.get('/finance/tax?year=2026')).body.result });
    const before = await figures();
    await remove(clinic);
    expect(await figures()).toEqual(before);
    expect(await t.db('payments').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('is for admins only', async () => {
    const { clinic } = await clinicWithVisit();
    for (const c of [aya, staff, patient]) expect((await c.send('delete', `/clinics/${clinic}`)).status).toBe(403);
    expect(await t.db('clinics').where({ id: clinic }).first()).toBeTruthy();
  });
});

describe('what stays is read-only', () => {
  it('can still be read, with no clinic, by everyone who could read it before', async () => {
    const { clinic, appointment } = await clinicWithVisit();
    await remove(clinic);
    for (const c of [admin, staff, aya]) {
      const a = (await c.get(`/appointments/${appointment}`)).body.appointment;
      expect(a).toMatchObject({ id: appointment, clinicId: null, clinic: null, status: 'confirmed' });
    }
    expect((await admin.get('/appointments')).body.data.map((a: { id: number }) => a.id)).toContain(appointment);
    expect((await admin.get(`/patients/${s.patientId}/timeline`)).body.data.map((e: { appointment: { id: number } }) => e.appointment.id)).toContain(appointment);
  });

  it('refuses every change: rescheduling, confirming, cancelling, completing, procedures, teeth', async () => {
    const { clinic, appointment } = await clinicWithVisit(TODAY);
    await remove(clinic);
    const refused = async (res: { status: number; body: { error?: { code?: string } } }) => {
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('CLINIC_DELETED');
    };
    await refused(await admin.patch(`/appointments/${appointment}`, { time: '11:00' }));
    for (const action of ['confirm', 'cancel', 'complete', 'no-show']) await refused(await admin.post(`/appointments/${appointment}/${action}`));
    await refused(await admin.put(`/appointments/${appointment}/categories`, { categoryIds: [s.categoryIds[0]] }));
    await refused(await admin.put(`/appointments/${appointment}/teeth`, { teeth: [{ toothId: s.toothIds[0] }] }));
    expect(await t.db('appointments').where({ id: appointment }).first()).toMatchObject({ status: 'confirmed', time: '10:00' });
  });

  it('refuses to write or change the visit report, but still shows one that was written', async () => {
    const { clinic, appointment } = await clinicWithVisit(TODAY);
    await t.db('appointments').where({ id: appointment }).update({ status: 'completed' });
    await admin.put(`/appointments/${appointment}/report`, { summary: 'Written while the clinic existed' });
    await remove(clinic);
    for (const [method, url, body] of [['put', `/appointments/${appointment}/report`, { summary: 'Changed' }], ['put', `/appointments/${appointment}/report/teeth`, { teeth: [] }], ['put', `/appointments/${appointment}/report/medications`, { medications: [] }]] as const) {
      const res = await admin.send(method, url, body);
      expect(res.status, url).toBe(409);
      expect(res.body.error.code).toBe('CLINIC_DELETED');
    }
    expect((await admin.get(`/appointments/${appointment}/report`)).body.report.summary).toBe('Written while the clinic existed');
  });

  it('refuses to rename the dental unit, and does not offer it for new bookings', async () => {
    const { clinic, unit } = await clinicWithVisit();
    await remove(clinic);
    const res = await admin.patch(`/units/${unit}`, { name: 'Renamed' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CLINIC_DELETED');
    expect((await admin.get('/units')).body.data.map((u: { id: number }) => u.id)).not.toContain(unit);
    const book = await staff.post('/appointments', { patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: unit, date: TOMORROW, time: '14:00', durationMinutes: 30 });
    expect(book.status).toBe(400); // the unit is not at that clinic
  });

  it('still lets the record be deleted (to the Trash), which an admin can then restore or erase', async () => {
    const { clinic, appointment } = await clinicWithVisit();
    await remove(clinic);
    expect((await admin.send('delete', `/appointments/${appointment}`)).status).toBe(204);
    expect((await admin.get(`/appointments/${appointment}`)).status).toBe(404);
    expect((await admin.get('/trash?kind=appointment')).body.data.map((i: { id: number }) => i.id)).toContain(appointment);
  });

  it('prints the visit summary of such an appointment, without a clinic name of its own', async () => {
    const { clinic, appointment } = await clinicWithVisit(TODAY);
    await t.db('appointments').where({ id: appointment }).update({ status: 'completed' });
    await admin.put(`/appointments/${appointment}/report`, { summary: 'Done' }); // a summary is printed once there is a report
    await remove(clinic);
    const res = await admin.agent.get(`/api/v1/appointments/${appointment}/report/pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });
});

describe('the admin’s list of what deleted clinics left', () => {
  it('shows the appointments and dental units with no clinic, and nothing else', async () => {
    const { clinic, unit, appointment } = await clinicWithVisit();
    const live = await staff.post('/appointments', { patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '16:00', durationMinutes: 30 });
    await t.db('reports').insert({ appointment_id: appointment, summary: 'x', ...stamp });
    await remove(clinic);
    const r = (await admin.get('/clinics/deleted-data')).body;
    expect(r.appointments).toEqual([{
      id: appointment, date: TOMORROW, time: '10:00', status: 'confirmed', patient: { id: s.patientId, fname: 'Pat', lname: 'Patient' },
      doctor: { id: s.doctorId, fname: expect.any(String), lname: expect.any(String) }, unit: { id: unit, name: expect.any(String) }, hasReport: true,
    }]);
    expect(r.appointments.map((a: { id: number }) => a.id)).not.toContain(live.body.appointment.id); // a live clinic's appointment is not here
    expect(r.units).toEqual([{ id: unit, name: expect.any(String), ownerName: expect.any(String), appointments: 1 }]);
  });

  it('drops an appointment from the list once it is deleted, and lets a unit with nothing on it be deleted', async () => {
    const { clinic, unit, appointment } = await clinicWithVisit();
    await remove(clinic);
    const blocked = await admin.send('delete', `/units/${unit}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('UNIT_IN_USE'); // appointments are still on it
    await admin.send('delete', `/appointments/${appointment}`);
    expect((await admin.get('/clinics/deleted-data')).body.appointments).toEqual([]);
    // erase the appointment for good from the Trash, and the unit has nothing left on it
    await admin.agent.delete(`/api/v1/trash/appointment/${appointment}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Pat Patient' });
    expect((await admin.send('delete', `/units/${unit}`)).status).toBe(204);
    expect((await admin.get('/clinics/deleted-data')).body.units).toEqual([]);
  });

  it('is empty when no clinic was ever deleted, and for admins only', async () => {
    expect((await admin.get('/clinics/deleted-data')).body).toEqual({ appointments: [], units: [] });
    for (const c of [aya, staff, patient]) expect((await c.get('/clinics/deleted-data')).status).toBe(403);
    expect((await t.client().get('/clinics/deleted-data')).status).toBe(401);
  });

  it('keeps showing records of a patient who is deleted out of it', async () => {
    const { clinic } = await clinicWithVisit();
    await remove(clinic);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await admin.get('/clinics/deleted-data')).body.appointments).toEqual([]); // a deleted patient is in the Trash, with their visits
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: null });
  });
});
