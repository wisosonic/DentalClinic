import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, TODAY, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Settings > General and Appearance. The timezone and the clinic's contact details take effect (dates, PDFs);
 * the language, mode and text size are served to the app, also before sign-in.
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
  await t.db('app_settings').del();
  await t.db('audit_log').del();
  await t.db('payments').del();
  await t.db('treatment_offers').del();
  await admin.put('/settings/general', general()); // back to the server's own timezone
});

const general = (extra: object = {}) => ({ language: 'en', timezone: 'Asia/Beirut', clinic: { address: '', phone: '', email: '' }, ...extra });

describe('general settings', () => {
  it('start from the defaults: English, the server’s timezone and no contact details', async () => {
    await t.db('app_settings').del();
    const r = (await admin.get('/settings/general')).body;
    expect(r).toEqual({ language: 'en', timezone: 'Asia/Beirut', clinic: { address: null, phone: null, email: null }, notifications: { reminders: true, events: true } });
  });

  it('save the language, timezone and contact details, and clearing one puts it back to unset', async () => {
    const saved = await admin.put('/settings/general', general({ language: 'ar', timezone: 'Europe/Paris', clinic: { address: 'Karakol, Beirut', phone: '+961 1 234 567', email: 'Clinic@Example.com' } }));
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ language: 'ar', timezone: 'Europe/Paris', clinic: { address: 'Karakol, Beirut', phone: '+961 1 234 567', email: 'clinic@example.com' }, notifications: { reminders: true, events: true } });
    expect((await admin.get('/settings/general')).body.clinic.phone).toBe('+961 1 234 567');
    const cleared = await admin.put('/settings/general', general({ language: 'ar', timezone: 'Europe/Paris', clinic: { address: 'Karakol, Beirut', phone: '', email: '' } }));
    expect(cleared.body.clinic).toEqual({ address: 'Karakol, Beirut', phone: null, email: null });
  });

  it('refuse a made-up timezone, an unknown language and a bad email', async () => {
    expect((await admin.put('/settings/general', general({ timezone: 'Mars/Olympus' }))).status).toBe(400);
    expect((await admin.put('/settings/general', general({ language: 'fr' }))).status).toBe(400);
    expect((await admin.put('/settings/general', general({ clinic: { address: '', phone: '', email: 'not-an-email' } }))).status).toBe(400);
    expect((await admin.put('/settings/general', { language: 'en' })).status).toBe(400);
  });

  it('are for admins only', async () => {
    for (const c of [aya, staff, patient]) {
      expect((await c.get('/settings/general')).status).toBe(403);
      expect((await c.put('/settings/general', general())).status).toBe(403);
    }
    expect((await t.client().get('/settings/general')).status).toBe(401);
  });

  it('change which day “today” is, because the timezone is the one every date calculation uses', async () => {
    const config = async () => (await admin.get('/config')).body;
    expect(await config()).toMatchObject({ timezone: 'Asia/Beirut', today: TODAY });
    await admin.put('/settings/general', general({ timezone: 'Pacific/Pago_Pago' })); // UTC-11: still the evening before
    expect(await config()).toMatchObject({ timezone: 'Pacific/Pago_Pago', today: '2026-10-04' });
    await admin.put('/settings/general', general({ timezone: 'Asia/Beirut' }));
    expect(await config()).toMatchObject({ today: TODAY });
  });

  it('log that they changed without logging the contact details', async () => {
    await admin.put('/settings/general', general({ clinic: { address: 'Secret Street 9', phone: '70123456', email: '' } }));
    const entry = await t.db('audit_log').where({ action: 'settings.general.update' }).first();
    expect(entry).toMatchObject({ entity: 'settings', entity_id: 'general' });
    expect(JSON.stringify(entry)).not.toMatch(/Secret Street|70123456/);
  });
});

describe('appearance settings', () => {
  it('start as light and medium, and save light or dark and a text size', async () => {
    expect((await admin.get('/settings/appearance')).body).toEqual({ mode: 'light', textSize: 'medium' });
    expect((await admin.put('/settings/appearance', { mode: 'dark', textSize: 'large' })).body).toEqual({ mode: 'dark', textSize: 'large' });
    expect((await admin.get('/settings/appearance')).body).toEqual({ mode: 'dark', textSize: 'large' });
  });

  it('refuse anything else, and are for admins only', async () => {
    expect((await admin.put('/settings/appearance', { mode: 'purple', textSize: 'medium' })).status).toBe(400);
    expect((await admin.put('/settings/appearance', { mode: 'dark', textSize: 'huge' })).status).toBe(400);
    for (const c of [aya, staff, patient]) {
      expect((await c.get('/settings/appearance')).status).toBe(403);
      expect((await c.put('/settings/appearance', { mode: 'dark', textSize: 'small' })).status).toBe(403);
    }
  });
});

describe('what the app fetches before anyone signs in', () => {
  it('is the language, the mode, the text size and the shortest password, and nothing else', async () => {
    await admin.put('/settings/general', general({ language: 'ar', clinic: { address: 'Karakol', phone: '1', email: 'a@b.co' } }));
    await admin.put('/settings/appearance', { mode: 'dark', textSize: 'small' });
    const res = await t.client().get('/public-settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ language: 'ar', mode: 'dark', textSize: 'small', passwordMinLength: 10 }); // no timezone, no contact details
  });

  it('has defaults when nothing was saved', async () => {
    await t.db('app_settings').del();
    expect((await t.client().get('/public-settings')).body).toEqual({ language: 'en', mode: 'light', textSize: 'medium', passwordMinLength: 10 });
  });
});

describe('the clinic’s contact details on the documents', () => {
  const pdf = (c: Client, url: string) => c.agent.get(`/api/v1${url}`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  const words = (res: { body: unknown }) => {
    const raw = (res.body as Buffer).toString('latin1');
    return [...raw.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((arr) => [...arr[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join('')).join('\n');
  };
  const quote = async () => (await t.db('treatment_offers').insert({ title: 'Crown', type: 'clinic', price: 100, cost: 0, currency: '$', status: 'accepted', patient_id: s.patientId, ...stamp }))[0]!;

  it('replace the clinic record’s on the letterhead, and add the email', async () => {
    await t.db('clinics').update({ address: 'Old Road 1', phone: '111' });
    const q = await quote();
    const before = words(await pdf(admin, `/treatment-offers/${q}/pdf`));
    expect(before).toContain('Old Road 1');
    expect(before).not.toContain('@');
    await admin.put('/settings/general', general({ clinic: { address: 'New Street 5', phone: '+961 70 000 000', email: 'hello@clinic.test' } }));
    const after = words(await pdf(admin, `/treatment-offers/${q}/pdf`));
    for (const part of ['New Street 5', '+961 70 000 000', 'hello@clinic.test']) expect(after, part).toContain(part);
    expect(after).not.toContain('Old Road 1');
  });

  it('leave the clinic record’s details alone for anything not set in Settings', async () => {
    await t.db('clinics').update({ address: 'Old Road 1', phone: '111' });
    const q = await quote();
    await admin.put('/settings/general', general({ clinic: { address: '', phone: '222', email: '' } }));
    const body = words(await pdf(admin, `/treatment-offers/${q}/pdf`));
    expect(body).toContain('Old Road 1'); // address not set in Settings: the record's
    expect(body).toContain('222'); // phone set there: replaces 111
    expect(body).not.toContain('111');
  });
});
