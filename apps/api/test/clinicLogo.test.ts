import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

let t: TestApp;
let s: Seed;
let dir: string;
let admin: Client, doctor: Client, staff: Client, patient: Client;

// Smallest valid-looking files: only the leading bytes matter to the server.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'aya-logo-'));
  t = await buildTestApp({ UPLOAD_DIR: dir }, () => NOW);
  s = await seedClinic(t);
  [admin, doctor, staff, patient] = await Promise.all(
    ['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)),
  );
});
afterAll(async () => {
  await t.destroy();
  rmSync(dir, { recursive: true, force: true });
});

const upload = (c: Client, body: Buffer, type = 'image/png', id = s.clinicId) =>
  c.agent.put(`/api/v1/clinics/${id}/logo`).set('x-csrf-token', c.csrf).set('content-type', type).send(body);
const files = () => readdirSync(dir);

describe('clinic logo', () => {
  it('has none to begin with', async () => {
    const res = await admin.get('/clinics');
    expect(res.body.data[0].logoUrl).toBeNull();
    expect((await admin.get(`/clinics/${s.clinicId}/logo`)).status).toBe(404);
  });

  it('lets an admin upload one, and everyone signed in can load it', async () => {
    const res = await upload(admin, PNG);
    expect(res.status).toBe(200);
    expect(res.body.clinic.logoUrl.startsWith(`/api/v1/clinics/${s.clinicId}/logo?v=`)).toBe(true);
    expect(res.body.clinic.logoUrl.split('?v=')[1]).toMatch(/^[a-f0-9]{12}$/);
    expect(files()).toHaveLength(1);

    for (const c of [admin, doctor, staff, patient]) {
      const img = await c.agent.get(res.body.clinic.logoUrl);
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(img.headers['x-content-type-options']).toBe('nosniff');
    }
    expect((await t.client().get(`/clinics/${s.clinicId}/logo`)).status).toBe(401);
  });

  it('replaces the previous file and changes the URL, so browsers reload it', async () => {
    const first = (await upload(admin, PNG)).body.clinic.logoUrl;
    const second = await upload(admin, JPEG, 'image/jpeg');
    expect(second.status).toBe(200);
    expect(second.body.clinic.logoUrl).not.toBe(first);
    await new Promise((r) => setTimeout(r, 50)); // old file is removed in the background
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatch(/\.jpg$/);
    expect((await admin.agent.get(second.body.clinic.logoUrl)).headers['content-type']).toBe('image/jpeg');
  });

  it('accepts WebP', async () => {
    expect((await upload(admin, WEBP, 'image/webp')).status).toBe(200);
  });

  it('removes the logo and its file', async () => {
    await upload(admin, PNG);
    const res = await admin.agent.delete(`/api/v1/clinics/${s.clinicId}/logo`).set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(200);
    expect(res.body.clinic.logoUrl).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(files()).toHaveLength(0);
  });

  it('judges the file by its bytes, not by what the client claims', async () => {
    await admin.agent.delete(`/api/v1/clinics/${s.clinicId}/logo`).set('x-csrf-token', admin.csrf);
    expect((await upload(admin, SVG, 'image/png')).status).toBe(400); // SVG pretending to be a PNG
    expect((await upload(admin, Buffer.from('plain text'), 'image/png')).status).toBe(400);
    expect((await upload(admin, PNG, 'image/svg+xml')).status).toBe(400); // type not allowed
    expect((await upload(admin, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(admin, PNG, 'application/json')).status).toBe(400);
    expect(files()).toHaveLength(0);
  });

  it('rejects files over 512 KB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(513 * 1024)]);
    expect((await upload(admin, big)).status).toBe(413);
    expect(files()).toHaveLength(0);
  });

  it('is for admins only', async () => {
    for (const c of [doctor, staff, patient]) {
      expect((await upload(c, PNG)).status).toBe(403);
      expect((await c.agent.delete(`/api/v1/clinics/${s.clinicId}/logo`).set('x-csrf-token', c.csrf)).status).toBe(403);
    }
    expect(files()).toHaveLength(0);
  });

  it('needs the CSRF header', async () => {
    const res = await admin.agent.put(`/api/v1/clinics/${s.clinicId}/logo`).set('content-type', 'image/png').send(PNG);
    expect(res.status).toBe(403);
  });

  it('answers 404 for a clinic that does not exist', async () => {
    expect((await upload(admin, PNG, 'image/png', 9999)).status).toBe(404);
    expect((await admin.get('/clinics/9999/logo')).status).toBe(404);
  });

  it('is recorded in the audit log without the image', async () => {
    await t.db('audit_log').del();
    await upload(admin, PNG);
    const row = await t.db('audit_log').where({ action: 'clinic.logo.set' }).first();
    expect(row).toMatchObject({ entity: 'clinic', entity_id: String(s.clinicId) });
  });

  it('deletes the file when the clinic is deleted', async () => {
    const [id] = await t.db('clinics').insert({ name: 'Temporary' });
    expect((await upload(admin, PNG, 'image/png', id as number)).status).toBe(200);
    const name = files().find((f) => f.startsWith(`clinic-${id}-`))!;
    expect(existsSync(path.join(dir, name))).toBe(true);
    expect((await admin.agent.delete(`/api/v1/clinics/${id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(path.join(dir, name))).toBe(false);
  });
});
