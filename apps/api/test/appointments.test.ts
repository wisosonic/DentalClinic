import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

let t: TestApp;
let s: Seed;
let admin: Client, doctor: Client, staff: Client, patient: Client;

const SUNDAY = '2026-10-11';

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW); // Monday 2026-10-05, 10:00 at the clinic
  s = await seedClinic(t);
  [admin, doctor, staff, patient] = await Promise.all(
    ['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)),
  );
});
afterAll(() => t.destroy());
beforeEach(async () => {
  await t.db('appointments').del();
  await t.db('patients').update({ last_visit: null, deleted_at: null });
  await t.db('audit_log').del();
});

/** Books on Dr Aya's unit with Dr Aya, tomorrow at 10:00 for 30 minutes unless overridden. */
const book = (c: Client, extra: object = {}) =>
  c.post('/appointments', {
    patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00', ...extra,
  });

const insert = (row: Record<string, unknown> = {}) =>
  t.db('appointments')
    .insert({ date: TOMORROW, time: '10:00', duration_minutes: 30, status: 'confirmed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, ...row })
    .then(([id]) => id as number);

const busy = async (doctorId: number, unitId: number, date: string, extra = '') =>
  (await staff.get(`/appointments/busy?doctorId=${doctorId}&unitId=${unitId}&date=${date}${extra}`)).body;

describe('busy periods', () => {
  it('is empty on a free day, for any day of the week', async () => {
    expect(await busy(s.doctorId, s.unitId, TOMORROW)).toEqual({ date: TOMORROW, doctorBusy: [], unitBusy: [] });
    expect((await busy(s.doctorId, s.unitId, SUNDAY)).doctorBusy).toEqual([]);
  });

  it('lists what occupies the doctor and the unit, earliest first, with real lengths', async () => {
    await insert({ time: '11:00', duration_minutes: 90 });
    await insert({ time: '09:00', duration_minutes: 30, patient_id: s.otherPatientId });
    const res = await busy(s.doctorId, s.unitId, TOMORROW);
    expect(res.doctorBusy).toEqual([
      expect.objectContaining({ start: '09:00', end: '09:30', durationMinutes: 30, patientName: 'Olga Other' }),
      expect.objectContaining({ start: '11:00', end: '12:30', durationMinutes: 90, patientName: 'Pat Patient', status: 'confirmed' }),
    ]);
    expect(res.unitBusy).toHaveLength(2);
  });

  it('separates the doctor from the unit', async () => {
    await insert({ doctor_id: s.externalDoctorId, unit_id: s.unitId, time: '10:00' }); // a specialist on Aya's unit
    await insert({ doctor_id: s.doctorId, unit_id: s.saraUnitId, time: '14:00' }); // Aya on Sara's unit
    const res = await busy(s.doctorId, s.unitId, TOMORROW);
    expect(res.doctorBusy.map((p: { start: string }) => p.start)).toEqual(['14:00']);
    expect(res.unitBusy.map((p: { start: string }) => p.start)).toEqual(['10:00']);
  });

  it('ignores cancelled and no-show appointments, and the one being edited', async () => {
    await insert({ time: '09:00', status: 'cancelled' });
    await insert({ time: '09:30', status: 'no_show' });
    await insert({ time: '10:00', status: 'pending' });
    const own = await insert({ time: '11:00' });
    expect((await busy(s.doctorId, s.unitId, TOMORROW)).doctorBusy).toHaveLength(2);
    expect((await busy(s.doctorId, s.unitId, TOMORROW, `&excludeId=${own}`)).doctorBusy).toHaveLength(1);
  });

  it('is for clinic staff only, and validates', async () => {
    expect((await patient.get(`/appointments/busy?doctorId=1&unitId=1&date=${TOMORROW}`)).status).toBe(403);
    expect((await t.client().get(`/appointments/busy?doctorId=1&unitId=1&date=${TOMORROW}`)).status).toBe(401);
    expect((await staff.get('/appointments/busy?doctorId=1&unitId=1&date=2026-02-31')).status).toBe(400);
    expect((await staff.get(`/appointments/busy?doctorId=x&unitId=1&date=${TOMORROW}`)).status).toBe(400);
  });
});

describe('booking', () => {
  it.each([['doctor'], ['staff'], ['admin']])('lets %s book, with the default length', async (who) => {
    const c = { doctor, staff, admin }[who as 'doctor']!;
    const res = await book(c, { categoryIds: s.categoryIds, toothIds: s.toothIds, intended: 'Check-up' });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({
      date: TOMORROW, time: '10:00', durationMinutes: 30, endTime: '10:30', status: 'confirmed', intended: 'Check-up',
      patient: { fname: 'Pat', phone: '70111111' }, doctor: { fname: 'Aya' }, clinic: { name: 'Test Clinic' },
      unit: { id: s.unitId, name: "Dr Aya's unit", ownerDoctorId: s.doctorId },
    });
    expect(res.body.appointment.categories.map((c: { name: string }) => c.name)).toEqual(['Crown', 'Scaling']);
    expect(res.body.appointment.teeth).toHaveLength(2);
    await t.db('appointments').del();
  });

  it('takes any length in 15-minute steps', async () => {
    const res = await book(staff, { durationMinutes: 90 });
    expect(res.body.appointment).toMatchObject({ durationMinutes: 90, endTime: '11:30' });
    expect((await book(staff, { time: '13:00', durationMinutes: 15 })).body.appointment.endTime).toBe('13:15');
    expect((await book(staff, { time: '15:00', durationMinutes: 480 })).body.appointment.endTime).toBe('23:00');
  });

  it.each([
    ['not a multiple of 15', { durationMinutes: 20 }],
    ['zero', { durationMinutes: 0 }],
    ['too long', { durationMinutes: 495 }],
    ['negative', { durationMinutes: -15 }],
    ['text', { durationMinutes: '30' }],
  ])('rejects a length that is %s', async (_label, extra) => {
    expect((await book(staff, extra)).status).toBe(400);
  });

  it('has no working hours: any day, any time, even in the past', async () => {
    expect((await book(staff, { date: SUNDAY, time: '03:15' })).status).toBe(201);
    expect((await book(staff, { time: '21:50' })).status).toBe(201);
    expect((await book(staff, { date: '2026-09-01', time: '10:00' })).status).toBe(201);
    expect((await book(staff, { date: TODAY, time: '08:00' })).status).toBe(201);
  });

  it('must end before midnight', async () => {
    expect((await book(staff, { time: '23:45', durationMinutes: 30 })).body.error.code).toBe('ENDS_AFTER_MIDNIGHT');
    expect((await book(staff, { time: '23:30', durationMinutes: 30 })).status).toBe(201); // ends exactly at 24:00
    expect((await staff.get(`/appointments/${(await t.db('appointments').first('id')).id}`)).body.appointment.endTime).toBe('24:00');
  });

  describe('the doctor cannot be in two places', () => {
    beforeEach(async () => {
      await insert({ time: '10:00', duration_minutes: 30 }); // Aya, 10:00-10:30, her own unit
    });

    it.each([
      ['starts inside', '10:15', 30],
      ['same time', '10:00', 30],
      ['starts earlier and runs into it', '09:30', 45],
      ['swallows it', '09:00', 120],
    ])('rejects an appointment that %s, even on another unit', async (_label, time, durationMinutes) => {
      const res = await book(staff, { unitId: s.saraUnitId, time, durationMinutes, patientId: s.otherPatientId });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOCTOR_BUSY');
      expect(res.body.error.message).toMatch(/10:00 to 10:30/);
    });

    it.each([
      ['starts the moment it ends', '10:30', 30],
      ['ends the moment it starts', '09:30', 30],
      ['is long but earlier', '08:00', 120],
    ])('allows an appointment that %s', async (_label, time, durationMinutes) => {
      expect((await book(staff, { unitId: s.saraUnitId, time, durationMinutes, patientId: s.otherPatientId })).status).toBe(201);
    });

    it('is not fooled by a longer existing appointment', async () => {
      await t.db('appointments').del();
      await insert({ time: '10:00', duration_minutes: 120 });
      expect((await book(staff, { unitId: s.saraUnitId, time: '11:30' })).body.error.code).toBe('DOCTOR_BUSY');
      expect((await book(staff, { unitId: s.saraUnitId, time: '12:00' })).status).toBe(201);
    });
  });

  describe('a dental unit hosts one patient at a time', () => {
    beforeEach(async () => {
      await insert({ time: '10:00', duration_minutes: 60 }); // Aya on her own unit, 10:00-11:00
    });

    it('rejects another doctor on the same unit at an overlapping time', async () => {
      const res = await book(staff, { doctorId: s.externalDoctorId, time: '10:30', patientId: s.otherPatientId });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('UNIT_BUSY');
      expect(res.body.error.message).toMatch(/10:00 to 11:00/);
    });

    it('allows the same time on a different unit with a different doctor', async () => {
      const res = await book(staff, { doctorId: s.saraId, unitId: s.saraUnitId, time: '10:00', patientId: s.otherPatientId });
      expect(res.status).toBe(201);
    });

    it('lets an external doctor use an owner’s unit when it is free', async () => {
      const res = await book(staff, { doctorId: s.externalDoctorId, time: '11:00', patientId: s.otherPatientId });
      expect(res.status).toBe(201);
      expect(res.body.appointment.unit.ownerDoctorId).toBe(s.doctorId);
    });

    it('checks the doctor before the unit when both are busy', async () => {
      expect((await book(staff, { time: '10:30' })).body.error.code).toBe('DOCTOR_BUSY');
    });
  });

  it('lets exactly one of several simultaneous requests win', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => book(i % 2 ? staff : admin, { time: '14:00', patientId: i % 2 ? s.patientId : s.otherPatientId })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await t.db('appointments').where({ date: TOMORROW, time: '14:00' }).count({ n: '*' }).first()).toEqual({ n: 1 });
  });

  it('lets two different doctors on different units book the same time at once', async () => {
    const [a, b] = await Promise.all([
      book(staff, { time: '15:00' }),
      book(staff, { time: '15:00', doctorId: s.saraId, unitId: s.saraUnitId, patientId: s.otherPatientId }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  it('frees the time when the appointment is cancelled', async () => {
    const first = await book(staff);
    await staff.post(`/appointments/${first.body.appointment.id}/cancel`);
    expect((await book(staff, { patientId: s.otherPatientId })).status).toBe(201);
  });

  it('rejects unknown or mismatched references', async () => {
    expect((await book(staff, { patientId: 99999 })).body.error.code).toBe('UNKNOWN_PATIENT');
    expect((await book(staff, { doctorId: 99999 })).body.error.code).toBe('UNKNOWN_DOCTOR');
    expect((await book(staff, { clinicId: 99999 })).body.error.code).toBe('UNKNOWN_CLINIC');
    expect((await book(staff, { unitId: 99999 })).body.error.code).toBe('UNKNOWN_UNIT');
    expect((await book(staff, { categoryIds: [99999] })).body.error.code).toBe('UNKNOWN_CATEGORY');
    expect((await book(staff, { toothIds: [99999] })).body.error.code).toBe('UNKNOWN_TOOTH');
    expect((await book(staff, { doctorId: s.floatingDoctorId })).body.error.code).toBe('DOCTOR_NOT_AT_CLINIC');

    const [other] = await t.db('clinics').insert({ name: 'Elsewhere' });
    const [foreignUnit] = await t.db('dental_units').insert({ clinic_id: other, owner_doctor_id: s.floatingDoctorId, name: 'Far away' });
    expect((await book(staff, { unitId: foreignUnit })).body.error.code).toBe('UNIT_NOT_AT_CLINIC');
  });

  it('requires a patient and a unit', async () => {
    expect((await book(staff, { patientId: undefined })).status).toBe(400);
    expect((await book(staff, { unitId: undefined })).status).toBe(400);
  });

  it("rejects a soft-deleted patient and malformed input", async () => {
    await t.db('patients').where({ id: s.otherPatientId }).update({ deleted_at: '2026-01-01 00:00:00' });
    expect((await book(staff, { patientId: s.otherPatientId })).body.error.code).toBe('UNKNOWN_PATIENT');
    expect((await book(staff, { date: '2026-13-01' })).status).toBe(400);
    expect((await book(staff, { time: '25:00' })).status).toBe(400);
    expect((await book(staff, { status: 'completed' })).status).toBe(400);
    expect((await book(staff, { intended: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('can create a pending appointment', async () => {
    expect((await book(staff, { status: 'pending' })).body.appointment.status).toBe('pending');
  });

  it('leaves nothing behind when a booking fails', async () => {
    await book(staff);
    await book(staff, { patientId: s.otherPatientId, categoryIds: s.categoryIds });
    expect(await t.db('appointment_category').count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  it('logs bookings', async () => {
    const res = await book(staff);
    expect(await t.db('audit_log').where({ action: 'appointment.create', entity_id: String(res.body.appointment.id) })).toHaveLength(1);
  });
});

describe('patients cannot book', () => {
  it('is refused, however the request is shaped', async () => {
    expect((await book(patient)).status).toBe(403);
    expect((await book(patient, { patientId: s.patientId })).status).toBe(403);
    expect((await book(patient, { status: 'confirmed' })).status).toBe(403);
    expect(await t.db('appointments').count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  it('cannot see who is busy either', async () => {
    expect((await patient.get(`/appointments/busy?doctorId=${s.doctorId}&unitId=${s.unitId}&date=${TOMORROW}`)).status).toBe(403);
  });

  it('is refused when signed out', async () => {
    expect([401, 403]).toContain((await book(t.client())).status);
  });
});

describe('rescheduling and changing the length', () => {
  it('moves an appointment in time and to another unit', async () => {
    const id = (await book(staff)).body.appointment.id;
    const res = await staff.patch(`/appointments/${id}`, { time: '11:30', unitId: s.saraUnitId, intended: 'Moved' });
    expect(res.status).toBe(200);
    expect(res.body.appointment).toMatchObject({ time: '11:30', intended: 'Moved', endTime: '12:00', unit: { id: s.saraUnitId } });
  });

  it('may keep its own place and change only the notes', async () => {
    const id = (await book(staff)).body.appointment.id;
    expect((await staff.patch(`/appointments/${id}`, { intended: 'Only notes', time: '10:00' })).status).toBe(200);
  });

  it('refuses a time someone else holds, and leaves the original in place', async () => {
    await book(staff, { time: '11:00', patientId: s.otherPatientId });
    const id = (await book(staff)).body.appointment.id;
    expect((await staff.patch(`/appointments/${id}`, { time: '11:00' })).body.error.code).toBe('DOCTOR_BUSY');
    expect((await staff.get(`/appointments/${id}`)).body.appointment.time).toBe('10:00');
  });

  it('checks the new unit and doctor', async () => {
    await book(staff, { doctorId: s.saraId, unitId: s.saraUnitId, time: '10:00', patientId: s.otherPatientId });
    const id = (await book(staff, { time: '12:00' })).body.appointment.id;
    expect((await staff.patch(`/appointments/${id}`, { time: '10:00', doctorId: s.externalDoctorId, unitId: s.saraUnitId })).body.error.code).toBe('UNIT_BUSY');
    expect((await staff.patch(`/appointments/${id}`, { doctorId: s.floatingDoctorId })).body.error.code).toBe('DOCTOR_NOT_AT_CLINIC');
  });

  describe('length', () => {
    it('can be extended by a doctor or an admin when the time is free', async () => {
      const id = (await book(staff)).body.appointment.id;
      const res = await doctor.patch(`/appointments/${id}`, { durationMinutes: 60 });
      expect(res.body.appointment).toMatchObject({ durationMinutes: 60, endTime: '11:00' });
      expect((await admin.patch(`/appointments/${id}`, { durationMinutes: 45 })).body.appointment.endTime).toBe('10:45');
    });

    it('cannot be extended into the next appointment', async () => {
      const id = (await book(staff)).body.appointment.id;
      await book(staff, { time: '10:30', doctorId: s.saraId, unitId: s.unitId, patientId: s.otherPatientId }); // Sara on Aya's unit
      const res = await doctor.patch(`/appointments/${id}`, { durationMinutes: 60 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('UNIT_BUSY');
      expect((await staff.get(`/appointments/${id}`)).body.appointment.durationMinutes).toBe(30);
    });

    it('cannot be changed by staff after booking', async () => {
      const id = (await book(staff)).body.appointment.id;
      const res = await staff.patch(`/appointments/${id}`, { durationMinutes: 60 });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('DURATION_RESTRICTED');
      // Sending the unchanged length alongside other changes is fine.
      expect((await staff.patch(`/appointments/${id}`, { durationMinutes: 30, time: '11:00' })).status).toBe(200);
    });

    it('is validated', async () => {
      const id = (await book(staff)).body.appointment.id;
      expect((await doctor.patch(`/appointments/${id}`, { durationMinutes: 25 })).status).toBe(400);
      expect((await doctor.patch(`/appointments/${id}`, { durationMinutes: 480, time: '20:00' })).body.error.code).toBe('ENDS_AFTER_MIDNIGHT');
    });
  });

  it.each(['completed', 'cancelled', 'no_show'])('refuses to change a %s appointment', async (status) => {
    const id = await insert({ status, date: '2026-10-01' });
    const res = await staff.patch(`/appointments/${id}`, { intended: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_EDITABLE');
  });

  it('is not available to patients, and validates', async () => {
    const id = await insert({ date: '2026-10-09' });
    expect((await patient.patch(`/appointments/${id}`, { time: '11:00' })).status).toBe(403);
    expect((await staff.patch(`/appointments/${id}`, {})).status).toBe(400);
    expect((await staff.patch(`/appointments/${id}`, { time: 'noon' })).status).toBe(400);
    expect((await staff.patch('/appointments/99999', { time: '11:00' })).status).toBe(404);
  });

  it('repairs a legacy appointment that has no unit', async () => {
    const id = await insert({ unit_id: null });
    expect((await staff.get(`/appointments/${id}`)).body.appointment.unit).toBeNull();
    expect((await staff.patch(`/appointments/${id}`, { intended: 'x' })).body.error.code).toBe('UNIT_REQUIRED');
    expect((await staff.patch(`/appointments/${id}`, { unitId: s.unitId })).body.appointment.unit.id).toBe(s.unitId);
  });
});

describe('status changes', () => {
  it('confirms a pending appointment', async () => {
    const id = (await book(staff, { status: 'pending' })).body.appointment.id;
    expect((await staff.post(`/appointments/${id}/confirm`)).body.appointment.status).toBe('confirmed');
  });

  it.each([
    ['confirm', 'confirmed'], ['confirm', 'completed'], ['confirm', 'cancelled'],
    ['cancel', 'completed'], ['cancel', 'cancelled'], ['cancel', 'no_show'],
    ['complete', 'pending'], ['complete', 'cancelled'], ['no-show', 'pending'],
  ])('refuses to %s an appointment that is %s', async (action, status) => {
    const id = await insert({ status, date: '2026-10-01' });
    const res = await admin.post(`/appointments/${id}/${action}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects unknown actions', async () => {
    expect((await staff.post(`/appointments/${await insert()}/delete`)).status).toBe(404);
  });

  it('lets only doctors and admins complete a visit', async () => {
    const id = await insert({ date: '2026-10-01', time: '10:00' });
    expect((await staff.post(`/appointments/${id}/complete`)).status).toBe(403);
    expect((await patient.post(`/appointments/${id}/complete`)).status).toBe(403);
    expect((await doctor.post(`/appointments/${id}/complete`)).body.appointment.status).toBe('completed');
  });

  it("records the patient's last visit, and never moves it backwards", async () => {
    const recent = await insert({ date: '2026-10-03', time: '09:30' });
    const older = await insert({ date: '2026-09-01', time: '09:00' });
    await doctor.post(`/appointments/${recent}/complete`);
    await doctor.post(`/appointments/${older}/complete`);
    expect((await t.db('patients').where({ id: s.patientId }).first()).last_visit).toBe('2026-10-03 09:30:00');
  });

  it("won't complete a future appointment or mark a future one as a no-show", async () => {
    const id = await insert({ date: TOMORROW });
    expect((await doctor.post(`/appointments/${id}/complete`)).body.error.code).toBe('FUTURE_APPOINTMENT');
    expect((await staff.post(`/appointments/${id}/no-show`)).body.error.code).toBe('FUTURE_APPOINTMENT');
  });

  it('marks a no-show once the time has passed', async () => {
    const id = await insert({ date: TODAY, time: '09:00' });
    expect((await staff.post(`/appointments/${id}/no-show`)).body.appointment.status).toBe('no_show');
  });

  it('cannot be applied twice concurrently', async () => {
    const id = await insert({ status: 'pending' });
    const results = await Promise.all([staff.post(`/appointments/${id}/confirm`), admin.post(`/appointments/${id}/confirm`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('logs each change with before and after', async () => {
    const id = await insert({ status: 'pending' });
    await staff.post(`/appointments/${id}/confirm`);
    const [row] = await t.db('audit_log').where({ action: 'appointment.confirm' });
    expect(JSON.parse(row.diff)).toEqual({ from: 'pending', to: 'confirmed' });
  });

  describe('a patient cancelling online', () => {
    it('can cancel their own appointment with enough notice', async () => {
      const id = await insert({ date: '2026-10-07', time: '10:00' });
      const res = await patient.post(`/appointments/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.appointment.status).toBe('cancelled');
    });

    it('is told to phone the clinic when it is too late', async () => {
      const id = await insert({ date: TOMORROW, time: '09:30' }); // 23.5 hours away
      const res = await patient.post(`/appointments/${id}/cancel`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TOO_LATE_TO_CANCEL');
      expect(await t.db('appointments').where({ id }).first()).toMatchObject({ status: 'confirmed' });
    });

    it('can cancel at exactly the notice limit', async () => {
      const id = await insert({ date: TOMORROW, time: '10:00' });
      expect((await patient.post(`/appointments/${id}/cancel`)).status).toBe(200);
    });

    it("cannot touch other people's appointments", async () => {
      const id = await insert({ patient_id: s.otherPatientId, date: '2026-10-09' });
      expect((await patient.post(`/appointments/${id}/cancel`)).status).toBe(404);
      expect((await patient.get(`/appointments/${id}`)).status).toBe(404);
    });

    it('cannot confirm, complete or mark no-shows', async () => {
      const id = await insert({ status: 'pending', date: '2026-10-09' });
      for (const action of ['confirm', 'complete', 'no-show']) expect((await patient.post(`/appointments/${id}/${action}`)).status).toBe(403);
    });
  });

  it('lets staff cancel at any time', async () => {
    const id = await insert({ date: TODAY, time: '10:30' });
    expect((await staff.post(`/appointments/${id}/cancel`)).status).toBe(200);
  });
});

describe('listing', () => {
  beforeEach(async () => {
    await insert({ date: '2026-10-06', time: '10:00', status: 'confirmed' });
    await insert({ date: '2026-10-06', time: '09:00', status: 'pending', patient_id: s.otherPatientId, doctor_id: s.saraId, unit_id: s.saraUnitId });
    await insert({ date: '2026-10-08', time: '12:00', status: 'cancelled' });
    await insert({ date: '2026-10-20', time: '12:00', status: 'completed', patient_id: s.otherPatientId });
  });

  it('is ordered by date and time, with totals, lengths and units', async () => {
    const res = await staff.get('/appointments');
    expect(res.body.meta).toEqual({ page: 1, pageSize: 50, total: 4 });
    expect(res.body.data.map((a: { date: string; time: string }) => `${a.date} ${a.time}`)).toEqual([
      '2026-10-06 09:00', '2026-10-06 10:00', '2026-10-08 12:00', '2026-10-20 12:00',
    ]);
    expect(res.body.data[0]).toMatchObject({ durationMinutes: 30, endTime: '09:30', unit: { name: "Dr Sara's unit" } });
    expect((await staff.get('/appointments?order=desc')).body.data[0].date).toBe('2026-10-20');
  });

  it('filters by date range, status, patient, doctor, unit and clinic', async () => {
    const dates = async (qs: string) => (await staff.get(`/appointments?${qs}`)).body.data.map((a: { date: string }) => a.date);
    expect(await dates('from=2026-10-07&to=2026-10-10')).toEqual(['2026-10-08']);
    expect(await dates('status=pending')).toEqual(['2026-10-06']);
    expect((await dates('status=pending,cancelled')).length).toBe(2);
    expect((await dates(`patientId=${s.otherPatientId}`)).length).toBe(2);
    expect((await dates(`doctorId=${s.saraId}`)).length).toBe(1);
    expect((await dates(`unitId=${s.unitId}`)).length).toBe(3);
    expect((await dates(`unitId=${s.saraUnitId}`)).length).toBe(1);
    expect((await dates(`clinicId=${s.clinicId}`)).length).toBe(4);
    expect((await dates(`doctorId=${s.floatingDoctorId}`)).length).toBe(0);
  });

  it('searches by patient name or phone', async () => {
    expect((await staff.get('/appointments?q=olga')).body.data).toHaveLength(2);
    expect((await staff.get('/appointments?q=70111111')).body.data).toHaveLength(2);
    expect((await staff.get('/appointments?q=olga%20patient')).body.data).toHaveLength(0);
  });

  it('paginates', async () => {
    const res = await staff.get('/appointments?pageSize=3&page=2');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(4);
  });

  it('shows a patient only their own, and without phone numbers', async () => {
    const res = await patient.get('/appointments');
    expect(res.body.meta.total).toBe(2);
    expect(res.body.data.every((a: { patientId: number }) => a.patientId === s.patientId)).toBe(true);
    expect(res.body.data[0].patient.phone).toBeUndefined();
  });

  it("cannot be widened by a patient passing someone else's id", async () => {
    const res = await patient.get(`/appointments?patientId=${s.otherPatientId}`);
    expect(res.body.data.every((a: { patientId: number }) => a.patientId === s.patientId)).toBe(true);
  });

  it('shows nothing to a patient account with no record', async () => {
    await t.db('patients').where({ id: s.patientId }).update({ user_id: null });
    expect((await patient.get('/appointments')).body.data).toEqual([]);
    await t.db('patients').where({ id: s.patientId }).update({ user_id: s.patientUserId });
  });

  it('validates filters and requires sign-in', async () => {
    expect((await staff.get('/appointments?status=bogus')).status).toBe(400);
    expect((await staff.get('/appointments?from=yesterday')).status).toBe(400);
    expect((await staff.get('/appointments?pageSize=501')).status).toBe(400);
    expect((await staff.get('/appointments?unitId=abc')).status).toBe(400);
    expect((await t.client().get('/appointments')).status).toBe(401);
  });

  it('handles a calendar-sized page', async () => {
    expect((await staff.get('/appointments?pageSize=500&from=2026-10-01&to=2026-10-31')).body.data).toHaveLength(4);
  });
});

describe('procedures and teeth on an appointment', () => {
  it('replaces the procedures', async () => {
    const id = (await book(staff, { categoryIds: [s.categoryIds[0]!] })).body.appointment.id;
    const res = await staff.send('put', `/appointments/${id}/categories`, { categoryIds: [s.categoryIds[1]!] });
    expect(res.body.appointment.categories).toEqual([{ id: s.categoryIds[1], name: 'Crown' }]);
    expect((await staff.send('put', `/appointments/${id}/categories`, { categoryIds: [] })).body.appointment.categories).toEqual([]);
    expect((await staff.send('put', `/appointments/${id}/categories`, { categoryIds: [99999] })).body.error.code).toBe('UNKNOWN_CATEGORY');
  });

  it('lets only doctors and admins record teeth', async () => {
    const id = (await book(staff)).body.appointment.id;
    const body = { teeth: [{ toothId: s.toothIds[0], description: 'Cavity' }] };
    expect((await staff.send('put', `/appointments/${id}/teeth`, body)).status).toBe(403);
    expect((await patient.send('put', `/appointments/${id}/teeth`, body)).status).toBe(403);
    const res = await doctor.send('put', `/appointments/${id}/teeth`, body);
    expect(res.body.appointment.teeth).toEqual([expect.objectContaining({ index: '18', description: 'Cavity' })]);
  });

  it('rejects unknown and duplicate teeth', async () => {
    const id = (await book(staff)).body.appointment.id;
    expect((await doctor.send('put', `/appointments/${id}/teeth`, { teeth: [{ toothId: 99999 }] })).body.error.code).toBe('UNKNOWN_TOOTH');
    expect((await doctor.send('put', `/appointments/${id}/teeth`, { teeth: [{ toothId: s.toothIds[0] }, { toothId: s.toothIds[0] }] })).status).toBe(400);
  });

  it('is refused once the appointment was cancelled', async () => {
    const id = await insert({ status: 'cancelled' });
    expect((await staff.send('put', `/appointments/${id}/categories`, { categoryIds: [] })).body.error.code).toBe('NOT_EDITABLE');
  });

  it("hides clinical tooth notes from the patient's view of an appointment", async () => {
    const id = (await book(staff)).body.appointment.id;
    await doctor.send('put', `/appointments/${id}/teeth`, { teeth: [{ toothId: s.toothIds[0], description: 'Needs root canal' }] });
    const res = await patient.get(`/appointments/${id}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('root canal');
    expect(res.body.appointment).not.toHaveProperty('teeth');
  });
});
