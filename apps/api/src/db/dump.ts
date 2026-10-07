import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Env } from '../config/env';
import type { Db } from './connection';

export interface DumpResult {
  file: string;
  bytes: number;
  tables: number;
  rows: number;
  uploadsDir: string | null;
}

/** `YYYYMMDD-HHMMSS` in UTC, for default file names. */
export const stamp = (d: Date = new Date()): string => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/**
 * Writes the whole database, schema and data, as one consistent SQLite file (`VACUUM INTO`: safe while the app is
 * running, the write-ahead log is folded in). Restoring is copying the file to `DB_FILENAME` on a host where the
 * app is stopped. It never overwrites an existing file. Only the SQLite database can be dumped this way: for MySQL
 * use `mysqldump`. The patient document files are not in the database: `withUploads` copies them next to the dump.
 */
export async function dumpDatabase(db: Db, env: Env, outFile: string, withUploads = false): Promise<DumpResult> {
  if (env.DB_CLIENT === 'mysql') throw new Error('This command dumps the SQLite database. For MySQL, use mysqldump.');
  const file = resolve(outFile);
  if (existsSync(file)) throw new Error(`${file} already exists: choose another name, nothing was overwritten`);
  mkdirSync(dirname(file), { recursive: true });
  await db.raw('VACUUM INTO ?', [file]);

  // Open the copy on its own and check it, so a bad dump is noticed now and not when it is needed.
  const copy = new Database(file, { readonly: true });
  try {
    const check = copy.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`The dump failed its integrity check: ${String(check)}`);
    const names = (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    let rows = 0;
    for (const n of names) rows += (copy.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).get() as { n: number }).n;
    let uploadsDir: string | null = null;
    const source = resolve(env.UPLOAD_DIR);
    if (withUploads && existsSync(source)) {
      uploadsDir = file.replace(/\.sqlite$/, '') + '-uploads';
      cpSync(source, uploadsDir, { recursive: true, errorOnExist: true });
    }
    return { file, bytes: statSync(file).size, tables: names.length, rows, uploadsDir };
  } finally {
    copy.close();
  }
}
