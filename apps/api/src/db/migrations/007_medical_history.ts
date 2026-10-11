import type { Knex } from 'knex';

/**
 * Patient medical history (owner request 2026-10-10): one profile row for each patient (blood type, pregnancy, smoking,
 * notes, and when it was last gone through with the patient) and a list of items: allergies, medical conditions,
 * current medications and past surgeries. Health data for clinic staff only; it goes with the patient (CASCADE:
 * nothing financial hangs on it) and never reaches a patient-facing route.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('patient_medical', (t) => {
    t.increments('id');
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('blood_type', 3).nullable();
    t.string('pregnancy', 3).nullable(); // yes | no
    t.string('smoking', 8).nullable(); // never | former | current
    t.text('notes').nullable();
    t.timestamp('reviewed_at').nullable();
    t.integer('reviewed_by').nullable();
    t.integer('updated_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['patient_id'], 'patient_medical_patient_id_unique');
  });
  await knex.schema.createTable('patient_medical_items', (t) => {
    t.increments('id');
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('kind', 12).notNullable(); // allergy | condition | medication | surgery
    t.string('name', 120).notNullable();
    t.string('severity', 10).nullable(); // allergies: mild | moderate | severe
    t.string('note', 300).nullable();
    t.string('since', 10).nullable(); // a year, a month or a date
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('created_by').nullable();
    t.integer('updated_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['patient_id', 'kind'], 'patient_medical_items_patient_id_kind_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('patient_medical_items');
  await knex.schema.dropTableIfExists('patient_medical');
}
