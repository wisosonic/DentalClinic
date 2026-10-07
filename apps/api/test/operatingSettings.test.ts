import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';
import { runReminders } from '../src/jobs/notifications';
import { pino } from 'pino';

/**
 * The operating settings (owner decision 2026-10-07): numbers and switches an admin changes under Settings, in six
 * groups. Each page is read and saved by an admin only, starts from the old fixed value, and is obeyed by what it governs.
 */
let t: TestApp;
let s: Seed;
let now = NOW;
let admin: Client, aya: Client, staff: Client, pat: Client;
let uploads = '';
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

const DEFAULTS = {
  appointments: { defaultDuration: 30, cancelMinHours: 24, staffReminderMinutes: 120, patientReminderHours: 24 },
  security: { maxFailedLogins: 5, lockoutMinutes: 15, passwordMinLength: 10, rememberDays: 30 },
  portal: { enabled: true, showPayments: true, documentsVisibleByDefault: false },
  waiting: { chime: true, unitLetters: false, finishedCallSeconds: 0 },
  uploads: { maxDocumentMb: 25, maxDocumentsPerPatient: 200 },
  display: { weekStart: 'monday', timeFormat: '24h' },
};

beforeAll(async () => {
  t = await buildTestApp({}, () => now);
  s = await seedClinic(t);
  const [ayaUser] = await t.db('users').where({ email: 'doctor@clinic.test' }).pluck('id');
  await t.db('doctors').where({ id: s.doctorId }).update({ user_id: ayaUser });
  [admin, aya, staff, pat] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(async () => {
  await t.destroy();
  if (uploads) await rm(uploads, { recursive: true, force: true });
});
beforeEach(async () => {
  now = NOW;
  if (uploads) await rm(uploads, { recursive: true, force: true });
  uploads = await mkdtemp(path.join(tmpdir(), 'aya-operating-'));
  t.env.UPLOAD_DIR = uploads;
  await t.db('app_settings').whereIn('key', (await t.db('app_settings').pluck('key')).filter((k: string) => /^(appointments|security|portal|waiting|uploads|display)\./.test(k))).del();
  for (const table of ['waiting_tickets', 'patient_documents', 'payments', 'offer_items', 'treatment_offers', 'notifications', 'appointment_category', 'appointments', 'refresh_tokens', 'audit_log']) await t.db(table).del();
  await t.db('users').update({ failed_logins: 0, locked_until: null });
});

const put = (c: Client, group: string, body: object) => c.put(`/settings/${group}`, body);
const ctx = () => ({ db: t.db, env: t.env, logger: pino({ level: 'silent' }), clock: () => now });
const appointment = async (patientId: number, extra: Record<string, unknown> = {}) =>
  (await t.db('appointments').insert({ date: TOMORROW, time: '10:00', status: 'confirmed', patient_id: patientId, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp, ...extra }))[0]!;

describe('the six settings pages', () => {
  it.each(Object.keys(DEFAULTS))('%s: starts from the old fixed values, can be changed, and is remembered', async (group) => {
    const first = await admin.get(`/settings/${group}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual((DEFAULTS as Record<string, object>)[group]);
  });

  it('saves a page and answers with what is now in force; the other pages are untouched', async () => {
    const res = await put(admin, 'appointments', { defaultDuration: 45, cancelMinHours: 12, staffReminderMinutes: 60, patientReminderHours: 48 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ defaultDuration: 45, cancelMinHours: 12, staffReminderMinutes: 60, patientReminderHours: 48 });
    expect((await admin.get('/settings/appointments')).body).toEqual(res.body);
    expect((await admin.get('/settings/security')).body).toEqual(DEFAULTS.security);
    expect((await put(admin, 'display', { weekStart: 'saturday', timeFormat: '12h' })).body).toEqual({ weekStart: 'saturday', timeFormat: '12h' });
    expect((await put(admin, 'portal', { enabled: false, showPayments: false, documentsVisibleByDefault: true })).body).toEqual({ enabled: false, showPayments: false, documentsVisibleByDefault: true });
  });

  it('refuses values that make no sense, naming the field, and saves nothing', async () => {
    const cases: [string, object, string][] = [
      ['appointments', { ...DEFAULTS.appointments, defaultDuration: 20 }, 'defaultDuration'], // not a step of 15
      ['appointments', { ...DEFAULTS.appointments, defaultDuration: 600 }, 'defaultDuration'],
      ['appointments', { ...DEFAULTS.appointments, cancelMinHours: -1 }, 'cancelMinHours'],
      ['appointments', { ...DEFAULTS.appointments, staffReminderMinutes: 5 }, 'staffReminderMinutes'],
      ['appointments', { ...DEFAULTS.appointments, patientReminderHours: 500 }, 'patientReminderHours'],
      ['security', { ...DEFAULTS.security, maxFailedLogins: 1 }, 'maxFailedLogins'],
      ['security', { ...DEFAULTS.security, passwordMinLength: 4 }, 'passwordMinLength'],
      ['security', { ...DEFAULTS.security, passwordMinLength: 100 }, 'passwordMinLength'],
      ['security', { ...DEFAULTS.security, rememberDays: 0 }, 'rememberDays'],
      ['security', { ...DEFAULTS.security, lockoutMinutes: 'soon' }, 'lockoutMinutes'],
      ['uploads', { ...DEFAULTS.uploads, maxDocumentMb: 0 }, 'maxDocumentMb'],
      ['uploads', { ...DEFAULTS.uploads, maxDocumentMb: 500 }, 'maxDocumentMb'],
      ['uploads', { ...DEFAULTS.uploads, maxDocumentsPerPatient: 5000 }, 'maxDocumentsPerPatient'],
      ['display', { weekStart: 'friday', timeFormat: '24h' }, 'weekStart'],
      ['display', { weekStart: 'monday', timeFormat: 'metric' }, 'timeFormat'],
      ['waiting', { ...DEFAULTS.waiting, finishedCallSeconds: 9999 }, 'finishedCallSeconds'],
      ['portal', { enabled: 'yes', showPayments: true, documentsVisibleByDefault: false }, 'enabled'],
    ];
    for (const [group, body, field] of cases) {
      const res = await put(admin, group, body);
      expect(res.status, `${group} ${field}`).toBe(400);
      expect(JSON.stringify(res.body.error.details), `${group} ${field}`).toContain(field);
      expect((await admin.get(`/settings/${group}`)).body, group).toEqual((DEFAULTS as Record<string, object>)[group]);
    }
    expect((await put(admin, 'appointments', {})).status).toBe(400);
  });

  it('is for admins only', async () => {
    for (const group of Object.keys(DEFAULTS)) {
      for (const [name, c] of [['doctor', aya], ['staff', staff], ['patient', pat]] as const) {
        expect((await c.get(`/settings/${group}`)).status, `${name} reads ${group}`).toBe(403);
        expect((await put(c, group, (DEFAULTS as Record<string, object>)[group]!)).status, `${name} saves ${group}`).toBe(403);
      }
      expect([401, 403]).toContain((await t.client().get(`/settings/${group}`)).status);
    }
    expect((await admin.get('/settings/nothing')).status).toBe(404);
    expect((await admin.get('/settings/tax')).status).toBe(200); // the pages that were there still are
  });

  it('logs which values changed, numbers and switches only', async () => {
    await put(admin, 'security', { ...DEFAULTS.security, passwordMinLength: 12, lockoutMinutes: 15 });
    const log = await t.db('audit_log').where({ action: 'settings.security.update' }).first();
    expect(Object.keys(JSON.parse(log.diff))).toEqual(['passwordMinLength']); // only the changed one (the log hides values of keys that look like passwords)
  });

  it('starts from the server’s environment where it used to hold the value, until an admin saves', async () => {
    const other = await buildTestApp({ CANCEL_MIN_HOURS: '6', MAX_FAILED_LOGINS: '8', LOCKOUT_MINUTES: '30', REFRESH_TTL_DAYS_REMEMBER: '45' });
    try {
      await seedClinic(other);
      const a = await loggedIn(other, 'admin@clinic.test');
      expect((await a.get('/settings/appointments')).body.cancelMinHours).toBe(6);
      expect((await a.get('/settings/security')).body).toMatchObject({ maxFailedLogins: 8, lockoutMinutes: 30, rememberDays: 45 });
      expect((await a.put('/settings/appointments', { ...DEFAULTS.appointments, cancelMinHours: 24 })).body.cancelMinHours).toBe(24);
      expect((await a.get('/config')).body.cancelMinHours).toBe(24);
    } finally {
      await other.destroy();
    }
  });
});

describe('appointments', () => {
  it('uses the default length when an appointment is booked without one, and tells the screens', async () => {
    await put(admin, 'appointments', { ...DEFAULTS.appointments, defaultDuration: 60 });
    expect((await staff.get('/config')).body.defaultDuration).toBe(60);
    const body = { patientId: s.patientId, doctorId: s.doctorId, clinicId: s.clinicId, unitId: s.unitId, date: TOMORROW, time: '10:00' };
    const res = await staff.post('/appointments', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.appointment.durationMinutes).toBe(60);
    expect((await staff.post('/appointments', { ...body, time: '13:00', durationMinutes: 45 })).body.appointment.durationMinutes).toBe(45); // a length that is given wins
  });

  it('decides how late a patient may cancel online, in the answer, the portal and the message', async () => {
    const a = await appointment(s.patientId, { date: TODAY, time: '20:00' }); // ten hours from now (10:00 in Beirut)
    expect((await pat.post(`/appointments/${a}/cancel`)).body.error.code).toBe('TOO_LATE_TO_CANCEL'); // 24 h notice
    await put(admin, 'appointments', { ...DEFAULTS.appointments, cancelMinHours: 12 });
    const refused = await pat.post(`/appointments/${a}/cancel`);
    expect(refused.body.error).toMatchObject({ code: 'TOO_LATE_TO_CANCEL', details: { hours: 12 } });
    expect(refused.body.error.message).toContain('at least 12 hours');
    expect((await pat.get('/portal/upcoming')).body.data[0]).toMatchObject({ canCancel: false, cancelUntil: '2026-10-05 08:00' });
    await put(admin, 'appointments', { ...DEFAULTS.appointments, cancelMinHours: 6 });
    expect((await pat.get('/portal/upcoming')).body.data[0]).toMatchObject({ canCancel: true, cancelUntil: '2026-10-05 14:00' });
    expect((await pat.get('/portal/overview')).body.cancelMinHours).toBe(6);
    expect((await pat.post(`/appointments/${a}/cancel`)).status).toBe(200);
  });

  it('decides how early the doctor, the staff and the patient are reminded', async () => {
    await appointment(s.patientId, { date: TODAY, time: '13:00' }); // three hours away
    expect(await runReminders(ctx())).toBe(1); // only the patient: their reminder is a day ahead; the doctor's two hours are not near yet
    await t.db('notifications').del();
    await put(admin, 'appointments', { ...DEFAULTS.appointments, staffReminderMinutes: 240 });
    expect(await runReminders(ctx())).toBe(3); // the doctor and the staff now too, and the patient again (the text changed with the time)
    await t.db('notifications').del();
    await t.db('appointments').del();
    await appointment(s.patientId, { date: '2026-10-08', time: '10:00' }); // three days away
    await put(admin, 'appointments', { ...DEFAULTS.appointments, patientReminderHours: 24 });
    expect(await runReminders(ctx())).toBe(0);
    await put(admin, 'appointments', { ...DEFAULTS.appointments, patientReminderHours: 96 });
    expect(await runReminders(ctx())).toBe(1);
    expect((await t.db('notifications').first()).content).toContain('on 2026-10-08 at 10:00');
  });
});

describe('security', () => {
  it('locks an account after as many failures as the clinic chose, for as long as it chose', async () => {
    await put(admin, 'security', { ...DEFAULTS.security, maxFailedLogins: 3, lockoutMinutes: 45 });
    for (let i = 0; i < 2; i++) await t.client().post('/auth/login', { identifier: 'staff@clinic.test', password: 'wrong-password-1' });
    expect((await t.client().login('staff@clinic.test')).status).toBe(200); // two failures: not yet
    for (let i = 0; i < 3; i++) await t.client().post('/auth/login', { identifier: 'staff@clinic.test', password: 'wrong-password-1' });
    expect((await t.client().login('staff@clinic.test')).status).toBe(401); // locked, even for the right password
    const user = await t.db('users').where({ email: 'staff@clinic.test' }).first();
    const minutes = (Date.parse(`${user.locked_until.replace(' ', 'T')}Z`) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(43);
    expect(minutes).toBeLessThanOrEqual(45.1);
  });

  it('sets the shortest password everywhere a password is chosen, and tells the screens before sign-in', async () => {
    await put(admin, 'security', { ...DEFAULTS.security, passwordMinLength: 14 });
    expect((await t.client().get('/public-settings')).body.passwordMinLength).toBe(14);
    expect((await staff.get('/config')).body.passwordMinLength).toBe(14);
    const me = await loggedIn(t, 'staff@clinic.test');
    const tooShort = await me.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Short-Enough-1' }); // 14 characters: fine
    expect(tooShort.status).toBe(200);
    const next = await me.post('/auth/change-password', { currentPassword: 'Short-Enough-1', newPassword: 'Thirteen-Char1' }); // 14: fine too
    expect(next.status).toBe(200);
    const bad = await me.post('/auth/change-password', { currentPassword: 'Thirteen-Char1', newPassword: 'Only-13-Chars' }); // 13
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'WEAK_PASSWORD', message: 'Password must be at least 14 characters' });
    const created = await admin.post('/users', { name: 'New Person', email: 'new@clinic.test', role: 'staff', password: 'Only-13-Chars' });
    expect(created.body.error.code).toBe('WEAK_PASSWORD');
    await t.db('users').where({ email: 'staff@clinic.test' }).update({ password: bcrypt.hashSync(PASSWORD, 4), change_password: 0 });
  });

  it('allows a shorter password when the clinic lowers the minimum, but never under eight', async () => {
    await put(admin, 'security', { ...DEFAULTS.security, passwordMinLength: 8 });
    const me = await loggedIn(t, 'staff@clinic.test');
    expect((await me.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Tiger-77x' })).status).toBe(200); // 9 characters
    expect((await put(admin, 'security', { ...DEFAULTS.security, passwordMinLength: 7 })).status).toBe(400);
    await t.db('users').where({ email: 'staff@clinic.test' }).update({ password: bcrypt.hashSync(PASSWORD, 4), change_password: 0 });
  });

  it('keeps "keep me signed in" for as many days as the clinic chose', async () => {
    await put(admin, 'security', { ...DEFAULTS.security, rememberDays: 60 });
    const res = await t.client().post('/auth/login', { identifier: 'staff@clinic.test', password: PASSWORD, remember: true });
    expect(res.status).toBe(200);
    const token = await t.db('refresh_tokens').orderBy('id', 'desc').first();
    const days = (Date.parse(`${token.expires_at.replace(' ', 'T')}Z`) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });
});

describe('patient portal', () => {
  it('switches the whole portal off: nothing answers, a patient cannot cancel online, and staff are not affected', async () => {
    const a = await appointment(s.patientId, { date: '2026-10-09' });
    await put(admin, 'portal', { ...DEFAULTS.portal, enabled: false });
    for (const url of ['/portal/overview', '/portal/upcoming', '/portal/offers', '/portal/payments', '/portal/documents', '/patients/me', '/patients/me/timeline']) {
      const res = await pat.get(url);
      expect([res.status, res.body.error.code], url).toEqual([403, 'PORTAL_OFF']);
    }
    expect((await pat.post(`/appointments/${a}/cancel`)).body.error).toMatchObject({ code: 'PORTAL_OFF', message: 'The patient portal is switched off. Please contact the clinic.' });
    expect((await staff.post(`/appointments/${a}/cancel`)).status).toBe(200); // the clinic still can
    expect((await staff.get(`/patients/${s.patientId}`)).status).toBe(200);
    expect((await staff.get('/config')).body.portal).toEqual({ enabled: false, showPayments: true });
    await put(admin, 'portal', DEFAULTS.portal);
    expect((await pat.get('/portal/overview')).status).toBe(200);
  });

  it('hides money from patients: no payments, receipts, balance or paid figures, and a printout with only the total', async () => {
    const o = (await t.db('treatment_offers').insert({ patient_id: s.patientId, title: 'Plan', type: 'clinic', price: 300, cost: 100, currency: '$', status: 'accepted', ...stamp }))[0]!;
    await t.db('offer_items').insert({ offer_id: o, description: 'Crown', price: 300, cost: 100, sequence: 0, status: 'pending', ...stamp });
    const p = (await t.db('payments').insert({ date: TODAY, type: 'clinic', amount: 100, remaining: 200, currency: '$', method: 'cash', offer_id: o, ...stamp }))[0]!;
    expect((await pat.get('/portal/overview')).body.balance).toEqual({ price: 300, paid: 100, remaining: 200, currency: '$' });
    await put(admin, 'portal', { ...DEFAULTS.portal, showPayments: false });
    const overview = (await pat.get('/portal/overview')).body;
    expect(overview).toMatchObject({ balance: null, showPayments: false });
    const offer = (await pat.get('/portal/offers')).body.data[0];
    expect(offer).toMatchObject({ title: 'Plan', price: 300 });
    for (const field of ['paid', 'remaining', 'paymentState']) expect(offer, field).not.toHaveProperty(field);
    expect((await pat.get('/portal/payments')).body.error.code).toBe('PAYMENTS_HIDDEN');
    expect((await pat.get(`/portal/payments/${p}/receipt`)).body.error.code).toBe('PAYMENTS_HIDDEN');
    const pdf = await pat.agent.get(`/api/v1/portal/offers/${o}/pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).toString('latin1')).not.toContain('Paid so far');
    expect((await staff.get('/config')).body.portal).toEqual({ enabled: true, showPayments: false });
  });

  it('decides whether a new document is shared with the patient unless the person says otherwise', async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
    const up = (extra: Record<string, string>, body: Buffer) => staff.agent.post(`/api/v1/patients/${s.patientId}/documents?${new URLSearchParams({ category: 'xray', title: 'Scan', ...extra })}`).set('x-csrf-token', staff.csrf).set('content-type', 'image/png').send(body);
    expect((await up({}, png)).body.document.patientVisible).toBe(false);
    await put(admin, 'portal', { ...DEFAULTS.portal, documentsVisibleByDefault: true });
    expect((await staff.get('/config')).body.documents.visibleByDefault).toBe(true);
    const other = await sharp({ create: { width: 21, height: 20, channels: 3, background: '#eee' } }).png().toBuffer();
    expect((await up({}, other)).body.document.patientVisible).toBe(true);
    const third = await sharp({ create: { width: 22, height: 20, channels: 3, background: '#ddd' } }).png().toBuffer();
    expect((await up({ patientVisible: '0' }, third)).body.document.patientVisible).toBe(false); // the person's own choice wins
  });
});

describe('uploads', () => {
  const png = (w: number) => sharp({ create: { width: w, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
  const up = (body: Buffer) => staff.agent.post(`/api/v1/patients/${s.patientId}/documents?${new URLSearchParams({ category: 'xray', title: 'Scan', allowDuplicate: '1' })}`).set('x-csrf-token', staff.csrf).set('content-type', 'image/png').send(body);

  it('refuses a document bigger than the clinic allows, and accepts it when the limit is raised', async () => {
    await put(admin, 'uploads', { ...DEFAULTS.uploads, maxDocumentMb: 1 });
    expect((await staff.get('/config')).body.documents).toMatchObject({ maxMb: 1, maxPerPatient: 200 });
    const big = Buffer.concat([await png(30), Buffer.alloc(1.5 * 1024 * 1024)]);
    expect([(await up(big)).status, (await up(big)).body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    await put(admin, 'uploads', { ...DEFAULTS.uploads, maxDocumentMb: 2 });
    expect((await up(big)).status).toBe(201);
  });

  it('refuses another document once the patient has as many as the clinic allows, and says how many', async () => {
    await put(admin, 'uploads', { ...DEFAULTS.uploads, maxDocumentsPerPatient: 2 });
    expect((await up(await png(11))).status).toBe(201);
    expect((await up(await png(12))).status).toBe(201);
    const res = await up(await png(13));
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([409, 'TOO_MANY_DOCUMENTS', { max: 2 }]);
    await put(admin, 'uploads', { ...DEFAULTS.uploads, maxDocumentsPerPatient: 3 });
    expect((await up(await png(13))).status).toBe(201);
  });
});

describe('date and time display', () => {
  it('tells the screens how to show the week and the time', async () => {
    expect((await staff.get('/config')).body).toMatchObject({ weekStart: 'monday', timeFormat: '24h' });
    await put(admin, 'display', { weekStart: 'sunday', timeFormat: '12h' });
    expect((await staff.get('/config')).body).toMatchObject({ weekStart: 'sunday', timeFormat: '12h' });
    expect((await pat.get('/config')).body).toMatchObject({ weekStart: 'sunday', timeFormat: '12h' });
  });
});

describe('waiting room', () => {
  const walkIn = async (patientId: number, unitId: number, doctorId: number) => (await staff.post('/waiting-room', { patientId, doctorId, unitId })).body.ticket as { id: number; number: number; label: string };
  let sara: Client;
  beforeAll(async () => {
    const [uid] = await t.db('users').insert({ name: 'Dr Sara', email: 'sara@clinic.test', role: 'doctor', password: bcrypt.hashSync(PASSWORD, 4), ...stamp });
    await t.db('doctors').where({ id: s.saraId }).update({ user_id: uid });
    sara = await loggedIn(t, 'sara@clinic.test');
  });
  const key = async () => (await admin.post('/waiting-room/screen/reset')).body.key as string;
  const display = async (k: string) => (await t.client().agent.get(`/api/v1/waiting-display?key=${k}`)).body;

  it('writes the dental unit’s letter before the number when the clinic wants it', async () => {
    const one = await walkIn(s.patientId, s.unitId, s.doctorId);
    expect(one.label).toBe('1');
    await put(admin, 'waiting', { ...DEFAULTS.waiting, unitLetters: true });
    expect((await staff.get('/waiting-room')).body.data[0].label).toBe('A1');
    const two = await walkIn(s.otherPatientId, s.saraUnitId, s.saraId);
    expect([two.number, two.label]).toEqual([2, 'B2']); // the numbers stay the day's order; only the writing changes
    await aya.post(`/waiting-room/${one.id}/call`);
    await sara.post(`/waiting-room/${two.id}/call`);
    const k = await key();
    expect((await display(k)).calls.map((c: { label: string; number: number }) => [c.number, c.label]).sort()).toEqual([[1, 'A1'], [2, 'B2']]);
    await put(admin, 'waiting', DEFAULTS.waiting);
    expect((await display(k)).calls.map((c: { label: string }) => c.label).sort()).toEqual(['1', '2']);
  });

  it('keeps a finished call on the screen for the seconds the clinic chose, and then takes it off', async () => {
    const one = await walkIn(s.patientId, s.unitId, s.doctorId);
    await aya.post(`/waiting-room/${one.id}/call`);
    const k = await key();
    await aya.post(`/waiting-room/${one.id}/finish`);
    expect((await display(k)).calls).toEqual([]); // 0 seconds: off at once
    await put(admin, 'waiting', { ...DEFAULTS.waiting, finishedCallSeconds: 30 });
    expect((await display(k)).calls.map((c: { number: number }) => c.number)).toEqual([1]); // still up
    await t.db('waiting_tickets').where({ id: one.id }).update({ finished_at: '2020-01-01 00:00:00' });
    expect((await display(k)).calls).toEqual([]); // long ago: gone
  });

  it('never keeps up someone who did not come, and shows the next call instead of the finished one', async () => {
    await put(admin, 'waiting', { ...DEFAULTS.waiting, finishedCallSeconds: 60 });
    const one = await walkIn(s.patientId, s.unitId, s.doctorId);
    const two = await walkIn(s.otherPatientId, s.unitId, s.doctorId);
    const k = await key();
    await aya.post(`/waiting-room/${one.id}/call`);
    await aya.post(`/waiting-room/${one.id}/leave`); // did not come
    expect((await display(k)).calls).toEqual([]);
    await aya.post(`/waiting-room/${two.id}/call`);
    expect((await display(k)).calls.map((c: { number: number }) => c.number)).toEqual([2]);
  });

  it('tells the screen whether to offer the chime', async () => {
    const k = await key();
    expect((await display(k)).chime).toBe(true);
    await put(admin, 'waiting', { ...DEFAULTS.waiting, chime: false });
    expect((await display(k)).chime).toBe(false);
  });
});
