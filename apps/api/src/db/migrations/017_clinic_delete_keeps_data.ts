import type { Knex } from 'knex';

/**
 * Deleting a clinic removes the clinic's record only (owner decision, 2026-10-05). Everything that was done at
 * it stays, because it was used for payments, commission and tax calculations: appointments and dental units
 * keep their rows and their `clinic_id` becomes NULL. (Patients, quotes, payments, reports and plans never
 * pointed at a clinic.) A record whose clinic is gone is read-only.
 *
 * SQLite cannot change a foreign key in place, so those two tables are rebuilt the way the SQLite manual
 * describes (foreign keys off, new table, copy, drop, rename, indexes again). That needs a connection outside
 * a transaction, hence `transaction: false`; the rebuild brackets itself in its own transaction.
 */
export const config = { transaction: false };

const sqlite = (knex: Knex) => String(knex.client.config.client).includes('sqlite');

/** Rebuilds one SQLite table with a changed CREATE statement, keeping its rows and its indexes. */
async function rebuild(knex: Knex, table: string, change: (create: string) => string): Promise<void> {
  const row = (await knex.raw('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['table', table]))[0] as { sql: string };
  const indexes = (await knex.raw('SELECT sql FROM sqlite_master WHERE type = ? AND tbl_name = ? AND sql IS NOT NULL', ['index', table])) as { sql: string }[];
  const next = change(row.sql);
  if (next === row.sql) throw new Error(`Migration 017: the ${table} table is not in the expected shape`);
  await knex.raw('PRAGMA foreign_keys = OFF');
  await knex.raw('BEGIN');
  try {
    const temp = `${table}__new`;
    // SQLite writes the name back with double quotes after a rename, so accept quotes, backticks or none
    await knex.raw(next.replace(/^CREATE TABLE\s+(["`]?)\w+\1/i, `CREATE TABLE \`${temp}\``));
    await knex.raw(`INSERT INTO \`${temp}\` SELECT * FROM \`${table}\``);
    await knex.raw(`DROP TABLE \`${table}\``);
    await knex.raw(`ALTER TABLE \`${temp}\` RENAME TO \`${table}\``);
    for (const index of indexes) await knex.raw(index.sql);
    const broken = (await knex.raw('PRAGMA foreign_key_check')) as unknown[];
    if (broken.length) throw new Error(`Migration 017: ${broken.length} foreign key problem(s) after rebuilding ${table}`);
    await knex.raw('COMMIT');
  } catch (err) {
    await knex.raw('ROLLBACK');
    throw err;
  } finally {
    await knex.raw('PRAGMA foreign_keys = ON');
  }
}

/** The clinic foreign key, whatever its delete action is (databases made by different routes differ: RESTRICT or CASCADE). */
const FK = new RegExp('(foreign key\\(`clinic_id`\\) references `clinics`\\(`id`\\) on delete )(RESTRICT|CASCADE|SET NULL|NO ACTION)', 'i');

export async function up(knex: Knex): Promise<void> {
  if (sqlite(knex)) {
    for (const table of ['appointments', 'dental_units']) {
      await rebuild(knex, table, (sql) => sql.replace('`clinic_id` integer not null', '`clinic_id` integer null').replace(FK, '$1SET NULL'));
    }
    return;
  }
  for (const table of ['appointments', 'dental_units']) {
    await knex.schema.alterTable(table, (t) => t.dropForeign(['clinic_id']));
    await knex.schema.alterTable(table, (t) => {
      t.integer('clinic_id').unsigned().nullable().alter();
      t.foreign('clinic_id').references('id').inTable('clinics').onDelete('SET NULL').onUpdate('CASCADE');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['appointments', 'dental_units']) {
    const orphans = (await knex(table).whereNull('clinic_id').count({ n: '*' }).first()) as { n: number } | undefined;
    if (Number(orphans?.n ?? 0) > 0) {
      throw new Error(`Cannot roll back migration 017: ${orphans!.n} ${table} row(s) belong to deleted clinics. Delete them first, or restore from a backup.`);
    }
  }
  if (sqlite(knex)) {
    for (const table of ['appointments', 'dental_units']) {
      await rebuild(knex, table, (sql) => sql.replace('`clinic_id` integer null', '`clinic_id` integer not null').replace(FK, '$1RESTRICT'));
    }
    return;
  }
  for (const table of ['appointments', 'dental_units']) {
    await knex.schema.alterTable(table, (t) => t.dropForeign(['clinic_id']));
    await knex.schema.alterTable(table, (t) => {
      t.integer('clinic_id').unsigned().notNullable().alter();
      t.foreign('clinic_id').references('id').inTable('clinics').onDelete('RESTRICT').onUpdate('CASCADE');
    });
  }
}
