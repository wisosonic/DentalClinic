import type { Knex } from 'knex';

/**
 * A declared tax year of the current year can be reopened (owner rule, 2026-10-05): the declaration is kept
 * as a voided record, with who and when, and a new one can be made later. `active_scope` is the taxpayer
 * while a declaration stands and NULL once voided, so "one standing declaration per year and taxpayer" stays
 * a unique key (NULLs do not clash).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tax_declarations', (t) => {
    t.string('active_scope', 32).nullable();
    t.timestamp('voided_at').nullable();
    t.integer('voided_by').unsigned().nullable(); // no FK: the record of who did it outlives the account
  });
  await knex('tax_declarations').update({ active_scope: knex.ref('scope') });
  await knex.schema.alterTable('tax_declarations', (t) => {
    t.dropUnique(['year', 'scope']);
    t.unique(['year', 'active_scope']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex('tax_declarations').whereNotNull('voided_at').del(); // voided records have no place in the older shape
  await knex.schema.alterTable('tax_declarations', (t) => {
    t.dropUnique(['year', 'active_scope']);
  });
  const sqlite = String(knex.client.config.client).includes('sqlite');
  for (const column of ['voided_by', 'voided_at', 'active_scope']) {
    if (sqlite) await knex.raw(`ALTER TABLE tax_declarations DROP COLUMN ${column}`);
    else await knex.schema.alterTable('tax_declarations', (t) => t.dropColumn(column));
  }
  await knex.schema.alterTable('tax_declarations', (t) => {
    t.unique(['year', 'scope']);
  });
}
