import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type TestApp } from './helpers';
import { runAuditRetention } from '../src/modules/audit/retention';
import { runTrashRetention } from '../src/modules/trash/retention';

/** Trash and activity-log retention (owner request 2026-10-07) and the CSV export of the log. */
let t: TestApp;
let admin: Client, doctor: Client, staff: Client, patient: Client;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
const ctx = () => ({ db: t.db, env: t.env, logger: pino({ level: 'silent' }), clock: () => NOW });
/** A moment this many days before the test's "now", as the database writes it. */
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
const setRetention = (trashDays: number, auditDays: number) => admin.put('/settings/retention', { trashDays, auditDays });

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  await seedClinic(t);
  [admin, doctor, staff, patient] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['expenses', 'audit_log']) await t.db(table).del();
  await t.db('app_settings').where('key', 'like', 'retention.%').del();
});

const expense = async (deletedDaysAgo: number | null) =>
  (await t.db('expenses').insert({ date: '2026-09-01', type: 'clinic', amount: 10, currency: '$', ...stamp, deleted_at: deletedDaysAgo === null ? null : ago(deletedDaysAgo) }))[0]!;
const exists = async (id: number) => !!(await t.db('expenses').where({ id }).first('id'));
const log = (action: string) => t.db('audit_log').where({ action }).select('*');

describe('settings: retention', () => {
  it('starts at 0 (never), saves, and refuses silly values', async () => {
    expect((await admin.get('/settings/retention')).body).toEqual({ trashDays: 0, auditDays: 0 });
    expect((await setRetention(30, 365)).body).toEqual({ trashDays: 30, auditDays: 365 });
    expect((await setRetention(3, 0)).status).toBe(400); // a Trash that empties in under a week
    expect((await setRetention(0, 10)).status).toBe(400); // a log that is trimmed in under a month
    expect((await setRetention(0, 99999)).status).toBe(400);
    expect((await admin.get('/settings/retention')).body).toEqual({ trashDays: 30, auditDays: 365 });
    for (const c of [doctor, staff, patient]) expect((await c.get('/settings/retention')).status).toBe(403);
  });
});

describe('Trash retention', () => {
  it('does nothing while it is 0', async () => {
    const old = await expense(500);
    expect(await runTrashRetention(ctx())).toBe(0);
    expect(await exists(old)).toBe(true);
  });

  it('erases what has been in the Trash longer than the chosen days, and only that', async () => {
    await setRetention(30, 0);
    const old = await expense(40);
    const recent = await expense(5);
    const live = await expense(null);
    expect(await runTrashRetention(ctx())).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(live)).toBe(true);
    // one entry: how many of what kind, never what they were
    const [entry] = await log('trash.autopurge');
    expect(JSON.parse(entry.diff)).toEqual({ days: 30, erased: { expense: 1 } });
    expect(entry.user_id).toBeNull();
    expect(await runTrashRetention(ctx())).toBe(0); // nothing left to do
    expect(await log('trash.autopurge')).toHaveLength(1);
  });

  it('erases an old deleted patient together with what belongs to them, like the Trash does', async () => {
    await setRetention(30, 0);
    const pid = (await t.db('patients').insert({ fname: 'Old', lname: 'Record', patient_identifier: 'RET-1', phone: '70000000', ...stamp, deleted_at: ago(60) }))[0]!;
    const offer = (await t.db('treatment_offers').insert({ title: 'Crown', type: 'treatment', price: 100, cost: 0, currency: '$', status: 'accepted', patient_id: pid, ...stamp }))[0]!;
    await t.db('payments').insert({ date: '2026-09-01', type: 'clinic', amount: 50, remaining: 50, currency: '$', offer_id: offer, ...stamp });
    await runTrashRetention(ctx());
    expect(await t.db('patients').where({ id: pid }).first()).toBeUndefined();
    expect(await t.db('treatment_offers').where({ id: offer }).first()).toBeUndefined();
    expect(await t.db('payments').where({ offer_id: offer }).first()).toBeUndefined();
    expect(JSON.parse((await log('trash.autopurge'))[0].diff).erased).toEqual({ patient: 1 });
  });
});

describe('activity-log retention', () => {
  it('removes entries older than the chosen days and keeps the rest', async () => {
    const row = (action: string, days: number) => ({ action, created_at: ago(days) });
    await t.db('audit_log').insert([row('patient.view', 400), row('patient.view', 100), row('patient.view', 2)]);
    expect(await runAuditRetention(ctx())).toBe(0); // off
    await setRetention(0, 365);
    await t.db('audit_log').where('action', 'settings.retention.update').del();
    expect(await runAuditRetention(ctx())).toBe(1);
    expect(await t.db('audit_log').where({ action: 'patient.view' }).count({ n: '*' }).first()).toMatchObject({ n: 2 });
    expect(JSON.parse((await log('audit.retention'))[0].diff)).toEqual({ days: 365, removed: 1 });
  });
});

describe('GET /audit-log/export.csv', () => {
  it('is for admins only', async () => {
    for (const c of [doctor, staff, patient]) expect((await c.get('/audit-log/export.csv')).status).toBe(403);
    expect([401, 403]).toContain((await t.client().get('/audit-log/export.csv')).status);
  });

  it('downloads every entry the filters select, oldest first, and logs the download', async () => {
    await t.db('audit_log').insert([
      { action: 'patient.update', entity: 'patient', entity_id: '7', diff: '{"fields":["fname"]}', ip: '10.0.0.1', created_at: '2026-09-02 10:00:00' },
      { action: 'patient.view', entity: 'patient', entity_id: '7', created_at: '2026-09-01 09:00:00' },
      { action: 'expense.create', entity: 'expense', entity_id: '3', created_at: '2026-08-01 09:00:00' },
    ]);
    const res = await admin.get('/audit-log/export.csv?from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="activity-log-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.charCodeAt(0)).toBe(0xfeff); // the mark that makes Excel read it as UTF-8
    const lines = res.text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('When (UTC),Person,Action,Record type,Record id,Details,IP address');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('patient.view');
    expect(lines[2]).toBe('2026-09-02 10:00:00,,patient.update,patient,7,"{""fields"":[""fname""]}",10.0.0.1');
    expect(res.text).not.toContain('expense.create');
    const [entry] = await log('audit.export');
    expect(JSON.parse(entry.diff)).toEqual({ rows: 2, from: '2026-09-01', to: '2026-09-30' });
  });

  it('keeps a spreadsheet from running a cell as a formula', async () => {
    await t.db('audit_log').insert({ action: '=HYPERLINK("x")', created_at: '2026-09-01 09:00:00' });
    const res = await admin.get('/audit-log/export.csv');
    expect(res.text).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
