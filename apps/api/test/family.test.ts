import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Family links (owner request 2026-10-09): staff, doctors and admin link related patients and see them from both
 * sides; a link never widens what someone may see; patients never see any of it.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let ali: number, omar: number, mona: number, extKid: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  const person = async (id: string, fname: string, gender: string | null, doctor: number | null) =>
    (await t.db('patients').insert({ patient_identifier: id, fname, lname: 'Haddad', phone: `70${id}`, gender, doctor_id: doctor, date_of_birth: '1990-05-01', ...stamp }))[0]!;
  ali = await person('2001', 'Ali', 'male', s.doctorId);
  omar = await person('2002', 'Omar', 'male', s.doctorId);
  mona = await person('2003', 'Mona', 'female', s.doctorId);
  extKid = await person('2004', 'Kid', null, s.externalDoctorId);
});
afterAll(() => t.destroy());
beforeEach(async () => {
  await t.db('patient_relatives').del();
  await t.db('appointments').del();
  await t.db('audit_log').del();
  await t.db('patients').whereIn('id', [ali, omar, mona, extKid]).update({ deleted_at: null, deleted_by: null });
});

const del = (c: Client, url: string) => c.send('delete', url);
const link = (c: Client, id: number, relativeId: number, relation: string) => c.post(`/patients/${id}/family`, { relativeId, relation });
const list = async (c: Client, id: number) => (await c.get(`/patients/${id}/family`)).body.data as { patientId: number; relation: string; linkId: number; nextAppointment: { date: string } | null }[];

describe('linking', () => {
  it('links a relative with one of the five relationships, and answers with the relative', async () => {
    for (const relation of ['father', 'mother', 'son', 'daughter', 'sibling', 'spouse']) {
      await t.db('patient_relatives').del();
      const res = await link(staff, ali, omar, relation);
      expect(res.status, relation).toBe(201);
      expect(res.body.member).toMatchObject({ patientId: omar, fname: 'Omar', relation: relation === 'spouse' ? 'husband' : relation, patientIdentifier: '2002' });
    }
  });

  it('shows the link from both sides, turning the word round by the person’s gender', async () => {
    await link(admin, ali, omar, 'father'); // Omar is Ali's father
    await link(admin, ali, mona, 'sibling');
    expect((await list(admin, ali)).map((m) => [m.patientId, m.relation])).toEqual([[omar, 'father'], [mona, 'sibling']]);
    expect((await list(admin, omar)).map((m) => [m.patientId, m.relation])).toEqual([[ali, 'son']]); // Ali is male
    expect((await list(admin, mona)).map((m) => [m.patientId, m.relation])).toEqual([[ali, 'sibling']]);
    await t.db('patient_relatives').del();
    await link(admin, mona, omar, 'son'); // Omar is Mona's son: Mona is his mother (female)
    expect((await list(admin, omar))[0]).toMatchObject({ patientId: mona, relation: 'mother' });
    await t.db('patient_relatives').del();
    await link(admin, extKid, omar, 'mother'); // Omar is the child's mother?! only the word counts: the child's gender is unknown
    expect((await list(admin, omar))[0]).toMatchObject({ patientId: extKid, relation: 'child' });
    await t.db('patient_relatives').del();
    await link(admin, extKid, omar, 'daughter');
    expect((await list(admin, omar))[0]).toMatchObject({ patientId: extKid, relation: 'parent' });
  });

  it('is open to admin, staff and an owner doctor, and closed to patients and to anyone signed out', async () => {
    for (const [i, c] of [admin, staff, aya].entries()) {
      await t.db('patient_relatives').del();
      expect((await link(c, ali, omar, 'father')).status, `client ${i}`).toBe(201);
      expect((await c.get(`/patients/${ali}/family`)).status).toBe(200);
    }
    expect((await link(patient, ali, omar, 'father')).status).toBe(403);
    expect((await patient.get(`/patients/${s.patientId}/family`)).status).toBe(403);
    expect((await del(patient, `/patients/${s.patientId}/family/1`)).status).toBe(403);
    expect([401, 403]).toContain((await t.client().get(`/patients/${ali}/family`)).status);
  });

  it('refuses a self link, a bad relationship, an unknown or deleted patient, and a second link for the same pair', async () => {
    expect((await link(admin, ali, ali, 'sibling')).body.error.code).toBe('SELF_LINK');
    const bad = await link(admin, ali, omar, 'cousin');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.error.details)).toContain('relation');
    expect((await link(admin, ali, 999999, 'sibling')).status).toBe(404);
    expect((await link(admin, 999999, ali, 'sibling')).status).toBe(404);
    await t.db('patients').where({ id: mona }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await link(admin, ali, mona, 'sibling')).status).toBe(404);

    expect((await link(admin, ali, omar, 'father')).status).toBe(201);
    const again = await link(admin, ali, omar, 'father');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_LINKED');
    expect((await link(admin, omar, ali, 'son')).body.error.code).toBe('ALREADY_LINKED'); // the same pair the other way round
    expect(await t.db('patient_relatives').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });
});

describe('spouses', () => {
  it('links a husband or wife, and each side sees the other by their gender', async () => {
    expect((await link(staff, mona, ali, 'spouse')).body.member).toMatchObject({ patientId: ali, relation: 'husband' }); // Ali is male
    expect((await list(admin, mona)).map((m) => [m.patientId, m.relation])).toEqual([[ali, 'husband']]);
    expect((await list(admin, ali)).map((m) => [m.patientId, m.relation])).toEqual([[mona, 'wife']]); // Mona is female
    await t.db('patient_relatives').del();
    expect((await link(staff, ali, extKid, 'spouse')).body.member).toMatchObject({ patientId: extKid, relation: 'spouse' }); // no gender known
    expect((await link(staff, extKid, ali, 'spouse')).body.error.code).toBe('ALREADY_LINKED'); // a couple is one link
  });
});

describe('viewing the related records', () => {
  it('lists each relative with the details the clinic needs and their next visit', async () => {
    await link(admin, ali, omar, 'father');
    await t.db('appointments').insert([
      { date: TOMORROW, time: '11:00', status: 'confirmed', patient_id: omar, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp },
      { date: TODAY, time: '08:00', status: 'cancelled', patient_id: omar, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp },
      { date: '2026-09-01', time: '08:00', status: 'completed', patient_id: omar, doctor_id: s.doctorId, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp },
    ]);
    const [m] = (await staff.get(`/patients/${ali}/family`)).body.data;
    expect(m).toMatchObject({ patientId: omar, fname: 'Omar', lname: 'Haddad', phone: '702002', gender: 'male', dateOfBirth: '1990-05-01', relation: 'father', patientIdentifier: '2002' });
    expect(m.nextAppointment).toMatchObject({ date: TOMORROW, time: '11:00' }); // not the cancelled one, not the past one
    expect(m).not.toHaveProperty('description');
  });

  it('leaves out a relative who has been deleted, and brings them back when restored', async () => {
    await link(admin, ali, omar, 'father');
    await t.db('patients').where({ id: omar }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect(await list(admin, ali)).toEqual([]);
    await t.db('patients').where({ id: omar }).update({ deleted_at: null });
    expect(await list(admin, ali)).toHaveLength(1);
  });

  it('records that someone opened the family list, ids only', async () => {
    await link(staff, ali, omar, 'father');
    await staff.get(`/patients/${ali}/family`);
    const views = await t.db('audit_log').where({ action: 'patient.family.view' });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ entity: 'patient', entity_id: String(ali) });
    const linked = await t.db('audit_log').where({ action: 'patient.family.link' }).first();
    expect(JSON.parse(linked.diff)).toEqual({ relativeId: omar, relation: 'father' });
    expect(JSON.stringify(linked)).not.toContain('Omar');
  });
});

describe('unlinking', () => {
  it('removes a link from either side, and says so in the log', async () => {
    const made = await link(staff, ali, omar, 'father');
    expect((await del(staff, `/patients/${omar}/family/${made.body.member.linkId}`)).status).toBe(204); // from the other side
    expect(await list(admin, ali)).toEqual([]);
    const again = await link(staff, ali, omar, 'father');
    expect((await del(staff, `/patients/${ali}/family/${again.body.member.linkId}`)).status).toBe(204);
    expect((await t.db('audit_log').where({ action: 'patient.family.unlink' }))).toHaveLength(2);
    // and the pair can be linked again, with a different word
    expect((await link(staff, ali, omar, 'sibling')).status).toBe(201);
  });

  it('answers 404 for a link that is not this patient’s, and for one already gone', async () => {
    const made = await link(admin, ali, omar, 'father');
    expect((await del(admin, `/patients/${mona}/family/${made.body.member.linkId}`)).status).toBe(404);
    expect((await del(admin, `/patients/${ali}/family/99999`)).status).toBe(404);
    expect((await del(admin, `/patients/${ali}/family/${made.body.member.linkId}`)).status).toBe(204);
    expect((await del(admin, `/patients/${ali}/family/${made.body.member.linkId}`)).status).toBe(404);
  });
});

describe('a link never widens what someone may see', () => {
  it('keeps an external specialist to his own patients: he cannot link to, list or unlink a patient who is not his', async () => {
    // Ali (Aya's patient) is linked to the specialist's own patient.
    const made = await link(admin, ali, extKid, 'son');
    expect((await ext.get(`/patients/${ali}/family`)).status).toBe(404); // Ali is not his
    expect((await link(ext, extKid, ali, 'father')).status).toBe(404);
    expect((await del(ext, `/patients/${extKid}/family/${made.body.member.linkId}`)).status).toBe(404);
    // his own patient's list leaves out the relative he may not see
    expect(await list(ext, extKid)).toEqual([]);
    // two of his own can be linked
    const mine = await t.db('patients').insert({ patient_identifier: '2005', fname: 'Mine', lname: 'Haddad', phone: '70333', doctor_id: s.externalDoctorId, ...stamp });
    expect((await link(ext, extKid, mine[0]!, 'sibling')).status).toBe(201);
    expect((await list(ext, extKid)).map((m) => m.patientId)).toEqual([mine[0]]);
    expect((await list(admin, extKid)).map((m) => m.patientId).sort()).toEqual([ali, mine[0]!].sort());
    await t.db('patients').where({ id: mine[0] }).del();
  });

  it('is removed with the patient when an admin erases them from the Trash', async () => {
    await link(admin, ali, omar, 'father');
    await link(admin, ali, mona, 'sibling');
    await t.db('patients').where({ id: ali }).update({ deleted_at: '2026-10-01 00:00:00', deleted_by: 1 });
    const res = await admin.agent.delete(`/api/v1/trash/patient/${ali}`).set('x-csrf-token', admin.csrf).send({ confirm: 'Ali Haddad' });
    expect(res.status).toBe(204);
    expect(await t.db('patient_relatives').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect(await list(admin, omar)).toEqual([]);
  });
});
