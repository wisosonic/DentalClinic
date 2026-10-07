import type { Knex } from 'knex';

/**
 * A document can be marked "visible to the patient" (owner decision 2026-10-07). Nothing is visible by default; the
 * patient portal (phase 8) will show only what is marked. Until then the mark is stored and shown to the clinic.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('patient_documents', (t) => {
    t.boolean('patient_visible').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('patient_documents', (t) => t.dropColumn('patient_visible'));
}
