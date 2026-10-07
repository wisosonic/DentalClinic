import { join } from 'node:path';
import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db/connection';
import { dumpDatabase, stamp } from '../src/db/dump';

// Usage: npm run db:dump [-- <output-file>] [--with-uploads]
// Writes the database (schema and data) to one SQLite file, by default data/backups/dental_clinic-<date>.sqlite,
// and with --with-uploads also copies the patient document files next to it. It never overwrites a file.
const args = process.argv.slice(2);
const withUploads = args.includes('--with-uploads');
const target = args.find((a) => !a.startsWith('--')) ?? join('data', 'backups', `dental_clinic-${stamp()}.sqlite`);

const env = loadEnv();
const db = createDb(env);
try {
  const result = await dumpDatabase(db, env, target, withUploads);
  console.log(`Dump written: ${result.file}`);
  console.log(`  ${result.tables} tables, ${result.rows} rows, ${(result.bytes / 1024).toFixed(0)} KB, integrity check passed`);
  if (result.uploadsDir) console.log(`  Documents copied to: ${result.uploadsDir}`);
  else console.log('  The patient document files are not in the database: copy the uploads folder too (or use --with-uploads).');
  console.log('  Restore: stop the app and copy the file to DB_FILENAME on the new host.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
