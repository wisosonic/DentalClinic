import type { Knex } from 'knex';

/**
 * Family links (owner request 2026-10-09): clinic staff link patients who are related. A row says "relative is the
 * patient's <relation>" (father, mother, son, daughter, sibling) and is shown from both sides. A pair is linked once,
 * in either direction. Nothing financial hangs on it, so it goes with either patient (CASCADE).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('patient_relatives', (t) => {
    t.increments('id');
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('relative_id').unsigned().notNullable().references('id').inTable('patients').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('relation', 12).notNullable(); // father | mother | son | daughter | sibling
    t.integer('created_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['patient_id', 'relative_id'], 'patient_relatives_patient_id_relative_id_unique');
    t.index(['relative_id'], 'patient_relatives_relative_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('patient_relatives');
}
