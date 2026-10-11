import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Patient medical history (owner request 2026-10-10): a profile (blood type, pregnancy, smoking, notes) and lists of
 * allergies, conditions, medications and surgeries. Doctors and staff view and manage it; patients never see it; a doctor
 * only for patients he may see in full; the log holds ids and field names, never what the history says.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let extPatient: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: bcrypt.hashSync(PASSWORD, 4), ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  extPatient = (await t.db('patients').insert({ patient_identifier: 'E1', fname: 'Ext', lname: 'Pat', phone: '701', doctor_id: s.externalDoctorId, ...stamp }))[0]!;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['patient_medical_items', 'patient_medical', 'audit_log']) await t.db(table).del();
  await t.db('patients').update({ deleted_at: null, deleted_by: null });
});

const P = () => `/patients/${s.patientId}/medical`;
const del = (c: Client, url: string) => c.send('delete', url);
const allergy = { kind: 'allergy', name: 'Penicillin', severity: 'severe', note: 'Rash and swelling', since: '2019' };
const add = async (c: Client, body: object = allergy, url = P()) => (await c.post(`${url}/items`, body)).body.item;

describe('the history', () => {
  it('starts empty, with nothing recorded', async () => {
    const res = await staff.get(P());
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.profile).toEqual({ bloodType: null, pregnancy: null, smoking: null, notes: null, reviewedAt: null, reviewedBy: null, updatedAt: null, updatedBy: null });
    expect((await staff.get(`${P()}/alerts`)).body).toEqual({ recorded: false, allergies: [], conditions: [], pregnant: false });
  });

  it('is open to admin, doctors and staff, and closed to patients and anyone signed out', async () => {
    for (const c of [admin, aya, staff]) expect((await c.get(P())).status).toBe(200);
    expect((await patient.get(P())).status).toBe(403);
    expect((await patient.get(`/patients/${s.patientId}/medical`)).status).toBe(403);
    expect((await patient.post(`${P()}/items`, allergy)).status).toBe(403);
    expect((await patient.patch(`${P()}/profile`, { notes: 'x' })).status).toBe(403);
    expect((await patient.get(`${P()}/alerts`)).status).toBe(403);
    expect([401, 403]).toContain((await t.client().get(P())).status);
  });
});

describe('the profile', () => {
  it('saves blood type, pregnancy, smoking and notes, a blank meaning not recorded', async () => {
    const res = await staff.patch(`${P()}/profile`, { bloodType: 'O-', pregnancy: 'no', smoking: 'former', notes: '  Anxious about needles ' });
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ bloodType: 'O-', pregnancy: 'no', smoking: 'former', notes: 'Anxious about needles', updatedBy: { name: 'Sam Staff' } });
    expect((await aya.patch(`${P()}/profile`, { smoking: '', notes: '' })).body.profile).toMatchObject({ bloodType: 'O-', pregnancy: 'no', smoking: null, notes: null }); // only what is sent changes
    expect((await admin.get(P())).body.profile.bloodType).toBe('O-');
  });

  it('refuses what makes no sense', async () => {
    for (const [body, field] of [[{ bloodType: 'C+' }, 'bloodType'], [{ pregnancy: 'maybe' }, 'pregnancy'], [{ smoking: 'a lot' }, 'smoking'], [{ notes: 'x'.repeat(2001) }, 'notes'], [{}, '']] as const) {
      const res = await staff.patch(`${P()}/profile`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      if (field) expect(JSON.stringify(res.body.error.details)).toContain(field);
    }
  });

  it('records that the history was gone through with the patient, and by whom', async () => {
    const res = await aya.post(`${P()}/review`, {});
    expect(res.body.profile.reviewedAt).toBeTruthy();
    expect(res.body.profile.reviewedBy.name).toBe('Dr Doctor');
    expect((await t.db('audit_log').where({ action: 'patient.medical.review' })).length).toBe(1);
  });
});

describe('the lists', () => {
  it('adds an allergy, a condition, a medication and a surgery', async () => {
    const made = await add(staff, allergy);
    expect(made).toMatchObject({ kind: 'allergy', name: 'Penicillin', severity: 'severe', note: 'Rash and swelling', since: '2019', active: true, updatedBy: { name: 'Sam Staff' } });
    for (const kind of ['condition', 'medication', 'surgery']) expect((await staff.post(`${P()}/items`, { kind, name: `Some ${kind}`, since: '2020-04-30' })).status, kind).toBe(201);
    expect((await aya.get(P())).body.items.map((i: { kind: string }) => i.kind)).toEqual(['allergy', 'condition', 'medication', 'surgery']);
  });

  it('lists allergies first, current before past, the severe first, then by name', async () => {
    await add(staff, { kind: 'condition', name: 'Zeta' });
    await add(staff, { kind: 'condition', name: 'Alpha', active: false });
    await add(staff, { kind: 'allergy', name: 'Latex', severity: 'mild' });
    await add(staff, { kind: 'allergy', name: 'Nickel' });
    await add(staff, { kind: 'allergy', name: 'Penicillin', severity: 'severe' });
    expect((await admin.get(P())).body.items.map((i: { name: string }) => i.name)).toEqual(['Penicillin', 'Latex', 'Nickel', 'Zeta', 'Alpha']);
  });

  it('accepts a year, a month or a day for "since", and refuses the future and nonsense', async () => {
    for (const since of ['2019', '2019-04', '2019-04-30', null, '']) expect((await staff.post(`${P()}/items`, { ...allergy, since })).status, String(since)).toBe(201);
    expect((await staff.post(`${P()}/items`, { ...allergy, since: '2999' })).body.error.code).toBe('INVALID_SINCE');
    expect((await staff.post(`${P()}/items`, { ...allergy, since: '2026-12' })).body.error.code).toBe('INVALID_SINCE'); // later this year than "now" (October)
    for (const since of ['19', '2019-4', 'last year', '1800']) expect((await staff.post(`${P()}/items`, { ...allergy, since })).status, since).toBe(400);
  });

  it('refuses entries that make no sense', async () => {
    const bad: [object, string][] = [
      [{ ...allergy, name: '  ' }, 'name'],
      [{ ...allergy, name: 'x'.repeat(121) }, 'name'],
      [{ ...allergy, kind: 'phobia' }, 'kind'],
      [{ ...allergy, severity: 'deadly' }, 'severity'],
      [{ kind: 'condition', name: 'Asthma', severity: 'mild' }, 'severity'], // severity is for allergies
      [{ ...allergy, note: 'x'.repeat(301) }, 'note'],
    ];
    for (const [body, field] of bad) {
      const res = await staff.post(`${P()}/items`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(res.body.error.details), JSON.stringify(body)).toContain(field);
    }
  });

  it('holds at most 100 entries', async () => {
    await t.db('patient_medical_items').insert(Array.from({ length: 100 }, (_, i) => ({ patient_id: s.patientId, kind: 'condition', name: `c${i}`, active: true, ...stamp })));
    expect((await staff.post(`${P()}/items`, allergy)).body.error.code).toBe('TOO_MANY_MEDICAL_ITEMS');
  });

  it('changes an entry, marks it resolved, and cannot give a condition a severity', async () => {
    const made = await add(staff, allergy);
    const res = await aya.patch(`${P()}/items/${made.id}`, { name: 'Amoxicillin', severity: 'moderate', note: '', active: false });
    expect(res.body.item).toMatchObject({ name: 'Amoxicillin', severity: 'moderate', note: null, active: false, updatedBy: { name: 'Dr Doctor' } });
    const cond = await add(staff, { kind: 'condition', name: 'Asthma' });
    expect((await staff.patch(`${P()}/items/${cond.id}`, { severity: 'mild' })).body.error.code).toBe('INVALID_SEVERITY');
    expect((await staff.patch(`${P()}/items/${made.id}`, {})).status).toBe(400);
    expect((await staff.patch(`${P()}/items/${made.id}`, { since: '2999' })).body.error.code).toBe('INVALID_SINCE');
  });

  it('deletes an entry, and keeps it to its own patient', async () => {
    const made = await add(staff, allergy);
    const other = await add(admin, { kind: 'condition', name: 'Asthma' }, `/patients/${s.otherPatientId}/medical`);
    expect((await del(staff, `${P()}/items/${other.id}`)).status).toBe(404); // someone else's entry through this patient
    expect((await staff.patch(`${P()}/items/${other.id}`, { name: 'x' })).status).toBe(404);
    expect((await del(staff, `${P()}/items/${made.id}`)).status).toBe(204);
    expect((await del(staff, `${P()}/items/${made.id}`)).status).toBe(404);
    expect((await admin.get(P())).body.items).toEqual([]);
  });
});

describe('the alerts', () => {
  it('gives the current allergies (the severe first), the current conditions and pregnancy', async () => {
    await add(staff, { kind: 'allergy', name: 'Latex', severity: 'mild' });
    await add(staff, allergy);
    await add(staff, { kind: 'allergy', name: 'Old allergy', active: false });
    await add(staff, { kind: 'condition', name: 'Diabetes' });
    await add(staff, { kind: 'condition', name: 'Resolved thing', active: false });
    await add(staff, { kind: 'medication', name: 'Warfarin' }); // medications are not an alert
    await staff.patch(`${P()}/profile`, { pregnancy: 'yes' });
    expect((await aya.get(`${P()}/alerts`)).body).toEqual({
      recorded: true, allergies: [{ name: 'Penicillin', severity: 'severe' }, { name: 'Latex', severity: 'mild' }], conditions: ['Diabetes'], pregnant: true,
    });
  });

  it('says it is recorded as soon as anything is', async () => {
    await staff.patch(`${P()}/profile`, { bloodType: 'A+' });
    expect((await staff.get(`${P()}/alerts`)).body).toMatchObject({ recorded: true, allergies: [], conditions: [], pregnant: false });
  });
});

describe('who can reach whose', () => {
  it('keeps an outside specialist to his own patients, and answers 404 for a deleted or unknown patient', async () => {
    expect((await ext.get(P())).status).toBe(404); // Pat is Aya's patient
    expect((await ext.post(`${P()}/items`, allergy)).status).toBe(404);
    expect((await ext.get(`${P()}/alerts`)).status).toBe(404);
    const mine = `/patients/${extPatient}/medical`;
    expect((await ext.post(`${mine}/items`, allergy)).status).toBe(201);
    expect((await ext.get(mine)).body.items).toHaveLength(1);
    expect((await admin.get('/patients/999999/medical')).status).toBe(404);
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await admin.get(P())).status).toBe(404);
    expect((await staff.post(`${P()}/items`, allergy)).status).toBe(404);
  });

  it('follows the Roles page: staff without the permission can read but not change', async () => {
    const permissions = ((await admin.get('/roles')).body.roles.find((r: { role: string }) => r.role === 'staff').permissions) as string[];
    const without = permissions.filter((p: string) => p !== 'medical:update' && p !== 'medical:delete');
    expect((await admin.put('/roles/staff', { permissions: without })).status).toBe(200);
    try {
      const made = await add(aya, allergy);
      expect((await staff.get(P())).status).toBe(200);
      expect((await staff.patch(`${P()}/items/${made.id}`, { name: 'x' })).status).toBe(403);
      expect((await del(staff, `${P()}/items/${made.id}`)).status).toBe(403);
      expect((await staff.post(`${P()}/items`, allergy)).status).toBe(201); // create was not taken away
    } finally {
      await admin.post('/roles/staff/reset', {});
    }
  });
});

describe('the log and the Trash', () => {
  it('records what was done by id, kind and field name, never what the history says', async () => {
    const made = await add(staff, { kind: 'allergy', name: 'Penicillin', severity: 'severe', note: 'Anaphylaxis in 2019' });
    await staff.patch(`${P()}/items/${made.id}`, { note: 'Carries an EpiPen' });
    await staff.patch(`${P()}/profile`, { notes: 'Fainted in the chair once', bloodType: 'AB+' });
    await staff.get(P());
    await del(staff, `${P()}/items/${made.id}`);
    const log = await t.db('audit_log').whereLike('action', 'patient.medical.%').orderBy('id');
    expect(log.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining([
      'patient.medical.item.add', 'patient.medical.item.update', 'patient.medical.profile', 'patient.medical.view', 'patient.medical.item.delete',
    ]));
    const text = JSON.stringify(await t.db('audit_log'));
    for (const secret of ['Penicillin', 'Anaphylaxis', 'EpiPen', 'Fainted', 'AB+']) expect(text).not.toContain(secret);
    expect(JSON.parse(log.find((l: { action: string }) => l.action === 'patient.medical.profile').diff)).toEqual({ fields: ['bloodType', 'notes'] });
  });

  it('is erased with the patient when an admin erases them from the Trash', async () => {
    await add(staff);
    await staff.patch(`${P()}/profile`, { bloodType: 'A+' });
    await t.db('patients').where({ id: s.patientId }).update({ deleted_at: '2026-10-01 00:00:00', deleted_by: 1 });
    const res = await admin.agent.delete(`/api/v1/trash/patient/${s.patientId}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Pat Patient' });
    expect(res.status).toBe(204);
    for (const table of ['patient_medical', 'patient_medical_items']) expect(await t.db(table).count({ n: '*' }).first(), table).toMatchObject({ n: 0 });
  });
});
