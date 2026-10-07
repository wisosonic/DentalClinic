import type { Knex } from 'knex';

/**
 * The table that holds treatment offers is renamed from `quotes` to `treatment_offers` (owner request 2026-10-06).
 * Rows, ids and foreign keys are untouched: SQLite and MySQL both repoint the foreign keys of other tables
 * (payments.quote_id, offer_items.offer_id, ...) when a table is renamed. The column `payments.quote_id` keeps its
 * name on purpose.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.renameTable('quotes', 'treatment_offers');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.renameTable('treatment_offers', 'quotes');
}
