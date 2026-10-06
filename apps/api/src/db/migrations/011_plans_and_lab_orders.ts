import type { Knex } from 'knex';

/**
 * Phase 6: treatment plans and lab orders can be soft deleted (into the Trash), with who did it.
 * The tables themselves were made in migration 003.
 */
export async function up(knex: Knex): Promise<void> {
  for (const table of ['treatment_plans', 'lab_orders']) {
    await knex.schema.alterTable(table, (t) => {
      t.timestamp('deleted_at').nullable();
      t.integer('deleted_by').unsigned().nullable(); // no FK: the record of who deleted outlives the account
      t.index(['deleted_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const sqlite = knex.client.config.client === 'better-sqlite3';
  for (const table of ['lab_orders', 'treatment_plans']) {
    for (const c of ['deleted_by', 'deleted_at']) {
      if (sqlite) {
        if (c === 'deleted_at') await knex.raw(`DROP INDEX IF EXISTS ${table}_deleted_at_index`);
        await knex.raw(`ALTER TABLE ${table} DROP COLUMN ${c}`);
      } else {
        await knex.schema.alterTable(table, (t) => t.dropColumn(c));
      }
    }
  }
}
