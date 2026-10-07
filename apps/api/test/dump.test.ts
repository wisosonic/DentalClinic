import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { createDb, type Db } from '../src/db/connection';
import { dumpDatabase, stamp } from '../src/db/dump';
import { migrateLatest } from '../src/db/migrate';
import { seedTeeth } from '../src/db/setup';

let dir: string;
let db: Db;
const env = (extra: Record<string, string> = {}) => parseEnv({ DB_FILENAME: ':memory:', JWT_SECRET: 'x'.repeat(32), UPLOAD_DIR: join(dir, 'uploads'), ...extra });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dump-test-'));
  db = createDb(env());
  await migrateLatest(db);
  await seedTeeth(db);
  const now = '2026-10-07 10:00:00';
  await db('users').insert({ name: 'Admin', email: 'a@clinic.test', password: 'hash', role: 'admin', created_at: now, updated_at: now });
});
afterEach(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe('the database dump', () => {
  it('writes the schema and every row to one file that opens on its own', async () => {
    const out = join(dir, 'backups', 'copy.sqlite');
    const result = await dumpDatabase(db, env(), out);
    expect(result).toMatchObject({ file: out, tables: 37, uploadsDir: null }); // 35 tables + the migration bookkeeping
    expect(result.rows).toBeGreaterThanOrEqual(34); // 32 teeth, a user, the migration record
    const copy = new Database(out, { readonly: true });
    expect((copy.prepare('SELECT COUNT(*) AS n FROM teeth').get() as { n: number }).n).toBe(32);
    expect((copy.prepare('SELECT email FROM users').get() as { email: string }).email).toBe('a@clinic.test');
    expect(copy.prepare('SELECT name FROM knex_migrations').all()).toEqual([{ name: '001_initial_schema' }]); // restores as an up-to-date database
    copy.close();
  });

  it('never overwrites a file that is already there', async () => {
    const out = join(dir, 'copy.sqlite');
    writeFileSync(out, 'precious');
    await expect(dumpDatabase(db, env(), out)).rejects.toThrow(/already exists/);
    expect(readFileSync(out, 'utf8')).toBe('precious');
  });

  it('copies the patient document files only when asked', async () => {
    mkdirSync(join(dir, 'uploads', 'documents'), { recursive: true });
    writeFileSync(join(dir, 'uploads', 'documents', 'doc-aaaaaaaaaaaa.pdf'), 'x');
    const without = await dumpDatabase(db, env(), join(dir, 'a.sqlite'));
    expect(without.uploadsDir).toBeNull();
    const withFiles = await dumpDatabase(db, env(), join(dir, 'b.sqlite'), true);
    expect(withFiles.uploadsDir).toBe(join(dir, 'b-uploads'));
    expect(readdirSync(join(dir, 'b-uploads', 'documents'))).toEqual(['doc-aaaaaaaaaaaa.pdf']);
  });

  it('says so for MySQL instead of pretending', async () => {
    await expect(dumpDatabase(db, env({ DB_CLIENT: 'mysql' }), join(dir, 'c.sqlite'))).rejects.toThrow(/mysqldump/);
  });

  it('names files by the UTC date and time', () => {
    expect(stamp(new Date('2026-10-07T08:05:09Z'))).toBe('20261007-080509');
  });
});
