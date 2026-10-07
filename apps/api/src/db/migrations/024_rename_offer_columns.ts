import type { Knex } from 'knex';

/**
 * Finishes the rename started in 023: the columns that point at a treatment offer (`payments.quote_id`,
 * `appointments.quote_id`) become `offer_id`, and the indexes that still carried the old table or column name get
 * the new one. Rows, values and foreign keys are untouched.
 */
const COLUMNS: [table: string, from: string, to: string][] = [
  ['payments', 'quote_id', 'offer_id'],
  ['appointments', 'quote_id', 'offer_id'],
];
const INDEXES: [table: string, column: string, from: string, to: string][] = [
  ['treatment_offers', 'patient_id', 'quotes_patient_id_index', 'treatment_offers_patient_id_index'],
  ['treatment_offers', 'event_id', 'quotes_event_id_index', 'treatment_offers_event_id_index'],
  ['payments', 'offer_id', 'payments_quote_id_index', 'payments_offer_id_index'],
  ['appointments', 'offer_id', 'appointments_quote_id_index', 'appointments_offer_id_index'],
];

export async function up(knex: Knex): Promise<void> {
  for (const [table, from, to] of COLUMNS) {
    await knex.schema.alterTable(table, (t) => t.renameColumn(from, to));
  }
  for (const [table, column, from, to] of INDEXES) {
    await knex.schema.alterTable(table, (t) => { t.dropIndex([], from); t.index([column], to); });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [table, from, to] of COLUMNS) {
    await knex.schema.alterTable(table, (t) => t.renameColumn(to, from));
  }
  for (const [table, column, from, to] of INDEXES) {
    await knex.schema.alterTable(table, (t) => { t.dropIndex([], to); t.index([column === 'offer_id' ? 'quote_id' : column], from); });
  }
}
