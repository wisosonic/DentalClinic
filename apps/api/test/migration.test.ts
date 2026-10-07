import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { createDb, type Db } from '../src/db/connection';
import { migrationConfig, migrationNames, migrateLatest } from '../src/db/migrate';
import { TEETH, createFirstAdmin, seedTeeth } from '../src/db/setup';
import { verifyPassword } from '../src/lib/password';

let db: Db | undefined;
afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

const fresh = (): Db => (db = createDb(parseEnv({ DB_FILENAME: ':memory:', JWT_SECRET: 'x'.repeat(32) })));

describe('the schema (one migration, for a new installation)', () => {
  it('creates every table, with consistent foreign keys, and rolls back to nothing', async () => {
    const conn = fresh();
    expect(await migrateLatest(conn)).toEqual(migrationNames);
    expect(await migrateLatest(conn)).toEqual([]); // nothing left to do
    const tables = ((await conn.raw("SELECT name FROM sqlite_master WHERE type = 'table'")) as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      'users', 'patients', 'doctors', 'clinics', 'dental_units', 'appointments', 'treatment_offers', 'offer_items', 'payments', 'expenses',
      'reports', 'teeth', 'patient_documents', 'role_permissions', 'report_jobs', 'notifications', 'audit_log',
    ]));
    expect(tables).not.toContain('quotes'); // the table of treatment offers is called treatment_offers
    expect(await conn.raw('PRAGMA foreign_key_check')).toEqual([]);
    const offerColumns = Object.keys(await conn('treatment_offers').columnInfo());
    expect(offerColumns).not.toContain('start_date'); // dates belong to the booked visits
    expect(Object.keys(await conn('payments').columnInfo())).toContain('offer_id');

    await conn.migrate.rollback(migrationConfig, true); // every migration, newest first
    const left = ((await conn.raw("SELECT name FROM sqlite_master WHERE type = 'table'")) as { name: string }[]).map((t) => t.name).filter((n) => !n.startsWith('knex_') && n !== 'sqlite_sequence');
    expect(left).toEqual([]);
  });

  it('refuses a booking row that points at a patient that does not exist', async () => {
    const conn = fresh();
    await migrateLatest(conn);
    await expect(conn('appointments').insert({ date: '2026-10-07', time: '10:00', status: 'pending', patient_id: 999, doctor_id: 999 })).rejects.toThrow();
  });
});

describe('what a new installation starts with', () => {
  it('has the 32 teeth, added once however often it is asked', async () => {
    const conn = fresh();
    await migrateLatest(conn);
    expect(await seedTeeth(conn)).toBe(32);
    expect(await seedTeeth(conn)).toBe(0);
    const teeth = await conn('teeth').orderBy('id').select('index', 'name', 'type');
    expect(teeth).toHaveLength(32);
    expect(teeth.map((t) => t.index)).toEqual(TEETH.map((t) => t.index));
    expect(teeth[0]).toEqual({ index: '18', name: 'Upper right third molar', type: 'Molar' });
    expect(teeth[31]).toEqual({ index: '48', name: 'Lower right third molar', type: 'Molar' });
    expect(new Set(teeth.map((t) => t.type))).toEqual(new Set(['Incisor', 'Canine', 'Premolar', 'Molar']));
  });

  it('gets one first administrator who must change the password, and never a second one', async () => {
    const conn = fresh();
    await migrateLatest(conn);
    const first = await createFirstAdmin(conn, { name: 'Dr Owner', email: 'Owner@Clinic.Example' }, 4);
    expect(first.created).toBe(true);
    expect(first.password).toBeTruthy(); // shown once
    const user = await conn('users').first();
    expect(user).toMatchObject({ email: 'owner@clinic.example', role: 'admin', is_active: 1, change_password: 1 });
    expect(await verifyPassword(first.password!, user.password)).toBe(true);
    expect(user.password).not.toContain(first.password!); // only the hash is stored
    expect(await createFirstAdmin(conn, { name: 'Someone', email: 'other@clinic.example' }, 4)).toEqual({ created: false });
    expect(await conn('users').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('refuses a bad email, an empty name and a weak password, creating nobody', async () => {
    const conn = fresh();
    await migrateLatest(conn);
    await expect(createFirstAdmin(conn, { name: 'A', email: 'not-an-email' }, 4)).rejects.toThrow(/email/);
    await expect(createFirstAdmin(conn, { name: ' ', email: 'a@b.example' }, 4)).rejects.toThrow(/name/);
    await expect(createFirstAdmin(conn, { name: 'A', email: 'a@b.example', password: '123' }, 4)).rejects.toThrow();
    expect(await conn('users').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });
});

describe('migration 003: usernames for the patients that exist', () => {
  it('gives each one a unique username made from the name, and leaves the logins alone', async () => {
    const conn = fresh();
    await conn.migrate.up(migrationConfig); // 001
    await conn.migrate.up(migrationConfig); // 002
    const now = '2026-10-07 10:00:00';
    const [doctor] = await conn('doctors').insert({ fname: 'Aya', lname: 'Ghali', kind: 'owner', created_at: now, updated_at: now });
    const rows: [string, string, string][] = [['1', 'Hicham', 'Cheaib'], ['2', 'Hicham', 'Cheaib'], ['3', 'Élie', 'Abi Nader'], ['4', 'عبد', 'الله'], ['5', 'Zoë', '']];
    for (const [number, fname, lname] of rows) {
      await conn('patients').insert({ patient_identifier: `10000${number}`, fname, lname, phone: number, doctor_id: doctor, created_at: now, updated_at: now });
    }
    await conn.migrate.up(migrationConfig); // 003
    const names = (await conn('patients').orderBy('id').pluck('username')) as string[];
    expect(names).toEqual(['hicham.cheaib', 'hicham.cheaib2', 'elie.abinader', 'patient100004', 'zoe']);
    expect(new Set(names).size).toBe(names.length);
    expect(await conn('users').whereNotNull('username').count({ n: '*' }).first()).toMatchObject({ n: 0 }); // a login gets its username with the card
    await expect(conn('patients').where({ id: 2 }).update({ username: 'hicham.cheaib' })).rejects.toThrow(); // unique
    await conn.migrate.down(migrationConfig);
    expect(Object.keys(await conn('patients').columnInfo())).not.toContain('username');
  });
});
