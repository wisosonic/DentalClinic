import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Patient documents (x-ray, panoramic, CBCT report, blood analysis): images and PDF up to 25 MB, kept on the server.
 * Admin, staff and doctors upload and read (a doctor only for patients he may see in full); the uploader and admin
 * change or delete; a deleted one goes to the Trash and its file goes with it only when an admin erases it.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let extPatient: number;
let uploads = '';
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

// Just enough of each format for the server to recognise it.
const png = (extra = 'a') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR-${extra}-padding`)]);
const jpeg = (extra = 'a') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-${extra}-padding`)]);
const webp = (extra = 'a') => Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from(`VP8-${extra}`)]);
const pdf = (extra = 'a') => Buffer.from(`%PDF-1.4\n% ${extra} a small test document\n%%EOF`);

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  const [ayaUser] = await t.db('users').where({ email: 'doctor@clinic.test' }).pluck('id');
  await t.db('doctors').where({ id: s.doctorId }).update({ user_id: ayaUser });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  extPatient = (await t.db('patients').insert({ patient_identifier: 'E1', fname: 'Ext', lname: 'Pat', phone: '701', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
});
afterAll(async () => {
  await t.destroy();
  if (uploads) await rm(uploads, { recursive: true, force: true });
});
beforeEach(async () => {
  if (uploads) await rm(uploads, { recursive: true, force: true });
  uploads = await mkdtemp(path.join(tmpdir(), 'aya-documents-')); // never the real uploads folder
  t.env.UPLOAD_DIR = uploads;
  for (const table of ['patient_documents', 'appointments', 'audit_log']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
});

const stored = () => (existsSync(path.join(uploads, 'documents')) ? readdirSync(path.join(uploads, 'documents')) : []);
const upload = (c: Client, patientId: number, body: Buffer | string, extra: Record<string, string> = {}, mime = 'image/png') => {
  const qs = new URLSearchParams({ category: 'xray', title: 'Upper right', name: 'scan 1.png', ...extra });
  return c.agent.post(`/api/v1/patients/${patientId}/documents?${qs}`).set('x-csrf-token', c.csrf).set('content-type', mime).send(body);
};
const fetchFile = (c: Client, url: string) => c.agent.get(`/api/v1${url}`).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (d: Buffer) => chunks.push(d));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const make = async (c: Client = staff, patientId = s.patientId, extra: Record<string, string> = {}) => (await upload(c, patientId, png(String(Math.random())), extra)).body.document;

describe('uploading', () => {
  it('takes a PNG, JPEG, WebP or PDF, and keeps it under a random name on the server', async () => {
    const cases: [Buffer, string, string][] = [[png(), 'image/png', 'png'], [jpeg(), 'image/jpeg', 'jpg'], [webp(), 'image/webp', 'webp'], [pdf(), 'application/pdf', 'pdf']];
    for (const [i, [body, mime, ext_]] of cases.entries()) {
      const res = await upload(staff, s.patientId, body, { category: i === 3 ? 'blood_test' : 'xray', title: `File ${i}`, name: `my scan.${ext_}` }, mime);
      expect(res.status, ext_).toBe(201);
      expect(res.body.document).toMatchObject({ patientId: s.patientId, title: `File ${i}`, mime, sizeBytes: body.length, isImage: mime !== 'application/pdf', fileName: `my scan.${ext_}`, canChange: true });
    }
    const names = stored();
    expect(names).toHaveLength(4);
    for (const n of names) expect(n).toMatch(/^doc-[a-f0-9]{12}\.(png|jpg|webp|pdf)$/); // random, never the person's name
    const row = await t.db('patient_documents').orderBy('id').first();
    expect(readFileSync(path.join(uploads, 'documents', row.file_name))).toEqual(png());
    expect(row).toMatchObject({ uploaded_by: (await t.db('users').where({ email: 'staff@clinic.test' }).first('id')).id, category: 'xray' });
    expect(row.sha256).toHaveLength(64);
  });

  it('knows a file by its bytes, not its name or the type the browser claims', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg> padding padding');
    const html = Buffer.from('<html><script>alert(1)</script></html> padding padding padding');
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40)]);
    for (const [body, mime] of [[svg, 'image/png'], [html, 'image/png'], [exe, 'application/pdf'], [Buffer.from('%PDF-'), 'application/pdf'], [Buffer.from('hello hello hello hello'), 'image/jpeg']] as [Buffer, string][]) {
      const res = await upload(staff, s.patientId, body, {}, mime);
      expect(res.status, mime).toBe(400);
      expect(res.body.error.code).toBe('INVALID_FILE');
    }
    expect((await upload(staff, s.patientId, svg, {}, 'image/svg+xml')).body.error.code).toBe('INVALID_FILE'); // a type that is not even accepted
    expect((await upload(staff, s.patientId, Buffer.alloc(0))).body.error.code).toBe('INVALID_FILE');
    expect(stored()).toEqual([]);
    expect(await t.db('patient_documents').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it('refuses a file over 25 MB', async () => {
    const big = Buffer.concat([png(), Buffer.alloc(25 * 1024 * 1024)]);
    const res = await upload(staff, s.patientId, big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(stored()).toEqual([]);
  });

  it('asks for what kind of document it is and a title, and checks the date and the visit', async () => {
    expect((await upload(staff, s.patientId, png(), { title: '' })).status).toBe(400);
    expect((await upload(staff, s.patientId, png(), { category: 'selfie' })).status).toBe(400);
    expect((await upload(staff, s.patientId, png(), { takenOn: 'yesterday' })).status).toBe(400);
    expect((await upload(staff, s.patientId, png(), { appointmentId: '99999' })).body.error.code).toBe('UNKNOWN_APPOINTMENT');
    const [other] = await t.db('appointments').insert({ date: '2026-10-01', time: '10:00', status: 'completed', patient_id: s.otherPatientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp });
    expect((await upload(staff, s.patientId, png(), { appointmentId: String(other) })).body.error.code).toBe('UNKNOWN_APPOINTMENT'); // another patient's visit
    const [mine] = await t.db('appointments').insert({ date: '2026-10-02', time: '10:00', status: 'completed', patient_id: s.patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp });
    const ok = await upload(staff, s.patientId, png('x'), { appointmentId: String(mine), takenOn: '2026-10-02', note: 'Before the crown' });
    expect(ok.status).toBe(201);
    expect(ok.body.document).toMatchObject({ takenOn: '2026-10-02', note: 'Before the crown', appointment: { id: mine, date: '2026-10-02', time: '10:00' } });
    expect((await make()).takenOn).toBe(NOW.toISOString().slice(0, 10)); // defaults to the upload day
  });

  it('warns about the same file twice for one patient, unless told to go ahead, and stops at 200', async () => {
    const same = png('same');
    expect((await upload(staff, s.patientId, same)).status).toBe(201);
    const again = await upload(staff, s.patientId, same);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_DOCUMENT');
    expect((await upload(staff, s.patientId, same, { allowDuplicate: '1' })).status).toBe(201);
    expect((await upload(staff, s.otherPatientId, same)).status).toBe(201); // another patient's copy is fine
    const rows = Array.from({ length: 198 }, (_, i) => ({ patient_id: s.patientId, category: 'other', title: `n${i}`, file_name: `doc-${String(i).padStart(12, '0')}.png`, original_name: 'x.png', mime: 'image/png', size_bytes: 1, sha256: `s${i}`, ...stamp }));
    await t.db.batchInsert('patient_documents', rows, 50);
    const over = await upload(staff, s.patientId, png('one more'));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('TOO_MANY_DOCUMENTS');
  });

  it('is for admin, staff and doctors, and for a doctor only the patients he may see in full', async () => {
    for (const c of [admin, staff, aya]) expect((await upload(c, s.patientId, png(String(Math.random())))).status).toBe(201);
    expect((await upload(patient, s.patientId, png())).status).toBe(403);
    expect((await upload(t.client(), s.patientId, png())).status).toBeGreaterThanOrEqual(401);
    expect((await upload(ext, extPatient, png('e'))).status).toBe(201); // an outside specialist, for his own patient
    expect((await upload(ext, s.patientId, png('f'))).status).toBe(404); // not for an owner's patient, even one he treats
    expect((await upload(aya, extPatient, png('g'))).status).toBe(201); // owners work clinic-wide
    expect((await upload(staff, 999999, png('h'))).status).toBe(404);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await upload(staff, s.patientId, png('i'))).status).toBe(404); // a deleted patient
  });
});

describe('reading', () => {
  it('lists a patient’s documents, newest first, with filters, and who may change each', async () => {
    const a = await make(staff, s.patientId, { title: 'Alpha scan' });
    const b = (await upload(aya, s.patientId, pdf(), { category: 'blood_test', title: 'Blood results' }, 'application/pdf')).body.document;
    const list = async (c: Client, qs = '') => (await c.get(`/patients/${s.patientId}/documents${qs}`)).body;
    expect((await list(admin)).data.map((d: { id: number }) => d.id)).toEqual([b.id, a.id]);
    expect((await list(staff)).meta.total).toBe(2);
    expect((await list(admin, '?category=blood_test')).data.map((d: { id: number }) => d.id)).toEqual([b.id]);
    expect((await list(admin, '?q=alpha')).data.map((d: { id: number }) => d.id)).toEqual([a.id]);
    expect((await list(admin, '?category=nonsense')).data).toBeUndefined();
    const forStaff = (await list(staff)).data;
    expect(forStaff.find((d: { id: number }) => d.id === a.id).canChange).toBe(true); // his own
    expect(forStaff.find((d: { id: number }) => d.id === b.id).canChange).toBe(false);
    expect((await list(admin)).data.every((d: { canChange: boolean }) => d.canChange)).toBe(true);
    expect((await patient.get(`/patients/${s.patientId}/documents`)).status).toBe(403);
    expect((await t.client().get(`/patients/${s.patientId}/documents`)).status).toBe(401);
  });

  it('keeps an outside specialist away from an owner’s patient’s documents, and out of anyone else’s list', async () => {
    const mine = await make(admin, s.patientId);
    expect((await ext.get(`/patients/${s.patientId}/documents`)).status).toBe(404);
    expect((await ext.get(`/documents/${mine.id}/file`)).status).toBe(404);
    expect((await ext.patch(`/documents/${mine.id}`, { title: 'x' })).status).toBe(404);
    expect((await ext.send('delete', `/documents/${mine.id}`)).status).toBe(404);
    const his = await make(ext, extPatient);
    expect((await ext.get(`/patients/${extPatient}/documents`)).body.data.map((d: { id: number }) => d.id)).toEqual([his.id]);
  });

  it('serves the file to people who may see it, with headers that keep it from running or being cached', async () => {
    const doc = await make(staff, s.patientId, { title: 'Pic' });
    const res = await fetchFile(aya, `/documents/${doc.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="xray-\d{4}-\d{2}-\d{2}\.png"$/); // never the original name
    expect((res.body as Buffer).subarray(0, 8)).toEqual(png().subarray(0, 8));
    const p = (await upload(staff, s.patientId, pdf(), { category: 'cbct', title: 'Report' }, 'application/pdf')).body.document;
    const pdfRes = await fetchFile(admin, `/documents/${p.id}/file`);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.headers['content-security-policy'] ?? '').not.toContain('sandbox'); // a sandbox would stop the browser's own PDF viewer
    expect((await fetchFile(patient, `/documents/${doc.id}/file`)).status).toBe(403);
    expect((await fetchFile(t.client(), `/documents/${doc.id}/file`)).status).toBe(401);
    expect((await fetchFile(admin, '/documents/99999/file')).status).toBe(404);
  });

  it('never follows a stored name outside the documents folder', async () => {
    const doc = await make(staff);
    await t.db('patient_documents').where({ id: doc.id }).update({ file_name: '../../etc/passwd' });
    expect((await fetchFile(admin, `/documents/${doc.id}/file`)).status).toBe(404);
  });

  it('gives a file that has gone missing from the disk a plain 404', async () => {
    const doc = await make(staff);
    await rm(path.join(uploads, 'documents'), { recursive: true, force: true });
    expect((await fetchFile(admin, `/documents/${doc.id}/file`)).status).toBe(404);
  });
});

describe('changing and deleting', () => {
  it('lets the uploader and admin change the details, and nobody else', async () => {
    const doc = await make(staff);
    const res = await staff.patch(`/documents/${doc.id}`, { title: 'Renamed', category: 'panoramic', takenOn: '2026-09-30', note: 'Left side' });
    expect(res.body.document).toMatchObject({ title: 'Renamed', category: 'panoramic', takenOn: '2026-09-30', note: 'Left side' });
    expect((await admin.patch(`/documents/${doc.id}`, { title: 'By admin' })).status).toBe(200);
    expect((await aya.patch(`/documents/${doc.id}`, { title: 'By doctor' })).status).toBe(403);
    expect((await patient.patch(`/documents/${doc.id}`, { title: 'x' })).status).toBe(403);
    expect((await staff.patch(`/documents/${doc.id}`, {})).status).toBe(400);
    expect((await staff.patch(`/documents/${doc.id}`, { category: 'selfie' })).status).toBe(400);
    expect((await staff.patch(`/documents/${doc.id}`, { appointmentId: 99999 })).body.error.code).toBe('UNKNOWN_APPOINTMENT');
    expect((await staff.patch(`/documents/${doc.id}`, { note: '' })).body.document.note).toBeNull();
  });

  it('moves a deleted document to the Trash, keeps its file, and lets only the uploader or admin delete', async () => {
    const doc = await make(staff);
    expect((await aya.send('delete', `/documents/${doc.id}`)).status).toBe(403);
    expect((await staff.send('delete', `/documents/${doc.id}`)).status).toBe(204);
    expect((await staff.send('delete', `/documents/${doc.id}`)).status).toBe(404); // already gone
    expect((await admin.get(`/patients/${s.patientId}/documents`)).body.data).toEqual([]);
    expect((await fetchFile(admin, `/documents/${doc.id}/file`)).status).toBe(404);
    expect(stored()).toHaveLength(1); // the file waits in the Trash with the record
    const row = await t.db('patient_documents').where({ id: doc.id }).first();
    expect(row.deleted_at).toBeTruthy();
    expect(row.deleted_by).toBeTruthy();
  });
});

describe('the Trash and permanent erase', () => {
  const purge = (id: number, confirm: string) => admin.agent.delete(`/api/v1/trash/document/${id}`).set('x-csrf-token', admin.csrf).send({ confirm });

  it('lists it, restores it (after its patient), and erases it with its file only after the patient’s name is typed', async () => {
    const doc = await make(staff, s.patientId, { title: 'Pic' });
    await staff.send('delete', `/documents/${doc.id}`);
    const item = (await admin.get('/trash?kind=document')).body.data[0];
    expect(item).toMatchObject({ kind: 'document', id: doc.id, label: 'Pat Patient', blockedBy: null, deletedBy: 'Sam Staff' });
    expect((await admin.post(`/trash/document/${doc.id}/restore`)).status).toBe(204);
    expect((await admin.get(`/patients/${s.patientId}/documents`)).body.data).toHaveLength(1);

    await staff.send('delete', `/documents/${doc.id}`);
    expect((await admin.get(`/trash/document/${doc.id}/impact`)).body.counts).toMatchObject({ documents: 1 });
    expect((await purge(doc.id, 'Wrong Name')).body.error.code).toBe('CONFIRM_MISMATCH');
    expect(stored()).toHaveLength(1);
    expect((await purge(doc.id, 'pat patient')).status).toBe(204);
    expect(await t.db('patient_documents').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect(stored()).toEqual([]); // the file is gone too
    expect((await aya.get('/trash')).status).toBe(403);
  });

  it('needs the patient restored first', async () => {
    const doc = await make(staff);
    await staff.send('delete', `/documents/${doc.id}`);
    await staff.send('delete', `/patients/${s.patientId}`);
    expect((await admin.get('/trash?kind=document')).body.data[0].blockedBy).toBe('patient');
    expect((await admin.post(`/trash/document/${doc.id}/restore`)).body.error.code).toBe('RESTORE_PATIENT_FIRST');
  });

  it('erases a patient’s documents and their files with the patient, and says how many', async () => {
    const gone = (await t.db('patients').insert({ patient_identifier: 'Z9', fname: 'Zed', lname: 'Gone', phone: '799', doctor_id: s.doctorId, ...stamp }))[0]!;
    await make(staff, gone);
    await make(staff, gone);
    await make(admin, s.otherPatientId);
    await staff.send('delete', `/patients/${gone}`);
    expect((await admin.get(`/trash/patient/${gone}/impact`)).body.counts).toMatchObject({ patients: 1, documents: 2 });
    const res = await admin.agent.delete(`/api/v1/trash/patient/${gone}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Zed Gone' });
    expect(res.status).toBe(204);
    expect(await t.db('patient_documents').count({ n: '*' }).first()).toMatchObject({ n: 1 }); // the other patient's stays
    expect(stored()).toHaveLength(1);
  });
});

describe('the activity log', () => {
  it('records who uploaded, changed, deleted and opened what, by id and size only, never names, titles or notes', async () => {
    const up = await upload(staff, s.patientId, png(), { title: 'Secret title', note: 'Secret note', name: 'secret name.png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const doc = up.body.document;
    await staff.patch(`/documents/${doc.id}`, { title: 'Another secret' });
    await admin.get(`/patients/${s.patientId}/documents`);
    await fetchFile(admin, `/documents/${doc.id}/file`);
    await staff.send('delete', `/documents/${doc.id}`);
    const rows = await t.db('audit_log').whereIn('action', ['document.upload', 'document.update', 'document.delete', 'document.view']).orderBy('id');
    expect(rows.map((r) => r.action)).toEqual(['document.upload', 'document.update', 'document.view', 'document.delete']); // one view: the list and the file are one visit
    expect(JSON.parse(rows[0]!.diff)).toMatchObject({ patientId: s.patientId, category: 'xray', bytes: png().length });
    expect(JSON.stringify(rows)).not.toMatch(/secret/i);
  });
});
