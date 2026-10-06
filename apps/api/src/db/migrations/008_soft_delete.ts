import type { Knex } from 'knex';

/**
 * Soft delete for appointments and reports (patients already have `deleted_at`), and who did it.
 * `deleted_by` has no foreign key: the record of who deleted must outlive the account.
 */
export async function up(knex: Knex): Promise<void> {
  for (const table of ['appointments', 'reports']) {
    await knex.schema.alterTable(table, (t) => {
      t.timestamp('deleted_at').nullable();
      t.integer('deleted_by').unsigned().nullable();
      t.index(['deleted_at']);
    });
  }
  await knex.schema.alterTable('patients', (t) => {
    t.integer('deleted_by').unsigned().nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  const drop = async (table: string, columns: string[]) => {
    for (const c of columns) {
      if (knex.client.config.client === 'better-sqlite3') {
        if (c === 'deleted_at') await knex.raw(`DROP INDEX IF EXISTS ${table}_deleted_at_index`);
        await knex.raw(`ALTER TABLE ${table} DROP COLUMN ${c}`);
      } else {
        await knex.schema.alterTable(table, (t) => t.dropColumn(c));
      }
    }
  };
  await drop('patients', ['deleted_by']);
  await drop('reports', ['deleted_at', 'deleted_by']);
  await drop('appointments', ['deleted_at', 'deleted_by']);
}
