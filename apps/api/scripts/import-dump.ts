import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db/connection';
import { IMPORT_TABLES, ImportError, importDump } from '../src/db/importDump';
import { migrateLatest } from '../src/db/migrate';

// Usage: npm run db:import -- [path/to/dump.sql] [--reset]
const args = process.argv.slice(2);
const reset = args.includes('--reset');
const file = resolve(args.find((a) => !a.startsWith('--')) ?? '../../aya_clinic.sql');

const env = loadEnv();
const db = createDb(env);
try {
  await migrateLatest(db);

  const populated: string[] = [];
  for (const table of IMPORT_TABLES) {
    const row = await db(table).count({ n: '*' }).first();
    if (Number(row?.n) > 0) populated.push(table);
  }
  if (populated.length && !reset) {
    console.error(`Database already contains data (${populated.join(', ')}).`);
    console.error('Re-run with --reset to wipe those tables and import again (development databases only).');
    process.exitCode = 1;
  } else {
    if (populated.length) {
      if (env.NODE_ENV === 'production') throw new Error('Refusing --reset when NODE_ENV=production');
      await db.transaction(async (trx) => {
        // Dental units are not in the dump but block deleting doctors and clinics, so they go first
        // (after the appointments that use them).
        await trx('offer_items').del();
        await trx('appointments').del();
        await trx('dental_units').del();
        for (const table of [...IMPORT_TABLES].reverse()) await trx(table).del();
      });
      console.log('Existing data removed.');
    }

    console.log(`Importing ${file}`);
    const report = await importDump(db, readFileSync(file, 'utf8'));

    console.table(
      Object.entries(report.tables).map(([table, t]) => ({
        table,
        parsed: t.parsed,
        imported: t.imported,
        'columns not carried over': t.skippedColumns.join(', '),
      })),
    );
    console.table(
      report.moneySums.map((m) => ({
        column: m.column,
        'raw total': (m.rawCents / 100).toFixed(2),
        'database total': (m.dbCents / 100).toFixed(2),
        match: m.ok ? 'yes' : 'NO',
      })),
    );
    console.log(report.ok ? 'Import verified: row counts and money totals match.' : 'VERIFICATION FAILED');
    if (!report.ok) process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof ImportError ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
