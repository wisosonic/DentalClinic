import type { Knex } from 'knex';

/**
 * Admins can now create dental units by hand, so an owner doctor may have more than one.
 * Migration 004 limited each owner to one unit per clinic; that restriction goes.
 * (Unit names stay unique within a clinic; the API checks that.)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dental_units', (t) => {
    t.dropUnique(['clinic_id', 'owner_doctor_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  // Fails, by design, if any owner now has several units in one clinic.
  await knex.schema.alterTable('dental_units', (t) => {
    t.unique(['clinic_id', 'owner_doctor_id']);
  });
}
