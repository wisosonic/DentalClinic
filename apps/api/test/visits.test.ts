import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

let t: TestApp;
let s: Seed;
let admin: Client, staff: Client, patient: Client;
let aya: Client; // owner doctor, the patient's primary doctor
let sara: Client; // another owner doctor: neither treating nor primary
let ext: Client; // external specialist who treated the patient once
let unlinked: Client; // a doctor login with no doctor profile

let medAmox: number, medIbu: number;
let ayaVisit: number; // treated by Aya
let extVisit: number; // treated by the external doctor, for Aya's patient
let olgaVisit: number; // treated by Sara, for another patient (Olga)

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
  const makeDoctorLogin = async (email: string, doctorId: number | null) => {
    const [uid] = await t.db('users').insert({ name: email, email, role: 'doctor', password: hash, ...stamp });
    if (doctorId) await t.db('doctors').where({ id: doctorId }).update({ user_id: uid });
  };
  await t.db('users').where({ email: 'doctor@clinic.test' }).first().then((u: { id: number }) => t.db('doctors').where({ id: s.doctorId }).update({ user_id: u.id }));
  await makeDoctorLogin('doctor2@clinic.test', s.saraId);
  await makeDoctorLogin('ext@clinic.test', s.externalDoctorId);
  await makeDoctorLogin('nolink@clinic.test', null);

  [admin, staff, patient, aya, sara, ext, unlinked] = await Promise.all(
    ['admin@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'doctor@clinic.test', 'doctor2@clinic.test', 'ext@clinic.test', 'nolink@clinic.test'].map((e) => loggedIn(t, e)),
  );

  medAmox = (await t.db('medications').insert({ name: 'Amoxicillin', type: 'capsule', ...stamp }))[0]!;
  medIbu = (await t.db('medications').insert({ name: 'Ibuprofen', type: 'tablet', ...stamp }))[0]!;
});
afterAll(() => t.destroy());

const visit = (extra: Record<string, unknown> = {}) =>
  t.db('appointments')
    .insert({ date: '2026-10-01', time: '10:00', duration_minutes: 30, status: 'completed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, ...extra })
    .then(([id]) => id as number);

beforeEach(async () => {
  await t.db('medication_report').del();
  await t.db('report_tooth').del();
  await t.db('reports').del();
  await t.db('appointments').del();
  await t.db('patients').update({ deleted_at: null });
  await t.db('audit_log').del();
  ayaVisit = await visit({ date: '2026-10-01', time: '10:00' });
  extVisit = await visit({ date: '2026-09-20', time: '09:00', doctor_id: s.externalDoctorId });
  olgaVisit = await visit({ date: '2026-09-10', time: '11:00', patient_id: s.otherPatientId, doctor_id: s.saraId, unit_id: s.saraUnitId });
});

const report = (id: number) => `/appointments/${id}/report`;
const write = (c: Client, id: number, body: object, part = '') => c.send('put', `${report(id)}${part}`, body);
const SECRET = 'Cavity near the nerve, root canal likely';

describe('who can read a visit report', () => {
  beforeEach(async () => {
    await write(aya, ayaVisit, { summary: 'Cleaning and check-up' });
    await write(ext, extVisit, { summary: 'Surgical extraction of tooth 38' });
  });

  it('lets the treating doctor, an admin and staff read it', async () => {
    for (const c of [aya, admin, staff]) {
      const res = await c.get(report(ayaVisit));
      expect(res.status).toBe(200);
      expect(res.body.report.summary).toBe('Cleaning and check-up');
    }
  });

  it("lets the patient's primary doctor read a report written by someone else, but not edit it", async () => {
    const res = await aya.get(report(extVisit)); // Aya is the patient's primary doctor; the external doctor treated
    expect(res.status).toBe(200);
    expect(res.body.report.summary).toBe('Surgical extraction of tooth 38');
    expect(res.body.canEdit).toBe(false);
    expect((await write(aya, extVisit, { summary: 'Rewritten' })).status).toBe(403);
  });

  it('lets the external specialist who treated the patient read and edit that visit only', async () => {
    const own = await ext.get(report(extVisit));
    expect(own.status).toBe(200);
    expect(own.body.canEdit).toBe(true);
    expect((await write(ext, extVisit, { summary: 'Updated by the specialist' })).status).toBe(200);
    // He is neither treating nor primary for Aya's own visit.
    expect((await ext.get(report(ayaVisit))).status).toBe(404);
  });

  it('hides it from every other doctor, with 404 rather than 403', async () => {
    expect((await sara.get(report(ayaVisit))).status).toBe(404);
    expect((await sara.get(report(extVisit))).status).toBe(404);
    expect((await write(sara, ayaVisit, { summary: 'Sneaky' })).status).toBe(404);
    expect((await sara.get(`${report(ayaVisit)}/pdf`)).status).toBe(404);
  });

  it('gives a doctor login without a doctor profile no access at all', async () => {
    expect((await unlinked.get(report(ayaVisit))).status).toBe(404);
    expect((await write(unlinked, ayaVisit, { summary: 'x' })).status).toBe(404);
  });

  it('lets a patient read only their own', async () => {
    expect((await patient.get(report(ayaVisit))).status).toBe(200);
    expect((await patient.get(report(extVisit))).status).toBe(200);
    expect((await patient.get(report(olgaVisit))).status).toBe(404); // another patient's visit
    expect((await patient.get(report(99999))).status).toBe(404);
  });

  it('requires sign-in and a valid id', async () => {
    expect((await t.client().get(report(ayaVisit))).status).toBe(401);
    expect((await aya.get('/appointments/abc/report')).status).toBe(400);
  });

  it('hides the report of a deleted patient', async () => {
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-01-01 00:00:00' });
    for (const c of [admin, aya, staff, patient]) expect((await c.get(report(ayaVisit))).status).toBe(404);
  });
});

describe('who can write one', () => {
  it('lets the treating doctor and an admin create and change it', async () => {
    expect((await write(aya, ayaVisit, { summary: 'First draft' })).body.report.summary).toBe('First draft');
    expect((await write(admin, ayaVisit, { summary: 'Corrected by admin' })).body.report.summary).toBe('Corrected by admin');
    expect((await write(aya, ayaVisit, { summary: 'Final' })).body.canEdit).toBe(true);
  });

  it('never lets staff or patients write, however they try', async () => {
    for (const part of ['', '/teeth', '/medications']) {
      const body = part === '' ? { summary: 'x' } : part === '/teeth' ? { teeth: [] } : { medications: [] };
      expect((await write(staff, ayaVisit, body, part)).status).toBe(403);
      expect((await write(patient, ayaVisit, body, part)).status).toBe(403);
    }
    expect(await t.db('reports').count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  it('can be edited after the visit is completed', async () => {
    expect((await t.db('appointments').where({ id: ayaVisit }).first()).status).toBe('completed');
    expect((await write(aya, ayaVisit, { summary: 'Late addition' })).status).toBe(200);
  });

  it('is also possible before the visit is finished', async () => {
    const open = await visit({ status: 'confirmed', date: '2026-10-05', time: '15:00' });
    expect((await write(aya, open, { summary: 'In progress' })).status).toBe(200);
  });

  it.each(['cancelled', 'no_show'])('refuses a report on a %s appointment', async (status) => {
    const id = await visit({ status, date: '2026-10-02' });
    const res = await write(aya, id, { summary: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_TREATED');
  });

  it('is optional: completing a visit needs no report', async () => {
    const id = await visit({ status: 'confirmed', date: '2026-10-01', time: '13:00' });
    expect((await aya.post(`/appointments/${id}/complete`)).body.appointment.status).toBe('completed');
    expect((await aya.get(report(id))).body).toEqual({ report: null, canEdit: true });
  });

  it('keeps exactly one report per appointment, even for simultaneous requests', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => write(i % 2 ? aya : admin, ayaVisit, { summary: `Draft ${i}` })));
    expect(await t.db('reports').where({ appointment_id: ayaVisit }).count({ n: '*' }).first()).toEqual({ n: 1 });
    await expect(t.db('reports').insert({ appointment_id: ayaVisit })).rejects.toThrow(/UNIQUE/);
  });

  it('validates the summary', async () => {
    expect((await write(aya, ayaVisit, { summary: 'x'.repeat(10_001) })).status).toBe(400);
    expect((await write(aya, ayaVisit, {})).status).toBe(400);
    expect((await write(aya, ayaVisit, { summary: '   ' })).body.report.summary).toBeNull(); // blank clears it
  });

  it('logs each change without logging the clinical text', async () => {
    await write(aya, ayaVisit, { summary: SECRET });
    await write(aya, ayaVisit, { teeth: [{ toothId: s.toothIds[0], occlusal: SECRET }] }, '/teeth');
    await write(aya, ayaVisit, { medications: [{ medicationId: medAmox, dose: '500 mg', frequency: 3, timeUnit: 'day', notes: SECRET }] }, '/medications');
    const log = await t.db('audit_log').where({ entity: 'appointment', entity_id: String(ayaVisit) });
    expect(log.map((l: { action: string }) => l.action)).toEqual(['report.summary', 'report.teeth', 'report.medications']);
    expect(JSON.stringify(log)).not.toContain('root canal');
  });
});

describe('tooth notes', () => {
  const notes = (extra: object = {}) => ({ teeth: [{ toothId: s.toothIds[0], occlusal: SECRET, mesial: 'Small chip', ...extra }, { toothId: s.toothIds[1], labial: 'Stain' }] });

  it('are saved per tooth and surface, dated with the visit', async () => {
    const res = await write(aya, ayaVisit, notes(), '/teeth');
    expect(res.status).toBe(200);
    expect(res.body.report.teeth).toHaveLength(2);
    expect(res.body.report.teeth[0]).toMatchObject({ toothId: s.toothIds[0], index: '18', occlusal: SECRET, mesial: 'Small chip', labial: null, date: '2026-10-01' });
  });

  it('replace the previous set', async () => {
    await write(aya, ayaVisit, notes(), '/teeth');
    const res = await write(aya, ayaVisit, { teeth: [{ toothId: s.toothIds[1], distal: 'New note' }] }, '/teeth');
    expect(res.body.report.teeth).toEqual([expect.objectContaining({ toothId: s.toothIds[1], distal: 'New note', labial: null })]);
    expect((await write(aya, ayaVisit, { teeth: [] }, '/teeth')).body.report.teeth).toEqual([]);
  });

  it('are clinic-only: staff and doctors see them, the patient never does', async () => {
    await write(aya, ayaVisit, { summary: 'Done' });
    await write(aya, ayaVisit, notes(), '/teeth');
    for (const c of [aya, admin, staff]) expect((await c.get(report(ayaVisit))).body.report.teeth).toHaveLength(2);
    const asPatient = await patient.get(report(ayaVisit));
    expect(asPatient.body.report).not.toHaveProperty('teeth');
    expect(JSON.stringify(asPatient.body)).not.toContain('root canal');
    expect(JSON.stringify(asPatient.body)).not.toContain('Small chip');
  });

  it('reject unknown or repeated teeth and malformed notes', async () => {
    expect((await write(aya, ayaVisit, { teeth: [{ toothId: 99999 }] }, '/teeth')).body.error.code).toBe('UNKNOWN_TOOTH');
    expect((await write(aya, ayaVisit, { teeth: [{ toothId: s.toothIds[0] }, { toothId: s.toothIds[0] }] }, '/teeth')).status).toBe(400);
    expect((await write(aya, ayaVisit, { teeth: [{ toothId: s.toothIds[0], mesial: 'x'.repeat(2001) }] }, '/teeth')).status).toBe(400);
    expect((await write(aya, ayaVisit, {}, '/teeth')).status).toBe(400);
  });

  it('do not create an empty report when there is nothing to save', async () => {
    expect((await write(aya, ayaVisit, { teeth: [] }, '/teeth')).body.report).toBeNull();
    expect(await t.db('reports').count({ n: '*' }).first()).toEqual({ n: 0 });
  });
});

describe('prescriptions', () => {
  const rx = (extra: object = {}) => ({ medicationId: medAmox, dose: '500 mg', frequency: 3, timeUnit: 'day', notes: 'After meals', ...extra });

  it('are written inside the report, from the medication catalog', async () => {
    const res = await write(aya, ayaVisit, { medications: [rx(), rx({ medicationId: medIbu, dose: '400 mg', frequency: 2, notes: '' })] }, '/medications');
    expect(res.status).toBe(200);
    expect(res.body.report.medications).toEqual([
      expect.objectContaining({ name: 'Amoxicillin', type: 'capsule', dose: '500 mg', frequency: 3, timeUnit: 'day', notes: 'After meals' }),
      expect.objectContaining({ name: 'Ibuprofen', dose: '400 mg', frequency: 2, notes: null }),
    ]);
  });

  it('replace the previous list, and can be cleared', async () => {
    await write(aya, ayaVisit, { medications: [rx(), rx({ medicationId: medIbu })] }, '/medications');
    expect((await write(aya, ayaVisit, { medications: [rx({ dose: '250 mg' })] }, '/medications')).body.report.medications).toHaveLength(1);
    expect((await write(aya, ayaVisit, { medications: [] }, '/medications')).body.report.medications).toEqual([]);
  });

  it('are visible to the patient, with the summary', async () => {
    await write(aya, ayaVisit, { summary: 'Antibiotics for the infection' });
    await write(aya, ayaVisit, { medications: [rx()] }, '/medications');
    const res = await patient.get(report(ayaVisit));
    expect(res.body.report).toMatchObject({ summary: 'Antibiotics for the infection', medications: [expect.objectContaining({ name: 'Amoxicillin' })] });
  });

  it.each([
    ['an unknown medication', { medicationId: 99999 }, 'UNKNOWN_MEDICATION'],
  ])('rejects %s', async (_l, extra, code) => {
    expect((await write(aya, ayaVisit, { medications: [rx(extra)] }, '/medications')).body.error.code).toBe(code);
  });

  it.each([
    ['no dose', { dose: '' }],
    ['zero times', { frequency: 0 }],
    ['too many times', { frequency: 25 }],
    ['a fractional frequency', { frequency: 1.5 }],
    ['a bad period', { timeUnit: 'decade' }],
    ['very long notes', { notes: 'x'.repeat(1001) }],
  ])('rejects %s', async (_l, extra) => {
    expect((await write(aya, ayaVisit, { medications: [rx(extra)] }, '/medications')).status).toBe(400);
  });

  it('do not create an empty report when there is nothing to save', async () => {
    expect((await write(aya, ayaVisit, { medications: [] }, '/medications')).body.report).toBeNull();
    expect(await t.db('reports').count({ n: '*' }).first()).toEqual({ n: 0 });
  });

  it('keep a medication from being deleted while it is prescribed', async () => {
    await write(aya, ayaVisit, { medications: [rx()] }, '/medications');
    const res = await admin.send('delete', `/medications/${medAmox}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MEDICATION_IN_USE');
  });
});

/** Pulls the readable text out of an uncompressed PDF (PDFKit writes text as hex strings). */
function pdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const hex = [...raw.matchAll(/<([0-9a-f]{2,})>/gi)].map((m) => m[1]!);
  // PDFKit splits words at kerning pairs, so the pieces are joined without spaces.
  return hex.map((h) => Buffer.from(h, 'hex').toString('latin1')).join('');
}

describe('the visit PDF', () => {
  const download = (c: Client, id: number) =>
    c.agent.get(`/api/v1${report(id)}/pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  beforeEach(async () => {
    await write(aya, ayaVisit, { summary: 'Scaling and polishing completed' });
    await write(aya, ayaVisit, { teeth: [{ toothId: s.toothIds[0], occlusal: SECRET }] }, '/teeth');
    await write(aya, ayaVisit, { medications: [{ medicationId: medAmox, dose: '500 mg', frequency: 3, timeUnit: 'day', notes: 'After meals' }] }, '/medications');
  });

  it('is a real PDF with the summary and prescription, for the patient and the clinic', async () => {
    for (const c of [patient, aya, staff, admin]) {
      const res = await download(c, ayaVisit);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="visit-2026-10-01-100001\.pdf"/);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe('%PDF-');
      const text = pdfText(body);
      expect(text).toContain('Scaling');
      expect(text).toContain('Amoxicillin');
      expect(text).toContain('Test Clinic');
    }
  });

  it('never contains tooth notes or internal notes, whoever asks', async () => {
    for (const c of [patient, aya, admin]) {
      const text = pdfText((await download(c, ayaVisit)).body as Buffer);
      expect(text).not.toContain('root');
      expect(text).not.toContain('Cavity');
      expect(text).not.toContain('secret note'); // the patient's internal description
    }
  });

  it('is refused to anyone who cannot read the report, and when there is none', async () => {
    expect((await download(sara, ayaVisit)).status).toBe(404);
    expect((await download(unlinked, ayaVisit)).status).toBe(404);
    expect((await download(patient, olgaVisit)).status).toBe(404);
    expect((await t.client().agent.get(`/api/v1${report(ayaVisit)}/pdf`)).status).toBe(401);
    const none = await download(aya, await visit({ date: '2026-10-02', time: '12:00' }));
    expect(none.status).toBe(404);
  });

  it('is logged', async () => {
    await download(patient, ayaVisit);
    expect(await t.db('audit_log').where({ action: 'report.pdf' })).toHaveLength(1);
  });
});

describe('the patient timeline', () => {
  beforeEach(async () => {
    await write(aya, ayaVisit, { summary: 'Cleaning' });
    await write(aya, ayaVisit, { teeth: [{ toothId: s.toothIds[0], occlusal: SECRET }] }, '/teeth');
    await write(aya, ayaVisit, { medications: [{ medicationId: medAmox, dose: '500 mg', frequency: 3, timeUnit: 'day' }] }, '/medications');
    await write(ext, extVisit, { summary: 'Extraction' });
    await visit({ status: 'cancelled', date: '2026-10-20', time: '16:00' }); // a visit with no report
  });

  const dates = (body: { data: { appointment: { date: string } }[] }) => body.data.map((e) => e.appointment.date);

  it('shows a patient their own appointments, newest first, each with its report', async () => {
    const res = await patient.get('/patients/me/timeline');
    expect(res.status).toBe(200);
    expect(dates(res.body)).toEqual(['2026-10-20', '2026-10-01', '2026-09-20']);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 50, total: 3 });
    const [cancelled, cleaning, extraction] = res.body.data;
    expect(cancelled).toMatchObject({ hasReport: false, report: null, appointment: { status: 'cancelled' } });
    expect(cleaning.report).toMatchObject({ summary: 'Cleaning', medications: [expect.objectContaining({ name: 'Amoxicillin', dose: '500 mg' })] });
    expect(extraction.report.summary).toBe('Extraction');
    expect(cleaning.appointment).toMatchObject({ time: '10:00', endTime: '10:30', doctor: { fname: 'Aya' }, clinic: { name: 'Test Clinic' } });
  });

  it('gives a patient the summary and prescriptions only, never clinical notes', async () => {
    const body = (await patient.get('/patients/me/timeline')).body;
    expect(JSON.stringify(body)).not.toContain('root canal');
    expect(JSON.stringify(body)).not.toContain('secret note');
    for (const entry of body.data) if (entry.report) expect(entry.report).not.toHaveProperty('teeth');
  });

  it('never includes another patient’s visits', async () => {
    const body = (await patient.get('/patients/me/timeline')).body;
    expect(body.data.every((e: { appointment: { id: number } }) => e.appointment.id !== olgaVisit)).toBe(true);
    expect((await patient.get(`/patients/${s.otherPatientId}/timeline`)).status).toBe(404);
  });

  it('lets the patient open their own through the staff-style URL too', async () => {
    expect((await patient.get(`/patients/${s.patientId}/timeline`)).status).toBe(200);
  });

  it('paginates', async () => {
    const res = await patient.get('/patients/me/timeline?pageSize=2&page=2');
    expect(dates(res.body)).toEqual(['2026-09-20']);
    expect(res.body.meta.total).toBe(3);
    expect((await patient.get('/patients/me/timeline?pageSize=500')).status).toBe(400);
  });

  it('shows staff and admins the full report, including tooth notes', async () => {
    for (const c of [staff, admin]) {
      const cleaning = (await c.get(`/patients/${s.patientId}/timeline`)).body.data[1];
      expect(cleaning.report.teeth).toEqual([expect.objectContaining({ occlusal: SECRET })]);
    }
  });

  it("shows the patient's primary doctor every report, and keeps a treating specialist out of the patient's timeline", async () => {
    const asAya = (await aya.get(`/patients/${s.patientId}/timeline`)).body.data;
    expect(asAya.map((e: { report: unknown }) => Boolean(e.report))).toEqual([false, true, true]); // the cancelled visit has none

    // An external specialist cannot browse another doctor's patient at all, even one he treated:
    // he reaches that visit and its report through the appointment, not through the patient.
    expect((await ext.get(`/patients/${s.patientId}/timeline`)).status).toBe(404);
    expect((await ext.get(report(extVisit))).body.report.summary).toBe('Extraction');
  });

  it('shows an unrelated doctor that reports exist but none of their content', async () => {
    const entries = (await sara.get(`/patients/${s.patientId}/timeline`)).body.data;
    expect(entries.every((e: { report: unknown }) => e.report === null)).toBe(true);
    expect(entries.filter((e: { hasReport: boolean }) => e.hasReport)).toHaveLength(2);
  });

  it('is refused for staff accounts using /me, for deleted patients and for unknown ones', async () => {
    expect((await staff.get('/patients/me/timeline')).status).toBe(403);
    expect((await admin.get('/patients/99999/timeline')).status).toBe(404);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-01-01 00:00:00' });
    expect((await admin.get(`/patients/${s.patientId}/timeline`)).status).toBe(404);
    expect((await patient.get('/patients/me/timeline')).status).toBe(404);
    expect((await t.client().get('/patients/me/timeline')).status).toBe(401);
  });
});

describe('the tooth chart', () => {
  beforeEach(async () => {
    await write(aya, ayaVisit, { teeth: [{ toothId: s.toothIds[0], occlusal: 'Cavity' }, { toothId: s.toothIds[1] }] }, '/teeth'); // second has no notes
    const later = await visit({ date: '2026-10-10', time: '09:00' });
    await write(aya, later, { teeth: [{ toothId: s.toothIds[0], mesial: 'Filling placed', occlusal: 'Cavity filled' }] }, '/teeth');
    await write(ext, extVisit, { teeth: [{ toothId: s.toothIds[1], distal: 'Wisdom tooth removed' }] }, '/teeth');
  });

  it('groups every note by tooth, oldest first, skipping teeth with no notes', async () => {
    const res = await staff.get(`/patients/${s.patientId}/chart`);
    expect(res.status).toBe(200);
    const byIndex = Object.fromEntries(res.body.data.map((x: { index: string }) => [x.index, x]));
    expect(Object.keys(byIndex).sort()).toEqual(['17', '18']);
    expect(byIndex['18'].entries.map((e: { date: string }) => e.date)).toEqual(['2026-10-01', '2026-10-10']);
    expect(byIndex['18'].entries[1]).toMatchObject({ mesial: 'Filling placed', occlusal: 'Cavity filled', doctor: { fname: 'Aya' } });
    expect(byIndex['17'].entries).toHaveLength(1); // the empty note from the first visit is not history
  });

  it('is for clinic staff only, never the patient', async () => {
    expect((await patient.get(`/patients/${s.patientId}/chart`)).status).toBe(403);
    expect((await patient.get('/patients/me/chart')).status).toBe(403);
    expect((await t.client().get(`/patients/${s.patientId}/chart`)).status).toBe(401);
  });

  it('follows the same doctor rules as reports', async () => {
    const aya1 = (await aya.get(`/patients/${s.patientId}/chart`)).body.data;
    expect(aya1.flatMap((x: { entries: unknown[] }) => x.entries)).toHaveLength(3); // primary doctor sees all three notes

    // The specialist treated one visit of this patient, but the patient is Aya's: no chart for him.
    expect((await ext.get(`/patients/${s.patientId}/chart`)).status).toBe(404);
    expect((await sara.get(`/patients/${s.patientId}/chart`)).body.data).toEqual([]);
  });

  it('returns 404 for unknown and deleted patients', async () => {
    expect((await admin.get('/patients/99999/chart')).status).toBe(404);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-01-01 00:00:00' });
    expect((await admin.get(`/patients/${s.patientId}/chart`)).status).toBe(404);
  });
});

describe('linking a doctor to a login', () => {
  const link = (c: Client, doctorId: number, userId: number | null) => c.patch(`/doctors/${doctorId}`, { userId });

  it('lets an admin link, relink and unlink', async () => {
    const user = await t.db('users').where({ email: 'doctor2@clinic.test' }).first();
    await t.db('doctors').where({ id: s.saraId }).update({ user_id: null });
    expect((await link(admin, s.saraId, user.id)).body.doctor.userId).toBe(user.id);
    expect((await sara.get(report(ayaVisit))).status).toBe(404); // linked, but still not treating or primary
    expect((await link(admin, s.saraId, null)).body.doctor.userId).toBeNull();
    await link(admin, s.saraId, user.id);
  });

  it('shows the link to admins only', async () => {
    const find = (c: Client) => c.get('/doctors').then((r) => r.body.data.find((d: { id: number }) => d.id === s.doctorId));
    expect(await find(admin)).toHaveProperty('userId');
    expect(await find(aya)).not.toHaveProperty('userId');
    expect(await find(staff)).not.toHaveProperty('userId');
  });

  it('is refused for owner doctors, even for their own profile', async () => {
    const user = await t.db('users').where({ email: 'doctor@clinic.test' }).first();
    expect((await link(aya, s.externalDoctorId, user.id)).status).toBe(403);
    expect((await link(aya, s.doctorId, null)).status).toBe(403);
  });

  it('rejects unknown users, patient logins and a login already linked elsewhere', async () => {
    expect((await link(admin, s.externalDoctorId, 99999)).body.error.code).toBe('UNKNOWN_USER');
    const pat = await t.db('users').where({ email: 'patient@clinic.test' }).first();
    expect((await link(admin, s.externalDoctorId, pat.id)).body.error.code).toBe('INVALID_USER_ROLE');
    const ayaUser = await t.db('users').where({ email: 'doctor@clinic.test' }).first();
    expect((await link(admin, s.saraId, ayaUser.id)).body.error.code).toBe('USER_ALREADY_LINKED');
  });
});
