import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { passwordProblem } from '@aya/shared';
import { usernameBase } from '../src/lib/username';
import { NOW, PASSWORD, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Patient usernames and the patient card (owner decision 2026-10-07): a username is made from the name when a
 * patient is registered; staff print a card with the patient's details, the username and a first password that
 * must be changed at the first sign-in.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patientClient: Client, ext: Client;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [extUser] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: extUser });
  const [ayaUser] = await t.db('users').where({ email: 'doctor@clinic.test' }).pluck('id');
  await t.db('doctors').where({ id: s.doctorId }).update({ user_id: ayaUser });
  [admin, aya, staff, patientClient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(() => t.destroy());
beforeEach(async () => {
  // keep the seeded patients and logins; remove what these tests register
  const mine = (await t.db('patients').where('id', '>', s.otherPatientId).select('id', 'user_id')) as { id: number; user_id: number | null }[];
  for (const p of mine) await t.db('patients').where({ id: p.id }).del();
  for (const p of mine) if (p.user_id) await t.db('refresh_tokens').where({ user_id: p.user_id }).del();
  for (const p of mine) if (p.user_id) await t.db('users').where({ id: p.user_id }).del();
  await t.db('audit_log').del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
});

const register = async (c: Client, fname: string, lname: string, extra: Record<string, unknown> = {}) => {
  const res = await c.post('/patients?allowDuplicate=true', { fname, lname, phone: String(Math.floor(Math.random() * 1e8)), doctorId: s.doctorId, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.patient as { id: number; username: string | null; patientIdentifier: string; loginState?: string; hasAccount: boolean };
};
const card = (c: Client, id: number, body: object = {}) =>
  c.agent.post(`/api/v1/patients/${id}/card`).set('x-csrf-token', c.csrf).send(body).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
/** The words on the page (pdfkit stores text as hex pieces inside TJ arrays). */
const words = (res: { body: unknown }) => {
  const raw = (res.body as Buffer).toString('latin1');
  const lines: string[] = [raw.slice(0, 8)];
  for (const arr of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) lines.push([...arr[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join(''));
  return lines.join('\n');
};
/** The first password printed on a card. */
const printedPassword = (res: { body: unknown }) => {
  const lines = words(res).split('\n');
  const at = lines.findIndex((l) => l.includes('FIRST PASSWORD'));
  return lines[at + 1]!.trim();
};
const signIn = (identifier: string, password: string) => t.client().post('/auth/login', { identifier, password });

describe('the username', () => {
  it('is made from the name when a patient is registered: first name, a dot, last name, in plain lowercase', async () => {
    expect((await register(staff, 'Hicham', 'Cheaib')).username).toBe('hicham.cheaib');
    expect((await register(staff, 'Élie', 'Abi Nader')).username).toBe('elie.abinader');
    expect((await register(staff, 'Jean-Luc', 'O’Brien')).username).toBe('jeanluc.obrien');
    expect((await register(staff, 'Mary Ann', 'Smith')).username).toBe('mary.smith'); // the first of the first names
  });

  it('is unique: the same name again gets a number', async () => {
    const names = [(await register(staff, 'Ali', 'Haddad')).username, (await register(aya, 'Ali', 'Haddad')).username, (await register(admin, 'ALI', 'haddad')).username];
    expect(names).toEqual(['ali.haddad', 'ali.haddad2', 'ali.haddad3']);
  });

  it('is never one that a login already has, whoever it belongs to', async () => {
    await t.db('users').insert({ name: 'Someone', email: 'someone@clinic.test', username: 'sam.taken', role: 'staff', password: 'x', ...stamp });
    expect((await register(staff, 'Sam', 'Taken')).username).toBe('sam.taken2');
    await t.db('users').where({ username: 'sam.taken' }).del();
  });

  it('falls back to the patient number for a name with no Latin letters (Arabic script)', async () => {
    const p = await register(staff, 'عبد', 'الله');
    expect(p.username).toBe(`patient${p.patientIdentifier}`);
  });

  it('never changes when the name is edited, and is shown to staff and to the patient, who sees only their own', async () => {
    const p = await register(staff, 'Nadia', 'Khoury');
    const edited = await staff.patch(`/patients/${p.id}`, { lname: 'Haddad' });
    expect(edited.body.patient.username).toBe('nadia.khoury');
    expect((await admin.get(`/patients/${p.id}`)).body.patient.username).toBe('nadia.khoury');
    expect((await admin.get('/patients?q=nadia')).body.data[0].username).toBe('nadia.khoury');
    await t.db('patients').where({ id: s.patientId }).update({ username: 'pat.patient' });
    expect((await patientClient.get('/patients/me')).body.patient.username).toBe('pat.patient');
  });

  it('is built by a plain function that handles accents, punctuation and a missing last name', () => {
    expect(usernameBase('José', 'Núñez', 1)).toBe('jose.nunez');
    expect(usernameBase('  Zoë ', '', 2)).toBe('zoe');
    expect(usernameBase('', 'Haddad', 3)).toBe('haddad');
    expect(usernameBase('1', '2', 4)).toBe('1.2');
    expect(usernameBase('عبد', 'الله', '100007')).toBe('patient100007');
    expect(usernameBase('A'.repeat(60), 'B'.repeat(60), 5).length).toBeLessThanOrEqual(36); // room for a number
  });
});

describe('the patient card', () => {
  it('creates the patient’s login the first time and prints the details, the username, a first password and the note', async () => {
    const p = await register(staff, 'Hicham', 'Cheaib', { dateOfBirth: '1990-04-12', phone: '03 123 456' });
    expect(p).toMatchObject({ hasAccount: false, loginState: 'none' });
    const res = await card(staff, p.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="patient-card-${p.patientIdentifier}.pdf"`);
    const text = words(res);
    expect(text).toContain('%PDF');
    for (const part of ['Test Clinic', 'Patient card', 'Hicham Cheaib', p.patientIdentifier, '1990-04-12', '03 123 456', 'Dr Aya Ghali', 'hicham.cheaib', 'FIRST PASSWORD']) expect(text, part).toContain(part);
    expect(text.replace(/\s+/g, ' ')).toContain('change it the first time you sign in'); // the note wraps over lines
    const password = printedPassword(res);
    expect(password).toHaveLength(12);
    expect(passwordProblem(password, { email: 'hicham.cheaib' })).toBeNull();

    const login = await t.db('users').where({ username: 'hicham.cheaib' }).first();
    expect(login).toMatchObject({ role: 'patient', name: 'Hicham Cheaib', change_password: 1, is_active: 1, email: 'hicham.cheaib@patients.invalid' });
    expect(login.password).not.toContain(password); // only a hash is kept
    expect(await bcrypt.compare(password, login.password)).toBe(true);
    const row = await t.db('patients').where({ id: p.id }).first();
    expect(row.user_id).toBe(login.id);
    const detail = (await staff.get(`/patients/${p.id}`)).body.patient;
    expect(detail).toMatchObject({ hasAccount: true, loginState: 'waiting', username: 'hicham.cheaib' });
  });

  it('lets the patient sign in with the username (or email) and the card’s password, and makes them choose their own', async () => {
    const p = await register(staff, 'Hicham', 'Cheaib');
    const password = printedPassword(await card(staff, p.id));
    const bad = await signIn('hicham.cheaib', 'wrong-password-1');
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Invalid email, username or password');
    for (const typed of ['hicham.cheaib', 'Hicham.Cheaib', '  HICHAM.CHEAIB ']) {
      const ok = await signIn(typed, password);
      expect(ok.status, typed).toBe(200);
      expect(ok.body.user).toMatchObject({ role: 'patient', username: 'hicham.cheaib', mustChangePassword: true });
    }
    expect((await t.client().post('/auth/login', { email: 'hicham.cheaib', password })).status).toBe(200); // the old field name still works
    expect((await signIn('hicham.cheaib@patients.invalid', password)).status).toBe(200); // the internal address works too, but is never shown or used
    // the patient picks their own password; it may not contain the username
    const me = t.client();
    await me.post('/auth/login', { identifier: 'hicham.cheaib', password });
    expect((await me.post('/auth/change-password', { currentPassword: password, newPassword: 'Hicham.Cheaib-2026' })).status).toBe(400);
    expect((await me.post('/auth/change-password', { currentPassword: password, newPassword: 'Blue-Tooth-Moon-77' })).status).toBe(200);
    expect((await staff.get(`/patients/${p.id}`)).body.patient.loginState).toBe('active');
    expect((await signIn('hicham.cheaib', password)).status).toBe(401); // the card's password is gone
    expect((await signIn('hicham.cheaib', 'Blue-Tooth-Moon-77')).status).toBe(200);
  });

  it('prints a new card while the first password is unused, and the old password stops working', async () => {
    const p = await register(staff, 'Rima', 'Saad');
    const first = printedPassword(await card(staff, p.id));
    const second = printedPassword(await card(aya, p.id));
    expect(second).not.toBe(first);
    expect((await signIn('rima.saad', first)).status).toBe(401);
    expect((await signIn('rima.saad', second)).status).toBe(200);
    expect(await t.db('users').where({ username: 'rima.saad' }).count({ n: '*' }).first()).toMatchObject({ n: 1 }); // one login, not two
    const logs = await t.db('audit_log').where({ action: 'patient.card' }).orderBy('id');
    expect(logs.map((l) => JSON.parse(l.diff))).toEqual([{ created: true, reset: false }, { created: false, reset: false }]);
  });

  it('refuses to replace a password the patient has chosen, unless told to reset it, which signs them out', async () => {
    const p = await register(staff, 'Karim', 'Nasr');
    const first = printedPassword(await card(staff, p.id));
    const me = t.client();
    await me.post('/auth/login', { identifier: 'karim.nasr', password: first });
    await me.post('/auth/change-password', { currentPassword: first, newPassword: 'Green-River-Stone-5' });
    expect((await me.get('/auth/me')).status).toBe(200);

    const refused = await staff.post(`/patients/${p.id}/card`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PASSWORD_ALREADY_CHANGED');
    expect((await signIn('karim.nasr', 'Green-River-Stone-5')).status).toBe(200); // nothing changed

    const reset = await card(staff, p.id, { reset: true });
    expect(reset.status).toBe(200);
    const fresh = printedPassword(reset);
    expect((await signIn('karim.nasr', 'Green-River-Stone-5')).status).toBe(401);
    expect((await signIn('karim.nasr', fresh)).body.user.mustChangePassword).toBe(true);
    // the username is the same one, in both places, after any number of cards
    expect(await t.db('patients').where({ id: p.id }).first('username')).toMatchObject({ username: 'karim.nasr' });
    expect(await t.db('users').where({ id: (await t.db('patients').where({ id: p.id }).first('user_id')).user_id }).first('username')).toMatchObject({ username: 'karim.nasr' });
    const refresh = await me.post('/auth/refresh');
    expect(refresh.status).toBe(401); // their old session is over
    expect(JSON.parse((await t.db('audit_log').where({ action: 'patient.card' }).orderBy('id', 'desc').first()).diff)).toEqual({ created: false, reset: true });
  });

  it('says so when the login has been switched off, and makes nothing', async () => {
    const p = await register(staff, 'Layal', 'Fares');
    await card(staff, p.id);
    await t.db('users').where({ username: 'layal.fares' }).update({ is_active: false });
    const res = await staff.post(`/patients/${p.id}/card`, { reset: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('gives a record from before usernames one, and links the login to it', async () => {
    const id = (await t.db('patients').insert({ patient_identifier: '555001', fname: 'Old', lname: 'Record', phone: '1', doctor_id: s.doctorId, ...stamp }))[0]!;
    expect((await staff.get(`/patients/${id}`)).body.patient.username).toBeNull();
    const res = await card(staff, id);
    expect(res.status).toBe(200);
    expect(words(res)).toContain('old.record');
    expect(await t.db('patients').where({ id }).first('username')).toMatchObject({ username: 'old.record' });
  });

  it('never keeps the password anywhere but on the card: not in the log, the answer headers or a later read', async () => {
    const p = await register(staff, 'Tony', 'Aoun');
    const res = await card(staff, p.id);
    const password = printedPassword(res);
    const everything = JSON.stringify(await t.db('audit_log').select()) + JSON.stringify(res.headers) + JSON.stringify((await staff.get(`/patients/${p.id}`)).body) + JSON.stringify((await admin.get('/users')).body);
    expect(everything).not.toContain(password);
  });

  it('is for staff, doctors (their own patients) and admin only', async () => {
    const own = await register(staff, 'Own', 'Patient');
    const saras = await register(admin, 'Sara', 'Patient', { doctorId: s.saraId });
    expect((await card(admin, own.id)).status).toBe(200);
    expect((await card(aya, own.id)).status).toBe(200);
    expect((await card(aya, saras.id)).status).toBe(200); // owner doctors reach every patient
    expect((await card(patientClient, own.id)).status).toBe(403);
    expect([401, 403]).toContain((await card(t.client(), own.id)).status); // no session
    expect((await card(staff, 999999)).status).toBe(404);
    // an outside specialist reaches only his own patients; an owner's patient looks like none
    expect((await card(ext, own.id)).status).toBe(404);
    expect(await t.db('users').where({ username: 'own.patient' }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
    const extOwn = await register(ext, 'Ext', 'Patient', { doctorId: s.externalDoctorId });
    expect((await card(ext, extOwn.id)).status).toBe(200);
  });

  it('needs the CSRF header like every change, and refuses a patient who is in the Trash', async () => {
    const p = await register(staff, 'Gone', 'Soon');
    const noCsrf = await staff.agent.post(`/api/v1/patients/${p.id}/card`).send({});
    expect(noCsrf.status).toBe(403);
    await staff.agent.delete(`/api/v1/patients/${p.id}`).set('x-csrf-token', staff.csrf);
    expect((await card(staff, p.id)).status).toBe(404);
    expect(await t.db('users').where({ username: 'gone.soon' }).count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it('rejects anything but a boolean reset in the body', async () => {
    const p = await register(staff, 'Odd', 'Body');
    expect((await staff.post(`/patients/${p.id}/card`, { reset: 'yes' })).status).toBe(400);
    expect((await staff.post(`/patients/${p.id}/card`, { password: 'Chosen-By-Staff-1' })).status).toBe(400); // staff never choose it
  });
});
