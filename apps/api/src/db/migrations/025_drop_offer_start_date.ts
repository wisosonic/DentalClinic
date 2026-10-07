import type { Knex } from 'knex';

/**
 * A treatment offer is a plan, so it has no start date of its own: dates belong to the visits booked for its items
 * (owner decision 2026-10-06). The column came from the old treatment plans and nothing reads it any more. No offer
 * in the clinic's data had one set when it was dropped.
 */
export async function up(knex: Knex): Promise<void> {
  if (knex.client.config.client === 'better-sqlite3') {
    // native drop: knex would rebuild the table, which other tables point at
    await knex.raw('ALTER TABLE treatment_offers DROP COLUMN start_date');
  } else {
    await knex.schema.alterTable('treatment_offers', (t) => t.dropColumn('start_date'));
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('treatment_offers', (t) => t.date('start_date').nullable());
}
