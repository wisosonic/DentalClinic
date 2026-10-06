import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { createDb, type Db } from '../src/db/connection';
import { ImportError, importDump, parseDump, toCents } from '../src/db/importDump';
import { migrateLatest } from '../src/db/migrate';

const DUMP = resolve(__dirname, '../../../aya_clinic.sql');

async function freshDb(): Promise<Db> {
  const db = createDb(parseEnv({ DB_FILENAME: ':memory:', JWT_SECRET: 'x'.repeat(32) }));
  await migrateLatest(db);
  return db;
}

let db: Db | undefined;
afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

describe('parseDump', () => {
  it('handles escapes, doubled quotes, NULL, numbers and multiple statements', () => {
    const sql = `
      INSERT INTO \`t\` (\`id\`, \`a\`, \`b\`) VALUES
      (1, 'it\\'s', NULL),
      (2, 'say ''hi''', 'line1\\nline2, (not a tuple);');
      INSERT INTO \`t\` (\`id\`, \`a\`, \`b\`) VALUES (3, 'x', 4.5);`;
    expect(parseDump(sql).t).toEqual({
      columns: ['id', 'a', 'b'],
      rows: [
        [1, "it's", null],
        [2, "say 'hi'", 'line1\nline2, (not a tuple);'],
        [3, 'x', 4.5],
      ],
    });
  });

  it('fails loudly on malformed input instead of skipping rows', () => {
    expect(() => parseDump("INSERT INTO `t` (`a`) VALUES ('unterminated")).toThrow(/Unterminated/);
  });
});

describe('toCents', () => {
  it.each([
    ['100', 10000], ['100.5', 10050], ['0.99', 99], ['1,250.75', 125075], ['-3', -300], [' 7 ', 700],
  ])('parses %s', (input, cents) => expect(toCents(input)).toBe(cents));

  it.each([['abc'], ['12$'], ['1.2.3'], ['']])('rejects %j', (input) => expect(toCents(input)).toBeNull());
});

describe('importDump', () => {
  it('aborts and writes nothing when a money value cannot be parsed', async () => {
    db = await freshDb();
    const sql = `INSERT INTO \`expenses\` (\`id\`, \`date\`, \`type\`, \`ammount\`, \`currency\`) VALUES
      (1, '2025-01-01', 'supplier', '100', '$'),
      (2, '2025-01-02', 'supplier', 'about 50', '$');`;
    await expect(importDump(db, sql)).rejects.toBeInstanceOf(ImportError);
    expect((await db('expenses').count({ n: '*' }).first())!.n).toBe(0);
  });

  it('aborts on impossible dates', async () => {
    db = await freshDb();
    const sql = `INSERT INTO \`expenses\` (\`id\`, \`date\`, \`ammount\`, \`currency\`) VALUES (1, '2025-02-31', '5', '$');`;
    await expect(importDump(db, sql)).rejects.toThrow(/expenses#1\.date/);
  });

  it('renames the misspelled column and converts types', async () => {
    db = await freshDb();
    const sql = `INSERT INTO \`expenses\` (\`id\`, \`date\`, \`ammount\`, \`currency\`) VALUES (1, '2025-02-03', '1,234.50', '$');`;
    const report = await importDump(db, sql);
    expect(report.ok).toBe(true);
    expect(await db('expenses').first()).toMatchObject({ date: '2025-02-03', amount: 1234.5, currency: '$' });
  });

  it.skipIf(!existsSync(DUMP))('imports the real dump with matching row counts, totals and valid foreign keys', async () => {
    db = await freshDb();
    const report = await importDump(db, readFileSync(DUMP, 'utf8'));

    expect(report.ok).toBe(true);
    for (const [table, t] of Object.entries(report.tables)) {
      expect(t.imported, table).toBe(t.parsed);
      const row = await db(table).count({ n: '*' }).first();
      expect(Number(row!.n), table).toBe(t.parsed);
    }
    for (const sum of report.moneySums) expect(sum.dbCents, sum.column).toBe(sum.rawCents);

    // Every constraint holds, including the one that was broken in the original dump.
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);

    // The admin's bcrypt hash and role came across untouched; the Laravel remember token did not.
    const admin = await db('users').where({ email: 'dr.aya.ghali@gmail.com' }).first();
    expect(admin.role).toBe('admin');
    expect(admin.password).toMatch(/^\$2y\$/);
    expect(admin).not.toHaveProperty('remember_token');
    expect(typeof admin.change_password).toBe('number');

    // Doctor kinds, dental units and appointment units are set up after the import.
    const owners = await db('doctors').where({ kind: 'owner' }).pluck('fname');
    expect(owners).toEqual(['Aya']);
    expect(Number((await db('doctors').where({ kind: 'external' }).count({ n: '*' }).first())!.n)).toBe(6);
    expect(await db('dental_units').count({ n: '*' }).first()).toEqual({ n: 1 });
    expect(await db('appointments').whereNull('unit_id').count({ n: '*' }).first()).toEqual({ n: 0 });
    expect((await db('appointments').distinct('duration_minutes').pluck('duration_minutes'))).toEqual([30]);
  });
});
