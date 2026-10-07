import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * The patient portal (phase 8): what a patient sees of their own record. Everything is for a patient login and
 * limited to the record linked to it; it is view only, and never shows costs, internal notes or other people's data.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, pat: Client, other: Client;
let otherPatientWithLogin: number;
let uploads = '';
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Olga Other', email: 'olga@clinic.test', role: 'patient', password: hash, ...stamp });
  otherPatientWithLogin = (await t.db('patients').insert({ patient_identifier: '100003', fname: 'Nora', lname: 'Neighbour', phone: '70333333', user_id: uid, doctor_id: s.doctorId, ...stamp }))[0]!;
  const [ayaUser] = await t.db('users').where({ email: 'doctor@clinic.test' }).pluck('id');
  await t.db('doctors').where({ id: s.doctorId }).update({ user_id: ayaUser });
  [admin, aya, staff, pat, other] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'olga@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(async () => {
  await t.destroy();
  if (uploads) await rm(uploads, { recursive: true, force: true });
});
beforeEach(async () => {
  if (uploads) await rm(uploads, { recursive: true, force: true });
  uploads = await mkdtemp(path.join(tmpdir(), 'aya-portal-'));
  t.env.UPLOAD_DIR = uploads;
  for (const table of ['patient_documents', 'payments', 'offer_items', 'treatment_offers', 'report_tooth', 'medication_report', 'reports', 'appointment_category', 'appointments', 'audit_log']) await t.db(table).del();
});

const appointment = async (patientId: number, extra: Record<string, unknown> = {}) =>
  (await t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp, ...extra }))[0]!;
const offer = async (patientId: number, extra: Record<string, unknown> = {}, items: [string, number, number][] = [['Crown', 300, 120]]) => {
  const id = (await t.db('treatment_offers').insert({ patient_id: patientId, title: 'Rehabilitation', description: 'Upper jaw', notes: 'internal: nervous patient', type: 'clinic', price: items.reduce((x, i) => x + i[1], 0), cost: 120, currency: '$', status: 'accepted', ...stamp, ...extra }))[0]!;
  for (const [i, [description, price, cost]] of items.entries()) await t.db('offer_items').insert({ offer_id: id, description, price, cost, sequence: i, status: 'pending', tooth_id: i === 0 ? s.toothIds[0] : null, ...stamp });
  return id;
};
const pay = async (offerId: number, amount: number, extra: Record<string, unknown> = {}) =>
  (await t.db('payments').insert({ date: TODAY, type: 'clinic', amount, remaining: 0, currency: '$', method: 'cash', description: 'internal: paid in coins', offer_id: offerId, collected_by_doctor_id: s.doctorId, dr_part: 100, ...stamp, ...extra }))[0]!;
const binary = (c: Client, url: string) => c.agent.get(`/api/v1${url}`).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (d: Buffer) => chunks.push(d));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const words = (res: { body: unknown }) => {
  const raw = (res.body as Buffer).toString('latin1');
  const lines: string[] = [raw.slice(0, 8)];
  for (const arr of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) lines.push([...arr[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join(''));
  return lines.join('\n');
};
const everything = (body: unknown) => JSON.stringify(body);

describe('who may use it', () => {
  it('is for patients only: staff, doctors and admins are refused, and so is a visitor', async () => {
    for (const url of ['/portal/overview', '/portal/upcoming', '/portal/offers', '/portal/payments', '/portal/documents']) {
      expect((await pat.get(url)).status, url).toBe(200);
      for (const [name, c] of [['admin', admin], ['doctor', aya], ['staff', staff]] as const) expect((await c.get(url)).status, `${name} ${url}`).toBe(403);
      expect([401, 403], url).toContain((await t.client().get(url)).status);
    }
  });

  it('says so when a login is not linked to a patient record', async () => {
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await t.db('users').insert({ name: 'Orphan', email: 'orphan@clinic.test', role: 'patient', password: hash, ...stamp });
    const orphan = await loggedIn(t, 'orphan@clinic.test');
    expect((await orphan.get('/portal/overview')).status).toBe(404);
    await t.db('users').where({ email: 'orphan@clinic.test' }).del();
  });
});

describe('the overview', () => {
  it('shows the patient, the next appointment, and the balance over the offers they agreed to', async () => {
    await t.db('patients').where({ id: s.patientId }).update({ username: 'pat.patient' });
    await appointment(s.patientId, { time: '15:00', intended: 'Check-up' });
    await appointment(s.patientId, { date: '2026-10-09', time: '09:00' });
    const o1 = await offer(s.patientId);
    await pay(o1, 100);
    const o2 = await offer(s.patientId, { title: 'Whitening' }, [['Whitening', 150, 20]]);
    await pay(o2, 150);
    await offer(s.patientId, { status: 'draft', title: 'Not agreed yet' }, [['Implant', 900, 400]]); // a draft is not binding
    await offer(s.patientId, { status: 'cancelled', title: 'Cancelled' }, [['Bridge', 500, 200]]);
    await offer(otherPatientWithLogin, { title: 'Someone else' }, [['Filling', 70, 10]]);
    const res = await pat.get('/portal/overview');
    expect(res.status).toBe(200);
    expect(res.body.patient).toEqual({ id: s.patientId, fname: 'Pat', lname: 'Patient', patientIdentifier: '100001', username: 'pat.patient', doctor: { fname: 'Aya', lname: 'Ghali' } });
    expect(res.body.next).toMatchObject({ date: TOMORROW, time: '15:00', doctor: { fname: 'Aya', lname: 'Ghali' }, clinic: { name: 'Test Clinic' } });
    expect(res.body.upcomingCount).toBe(2);
    expect(res.body.balance).toEqual({ price: 450, paid: 250, remaining: 200, currency: '$' });
    expect(res.body.cancelMinHours).toBe(24);
    expect(res.body.documentsCount).toBe(0);
  });

  it('is empty for a patient with nothing yet', async () => {
    const res = await other.get('/portal/overview');
    expect(res.body).toMatchObject({ next: null, upcomingCount: 0, balance: { price: 0, paid: 0, remaining: 0 }, documentsCount: 0 });
  });
});

describe('upcoming appointments', () => {
  it('lists the ones still on, soonest first, and whether they can still be cancelled online', async () => {
    const far = await appointment(s.patientId, { date: '2026-10-08', time: '10:00' }); // about three days away
    const soon = await appointment(s.patientId, { date: TODAY, time: '14:00', status: 'pending' }); // four hours away: too late to cancel
    await t.db('appointment_category').insert({ appointment_id: far, category_id: s.categoryIds[0], ...stamp });
    await appointment(s.patientId, { date: TODAY, time: '08:00' }); // already started
    await appointment(s.patientId, { date: '2026-10-07', status: 'cancelled' });
    await appointment(s.patientId, { date: '2026-10-07', time: '11:00', status: 'completed' });
    await appointment(s.patientId, { date: '2026-10-07', time: '12:00', deleted_at: '2026-10-05 05:00:00' });
    await appointment(otherPatientWithLogin, { date: '2026-10-07', time: '13:00' });
    const res = await pat.get('/portal/upcoming');
    expect(res.body.data.map((a: { id: number }) => a.id)).toEqual([soon, far]);
    expect(res.body.data[0]).toMatchObject({ status: 'pending', canCancel: false, cancelUntil: '2026-10-04 14:00', endTime: '14:30', durationMinutes: 30 });
    expect(res.body.data[1]).toMatchObject({ canCancel: true, cancelUntil: '2026-10-07 10:00', procedures: ['Scaling'], clinic: { name: 'Test Clinic' } });
  });

  it('shows no phone numbers, notes or other people', async () => {
    await appointment(s.patientId, { intended: 'Check-up' });
    const text = everything((await pat.get('/portal/upcoming')).body);
    for (const leaked of ['secret note', '70111111', 'phone":"111', 'description', 'userId']) expect(text, leaked).not.toContain(leaked);
  });

  it('can be cancelled by the patient with notice, and not too late (the usual appointments route)', async () => {
    const far = await appointment(s.patientId, { date: '2026-10-08' });
    const soon = await appointment(s.patientId, { date: TODAY, time: '14:00' });
    expect((await pat.post(`/appointments/${soon}/cancel`)).status).toBe(409);
    expect((await pat.post(`/appointments/${far}/cancel`)).status).toBe(200);
    expect((await pat.get('/portal/upcoming')).body.data.map((a: { id: number }) => a.id)).toEqual([soon]);
    const theirs = await appointment(otherPatientWithLogin, { date: '2026-10-08' });
    expect((await pat.post(`/appointments/${theirs}/cancel`)).status).toBe(404); // someone else's looks like none
  });
});

describe('treatment offers', () => {
  it('lists the agreed ones with their items, prices and progress, and never a cost, a note or a draft', async () => {
    const id = await offer(s.patientId, {}, [['Crown', 300, 120], ['Check', 50, 5]]);
    await t.db('offer_items').where({ offer_id: id, description: 'Check' }).update({ status: 'done' });
    const visit = await appointment(s.patientId, { time: '16:00' });
    await t.db('offer_items').where({ offer_id: id, description: 'Crown' }).update({ status: 'scheduled', appointment_id: visit });
    await pay(id, 100);
    await offer(s.patientId, { status: 'draft', title: 'Draft' });
    await offer(otherPatientWithLogin, { title: 'Theirs' });
    const res = await pat.get('/portal/offers');
    expect(res.body.data).toHaveLength(1);
    const o = res.body.data[0];
    expect(o).toMatchObject({ id, title: 'Rehabilitation', description: 'Upper jaw', price: 350, paid: 100, remaining: 250, paymentState: 'partly_paid', workState: 'in_progress', progress: { done: 1, total: 2, percent: 50 }, doctor: { fname: 'Aya', lname: 'Ghali' } });
    expect(o.items).toEqual([
      { id: expect.any(Number), sequence: 0, description: 'Crown', tooth: '18', price: 300, status: 'scheduled', visit: { date: TOMORROW, time: '16:00' } },
      { id: expect.any(Number), sequence: 1, description: 'Check', tooth: null, price: 50, status: 'done', visit: null },
    ]);
    const text = everything(res.body);
    for (const leaked of ['"cost"', 'internal: nervous', 'notes', 'Not agreed', 'Theirs']) expect(text, leaked).not.toContain(leaked);
  });

  it('gives a printable offer, without the cost or the internal notes, and only for their own', async () => {
    const id = await offer(s.patientId);
    const res = await binary(pat, `/portal/offers/${id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
    const text = words(res);
    for (const part of ['Rehabilitation', 'Crown', 'Pat Patient', 'Upper jaw']) expect(text, part).toContain(part);
    for (const leaked of ['120', 'nervous']) expect(text, leaked).not.toContain(leaked);
    const theirs = await offer(otherPatientWithLogin);
    expect((await binary(pat, `/portal/offers/${theirs}/pdf`)).status).toBe(404);
    const draft = await offer(s.patientId, { status: 'draft' });
    expect((await binary(pat, `/portal/offers/${draft}/pdf`)).status).toBe(404);
    expect((await t.db('audit_log').where({ action: 'offer.pdf' })).length).toBe(1);
  });
});

describe('payments', () => {
  it('lists the patient’s own payments, newest first, with the balance after each, and nothing internal', async () => {
    const o = await offer(s.patientId);
    const first = await pay(o, 100, { date: '2026-10-01', remaining: 200 });
    const second = await pay(o, 50, { date: '2026-10-03', remaining: 150 });
    await pay(o, 999, { type: 'commission', offer_id: null, model_id: s.externalDoctorId });
    await pay(o, 5, { deleted_at: '2026-10-04 05:00:00' });
    await pay(await offer(otherPatientWithLogin), 70);
    const res = await pat.get('/portal/payments');
    expect(res.body.data.map((p: { id: number }) => p.id)).toEqual([second, first]);
    expect(res.body.data[0]).toEqual({ id: second, date: '2026-10-03', amount: 50, currency: '$', method: 'cash', offerId: o, offerTitle: 'Rehabilitation', remaining: 150 });
    const text = everything(res.body);
    for (const leaked of ['internal', 'dr_part', 'drPart', 'collected', 'created']) expect(text, leaked).not.toContain(leaked);
  });

  it('gives a receipt for their own payment, without who took it or the clinic’s note, and refuses anyone else’s', async () => {
    const o = await offer(s.patientId);
    const id = await pay(o, 100, { remaining: 200 });
    const res = await binary(pat, `/portal/payments/${id}/receipt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const text = words(res);
    for (const part of ['Pat Patient', 'Rehabilitation', '100.00']) expect(text, part).toContain(part);
    for (const leaked of ['internal', 'Received by', 'Dr Aya']) expect(text, leaked).not.toContain(leaked);
    const theirs = await pay(await offer(otherPatientWithLogin), 70);
    expect((await binary(pat, `/portal/payments/${theirs}/receipt`)).status).toBe(404);
    const deleted = await pay(o, 1, { deleted_at: '2026-10-04 05:00:00' });
    expect((await binary(pat, `/portal/payments/${deleted}/receipt`)).status).toBe(404);
  });
});

describe('documents', () => {
  const real = (w = 400, h = 300) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 90, b: 160 } } }).png().toBuffer();
  const add = async (patientId: number, extra: Record<string, unknown> = {}, body?: Buffer) => {
    const name = `doc-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}.png`;
    await mkdir(path.join(uploads, 'documents'), { recursive: true });
    await writeFile(path.join(uploads, 'documents', name), body ?? (await real()));
    const id = (await t.db('patient_documents').insert({ patient_id: patientId, category: 'xray', title: 'Upper jaw', note: 'internal: looks tricky', taken_on: '2026-10-01', file_name: name, original_name: 'pat patient scan.png', mime: 'image/png', size_bytes: 100, sha256: Math.random().toString(16).slice(2).padEnd(64, '0'), patient_visible: true, ...stamp, ...extra }))[0]!;
    return id;
  };

  it('lists only the documents marked visible to the patient, without notes or file names', async () => {
    const shown = await add(s.patientId);
    await add(s.patientId, { title: 'Hidden', patient_visible: false });
    await add(s.patientId, { title: 'Deleted', deleted_at: '2026-10-04 05:00:00' });
    await add(otherPatientWithLogin, { title: 'Theirs' });
    const res = await pat.get('/portal/documents');
    expect(res.body.data).toEqual([{ id: shown, category: 'xray', title: 'Upper jaw', takenOn: '2026-10-01', mime: 'image/png', sizeBytes: 100, isImage: true }]);
    const text = everything(res.body);
    for (const leaked of ['internal', 'tricky', 'scan.png', 'doc-', 'sha256', 'Hidden', 'Theirs']) expect(text, leaked).not.toContain(leaked);
    expect((await pat.get('/portal/overview')).body.documentsCount).toBe(1);
  });

  it('opens a shared document with the protective headers, and never a hidden, deleted or someone else’s', async () => {
    const shown = await add(s.patientId);
    const hidden = await add(s.patientId, { patient_visible: false });
    const deleted = await add(s.patientId, { deleted_at: '2026-10-04 05:00:00' });
    const theirs = await add(otherPatientWithLogin);
    const res = await binary(pat, `/portal/documents/${shown}/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="xray-2026-10-01\.png"$/); // never the original name
    for (const id of [hidden, deleted, theirs, 99999]) expect((await binary(pat, `/portal/documents/${id}/file`)).status, String(id)).toBe(404);
    expect((await t.db('audit_log').where({ action: 'document.view' })).length).toBe(0); // a patient looking at their own record is not logged, as elsewhere
  });

  it('shows a preview of a shared picture, and refuses it for the same documents', async () => {
    const shown = await add(s.patientId);
    const hidden = await add(s.patientId, { patient_visible: false });
    const res = await binary(pat, `/portal/documents/${shown}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect((await binary(pat, `/portal/documents/${hidden}/thumbnail`)).status).toBe(404);
    expect((await binary(other, `/portal/documents/${shown}/thumbnail`)).status).toBe(404);
  });

  it('does not change what the clinic’s own document routes allow a patient (still nothing)', async () => {
    const shown = await add(s.patientId);
    expect((await pat.get(`/patients/${s.patientId}/documents`)).status).toBe(403);
    expect((await binary(pat, `/documents/${shown}/file`)).status).toBe(403);
  });
});

describe('visits and reports (the routes that already existed)', () => {
  it('gives the patient their own visit summary PDF and report, and nobody else’s', async () => {
    const mine = await appointment(s.patientId, { date: '2026-10-01', status: 'completed' });
    const theirs = await appointment(otherPatientWithLogin, { date: '2026-10-01', status: 'completed' });
    await t.db('reports').insert({ appointment_id: mine, summary: 'Cleaned and polished.', ...stamp });
    await t.db('reports').insert({ appointment_id: theirs, summary: 'Secret of Nora.', ...stamp });
    const pdf = await binary(pat, `/appointments/${mine}/report/pdf`);
    expect(pdf.status).toBe(200);
    expect(words(pdf)).toContain('Cleaned and polished');
    expect((await binary(pat, `/appointments/${theirs}/report/pdf`)).status).toBe(404);
    const timeline = (await pat.get('/patients/me/timeline')).body.data as { appointment: { id: number }; report: { summary: string } | null }[];
    expect(timeline.map((e) => e.appointment.id)).toEqual([mine]);
    expect(timeline[0]!.report!.summary).toBe('Cleaned and polished.');
  });
});
