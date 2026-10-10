import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Comments, tags and annotations on documents (owner request 2026-10-09): clinic collaboration around a document.
 * Anyone who may open it adds them; their author (and for deleting, an admin) changes them; tags and marks are for
 * pictures only; patients never see any of it; the log holds ids and counts, never the words.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let extPatient: number;
let uploads = '';
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

const png = (extra: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR-${extra}-padding`)]);
const pdf = (extra: string) => Buffer.from(`%PDF-1.4\n% ${extra} a small test document\n%%EOF`);

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: bcrypt.hashSync(PASSWORD, 4), ...stamp });
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
  uploads = await mkdtemp(path.join(tmpdir(), 'aya-docnotes-'));
  t.env.UPLOAD_DIR = uploads;
  for (const table of ['document_comments', 'document_tags', 'document_annotations', 'patient_documents', 'audit_log']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
});

const upload = (c: Client, patientId: number, body: Buffer, mime: string) => {
  const qs = new URLSearchParams({ category: 'xray', title: 'Upper right', name: 'scan.png' });
  return c.agent.post(`/api/v1/patients/${patientId}/documents?${qs}`).set('x-csrf-token', c.csrf).set('content-type', mime).send(body);
};
const picture = async (c: Client = staff, patientId = s.patientId) => (await upload(c, patientId, png(String(Math.random())), 'image/png')).body.document;
const paper = async (c: Client = staff) => (await upload(c, s.patientId, pdf(String(Math.random())), 'application/pdf')).body.document;
const del = (c: Client, url: string) => c.send('delete', url);
const pin = { kind: 'pin', x: 0.4, y: 0.5, label: 'Caries under the filling' };
const box = { kind: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.25, label: 'Bone loss' };

describe('comments', () => {
  it('lets anyone who can open the document add one, oldest first, with who wrote it', async () => {
    const doc = await picture(staff);
    const first = await staff.post(`/documents/${doc.id}/comments`, { body: '  Compare with last year  ' });
    expect(first.status).toBe(201);
    expect(first.body.comment).toMatchObject({ body: 'Compare with last year', author: { name: 'Sam Staff' }, edited: false, canEdit: true, canDelete: true });
    await aya.post(`/documents/${doc.id}/comments`, { body: 'Looks like the 36' }); // not the uploader: still allowed
    const list = (await admin.get(`/documents/${doc.id}/comments`)).body.data;
    expect(list.map((c: { body: string }) => c.body)).toEqual(['Compare with last year', 'Looks like the 36']);
    expect(list[0]).toMatchObject({ canEdit: false, canDelete: true }); // admin: cannot edit another's words, can delete them
    expect((await admin.get(`/patients/${s.patientId}/documents`)).body.data[0].commentCount).toBe(2);
  });

  it('works on a PDF too', async () => {
    const doc = await paper();
    expect((await aya.post(`/documents/${doc.id}/comments`, { body: 'Platelets are low' })).status).toBe(201);
  });

  it('refuses an empty or too long comment', async () => {
    const doc = await picture();
    expect((await staff.post(`/documents/${doc.id}/comments`, { body: '   ' })).status).toBe(400);
    expect((await staff.post(`/documents/${doc.id}/comments`, { body: 'x'.repeat(1001) })).status).toBe(400);
    expect((await staff.post(`/documents/${doc.id}/comments`, {})).status).toBe(400);
  });

  it('lets only the author edit, and the author or an admin delete', async () => {
    const doc = await picture();
    const mine = (await staff.post(`/documents/${doc.id}/comments`, { body: 'Mine' })).body.comment;
    expect((await staff.patch(`/documents/${doc.id}/comments/${mine.id}`, { body: 'Mine, edited' })).body.comment).toMatchObject({ body: 'Mine, edited' });
    expect((await aya.patch(`/documents/${doc.id}/comments/${mine.id}`, { body: 'Hijacked' })).status).toBe(403);
    expect((await admin.patch(`/documents/${doc.id}/comments/${mine.id}`, { body: 'Hijacked' })).status).toBe(403);
    expect((await aya.send('delete', `/documents/${doc.id}/comments/${mine.id}`)).status).toBe(403);
    expect((await del(admin, `/documents/${doc.id}/comments/${mine.id}`)).status).toBe(204);
    expect((await del(admin, `/documents/${doc.id}/comments/${mine.id}`)).status).toBe(404);
    const again = (await aya.post(`/documents/${doc.id}/comments`, { body: 'Dr note' })).body.comment;
    expect((await del(aya, `/documents/${doc.id}/comments/${again.id}`)).status).toBe(204);
  });

  it('keeps a comment to its own document', async () => {
    const one = await picture();
    const two = await picture();
    const c = (await staff.post(`/documents/${one.id}/comments`, { body: 'Here' })).body.comment;
    expect((await staff.patch(`/documents/${two.id}/comments/${c.id}`, { body: 'There' })).status).toBe(404);
    expect((await del(staff, `/documents/${two.id}/comments/${c.id}`)).status).toBe(404);
  });
});

describe('tags', () => {
  it('sets the tags of a picture as a whole, keeps the first spelling of a tag written twice, and shows them in the list', async () => {
    const doc = await picture();
    const res = await staff.put(`/documents/${doc.id}/tags`, { tags: ['  Tooth   36 ', 'tooth 36', 'Follow-up', 'CBCT'] });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['tooth 36', 'Follow-up', 'CBCT']); // the later spelling of the same tag wins; no second tag
    expect((await admin.get(`/patients/${s.patientId}/documents`)).body.data[0].tags).toEqual(['tooth 36', 'Follow-up', 'CBCT']);
    expect((await aya.put(`/documents/${doc.id}/tags`, { tags: ['Only this'] })).body.tags).toEqual(['Only this']); // replaces, and a doctor may tag
    expect((await staff.put(`/documents/${doc.id}/tags`, { tags: [] })).body.tags).toEqual([]);
  });

  it('refuses more than ten, a long or empty tag, and a PDF', async () => {
    const doc = await picture();
    expect((await staff.put(`/documents/${doc.id}/tags`, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).status).toBe(400);
    expect((await staff.put(`/documents/${doc.id}/tags`, { tags: ['x'.repeat(31)] })).status).toBe(400);
    expect((await staff.put(`/documents/${doc.id}/tags`, { tags: ['  '] })).status).toBe(400);
    expect((await staff.put(`/documents/${doc.id}/tags`, {})).status).toBe(400);
    const file = await paper();
    expect((await staff.put(`/documents/${file.id}/tags`, { tags: ['a'] })).body.error.code).toBe('NOT_AN_IMAGE');
  });

  it('filters the list by a tag, whatever its case', async () => {
    const one = await picture();
    await picture();
    await staff.put(`/documents/${one.id}/tags`, { tags: ['Follow-up'] });
    const found = (await admin.get(`/patients/${s.patientId}/documents?tag=follow-UP`)).body.data;
    expect(found.map((d: { id: number }) => d.id)).toEqual([one.id]);
    expect((await admin.get(`/patients/${s.patientId}/documents?tag=nothing`)).body.data).toEqual([]);
  });
});

describe('annotations', () => {
  it('adds a pin and a box, as fractions of the picture, and lists them in order', async () => {
    const doc = await picture();
    const p = await staff.post(`/documents/${doc.id}/annotations`, pin);
    expect(p.status).toBe(201);
    expect(p.body.annotation).toMatchObject({ kind: 'pin', x: 0.4, y: 0.5, w: null, h: null, label: 'Caries under the filling', author: { name: 'Sam Staff' }, canChange: true });
    const b = await aya.post(`/documents/${doc.id}/annotations`, box);
    expect(b.body.annotation).toMatchObject({ kind: 'box', w: 0.3, h: 0.25, canChange: true });
    expect((await admin.get(`/documents/${doc.id}/annotations`)).body.data.map((a: { kind: string }) => a.kind)).toEqual(['pin', 'box']);
    expect((await admin.get(`/patients/${s.patientId}/documents`)).body.data[0].annotationCount).toBe(2);
  });

  it('refuses marks that make no sense', async () => {
    const doc = await picture();
    const bad: [object, string][] = [
      [{ ...pin, label: '' }, 'label'],
      [{ ...pin, label: 'x'.repeat(201) }, 'label'],
      [{ ...pin, x: 1.5 }, 'x'],
      [{ ...pin, y: -0.1 }, 'y'],
      [{ ...pin, w: 0.2, h: 0.2 }, 'kind'], // a pin has no size
      [{ kind: 'box', x: 0.1, y: 0.1, label: 'No size' }, 'w'],
      [{ ...box, w: 0.001 }, 'w'], // too small
      [{ ...box, x: 0.8 }, 'w'], // runs off the right edge
      [{ ...box, y: 0.9 }, 'w'], // runs off the bottom
      [{ ...pin, kind: 'circle' }, 'kind'],
    ];
    for (const [body, field] of bad) {
      const res = await staff.post(`/documents/${doc.id}/annotations`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(res.body.error.details), JSON.stringify(body)).toContain(field);
    }
    expect((await admin.get(`/documents/${doc.id}/annotations`)).body.data).toEqual([]);
  });

  it('is for pictures only, and holds at most 50 marks', async () => {
    const file = await paper();
    expect((await staff.post(`/documents/${file.id}/annotations`, pin)).body.error.code).toBe('NOT_AN_IMAGE');
    const doc = await picture();
    await t.db('document_annotations').insert(Array.from({ length: 50 }, (_, i) => ({ document_id: doc.id, kind: 'pin', x: 0.5, y: 0.5, label: `m${i}`, created_by: 1, ...stamp })));
    expect((await staff.post(`/documents/${doc.id}/annotations`, pin)).body.error.code).toBe('TOO_MANY_ANNOTATIONS');
  });

  it('lets the author or an admin move, rename and delete a mark, and nobody else', async () => {
    const doc = await picture();
    const mark = (await staff.post(`/documents/${doc.id}/annotations`, box)).body.annotation;
    const moved = await staff.patch(`/documents/${doc.id}/annotations/${mark.id}`, { x: 0.2, y: 0.3, label: 'Bone loss, left' });
    expect(moved.body.annotation).toMatchObject({ x: 0.2, y: 0.3, w: 0.3, h: 0.25, label: 'Bone loss, left' });
    expect((await staff.patch(`/documents/${doc.id}/annotations/${mark.id}`, { x: 0.9 })).body.error.code).toBe('INVALID_ANNOTATION'); // would run off the edge
    expect((await staff.patch(`/documents/${doc.id}/annotations/${mark.id}`, {})).status).toBe(400);
    expect((await aya.patch(`/documents/${doc.id}/annotations/${mark.id}`, { label: 'Not mine' })).status).toBe(403);
    expect((await aya.send('delete', `/documents/${doc.id}/annotations/${mark.id}`)).status).toBe(403);
    expect((await admin.patch(`/documents/${doc.id}/annotations/${mark.id}`, { label: 'By admin' })).status).toBe(200);
    expect((await del(admin, `/documents/${doc.id}/annotations/${mark.id}`)).status).toBe(204);
    expect((await del(admin, `/documents/${doc.id}/annotations/${mark.id}`)).status).toBe(404);
  });

  it('cannot give a pin a size', async () => {
    const doc = await picture();
    const mark = (await staff.post(`/documents/${doc.id}/annotations`, pin)).body.annotation;
    expect((await staff.patch(`/documents/${doc.id}/annotations/${mark.id}`, { w: 0.2 })).body.error.code).toBe('INVALID_ANNOTATION');
  });
});

describe('who can reach them', () => {
  it('keeps patients out of all of it, and an outside specialist to his own patients’ documents', async () => {
    const doc = await picture();
    const mark = (await staff.post(`/documents/${doc.id}/annotations`, pin)).body.annotation;
    const note = (await staff.post(`/documents/${doc.id}/comments`, { body: 'Internal' })).body.comment;
    for (const [method, url, body] of [
      ['get', `/documents/${doc.id}/comments`], ['post', `/documents/${doc.id}/comments`, { body: 'x' }], ['patch', `/documents/${doc.id}/comments/${note.id}`, { body: 'x' }],
      ['get', `/documents/${doc.id}/annotations`], ['post', `/documents/${doc.id}/annotations`, pin], ['patch', `/documents/${doc.id}/annotations/${mark.id}`, { label: 'x' }],
      ['put', `/documents/${doc.id}/tags`, { tags: ['a'] }],
    ] as const) {
      expect((await patient.send(method, url, body as object | undefined)).status, `patient ${method} ${url}`).toBe(403);
      expect((await ext.send(method, url, body as object | undefined)).status, `specialist ${method} ${url}`).toBe(404); // not his patient's document
    }
    const mine = await picture(ext, extPatient);
    expect((await ext.post(`/documents/${mine.id}/comments`, { body: 'His own' })).status).toBe(201);
    expect((await ext.post(`/documents/${mine.id}/annotations`, pin)).status).toBe(201);
    expect([401, 403]).toContain((await t.client().get(`/documents/${doc.id}/comments`)).status);
  });

  it('answers 404 once the document is in the Trash', async () => {
    const doc = await picture();
    await staff.post(`/documents/${doc.id}/comments`, { body: 'x' });
    await staff.send('delete', `/documents/${doc.id}`);
    expect((await admin.get(`/documents/${doc.id}/comments`)).status).toBe(404);
    expect((await admin.post(`/documents/${doc.id}/annotations`, pin)).status).toBe(404);
    expect((await admin.put(`/documents/${doc.id}/tags`, { tags: ['a'] })).status).toBe(404);
  });

  it('never reaches the patient in the portal, even for a document shared with them', async () => {
    const doc = await picture();
    await staff.patch(`/documents/${doc.id}`, { patientVisible: true });
    await staff.post(`/documents/${doc.id}/comments`, { body: 'Internal comment' });
    await staff.post(`/documents/${doc.id}/annotations`, pin);
    await staff.put(`/documents/${doc.id}/tags`, { tags: ['internal tag'] });
    const res = await patient.get('/portal/documents');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const text = JSON.stringify(res.body);
    for (const secret of ['Internal comment', 'Caries under', 'internal tag', 'commentCount', 'annotationCount', 'tags']) expect(text).not.toContain(secret);
  });
});

describe('erasing and the log', () => {
  it('erases comments, tags and marks with the document when an admin erases it from the Trash', async () => {
    const doc = await picture();
    await staff.post(`/documents/${doc.id}/comments`, { body: 'x' });
    await staff.post(`/documents/${doc.id}/annotations`, pin);
    await staff.put(`/documents/${doc.id}/tags`, { tags: ['a', 'b'] });
    await staff.send('delete', `/documents/${doc.id}`);
    const res = await admin.agent.delete(`/api/v1/trash/document/${doc.id}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Pat Patient' });
    expect(res.status).toBe(204);
    for (const table of ['document_comments', 'document_tags', 'document_annotations']) expect(await t.db(table).count({ n: '*' }).first(), table).toMatchObject({ n: 0 });
  });

  it('records who did what by id and count only, never the words', async () => {
    const doc = await picture();
    const note = (await staff.post(`/documents/${doc.id}/comments`, { body: 'Patient is allergic to latex' })).body.comment;
    await staff.patch(`/documents/${doc.id}/comments/${note.id}`, { body: 'Patient is allergic to nickel' });
    const mark = (await staff.post(`/documents/${doc.id}/annotations`, pin)).body.annotation;
    await staff.patch(`/documents/${doc.id}/annotations/${mark.id}`, { label: 'Crack on the 46' });
    await staff.put(`/documents/${doc.id}/tags`, { tags: ['Tooth 46'] });
    await del(staff, `/documents/${doc.id}/annotations/${mark.id}`);
    await del(staff, `/documents/${doc.id}/comments/${note.id}`);
    const log = await t.db('audit_log').whereLike('action', 'document.%').orderBy('id');
    expect(log.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining([
      'document.comment.add', 'document.comment.update', 'document.comment.delete', 'document.annotation.add', 'document.annotation.update', 'document.annotation.delete', 'document.tags.set',
    ]));
    const text = JSON.stringify(log);
    for (const secret of ['latex', 'nickel', 'Caries', 'Crack', 'Tooth 46']) expect(text).not.toContain(secret);
    expect(JSON.parse(log.find((l: { action: string }) => l.action === 'document.tags.set').diff)).toEqual({ count: 1 });
  });
});
