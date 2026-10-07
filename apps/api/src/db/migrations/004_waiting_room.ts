import type { Knex } from 'knex';

/**
 * The waiting room (owner request 2026-10-07): when a patient arrives, staff give them a number; the treating
 * doctor sees the patients waiting for him and calls them by number; a screen in the waiting room shows the
 * number called and the dental unit to go to. A ticket belongs to one day and one clinic (numbers start again at 1
 * every day), to a patient, a doctor and a dental unit, and optionally to the appointment the patient came for.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('waiting_tickets', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.integer('number').notNullable();
    t.integer('clinic_id').unsigned().nullable().references('id').inTable('clinics').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('id').inTable('doctors').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('unit_id').unsigned().nullable().references('id').inTable('dental_units').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('appointment_id').unsigned().nullable().references('id').inTable('appointments').onDelete('SET NULL').onUpdate('CASCADE');
    t.string('status', 12).notNullable().defaultTo('waiting'); // waiting | called | done | left
    t.timestamp('arrived_at').notNullable();
    t.timestamp('called_at').nullable();
    t.integer('call_count').notNullable().defaultTo(0);
    t.timestamp('finished_at').nullable();
    t.integer('created_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['clinic_id', 'date', 'number'], 'waiting_tickets_clinic_id_date_number_unique');
    t.index(['date', 'status'], 'waiting_tickets_date_status_index');
    t.index(['patient_id'], 'waiting_tickets_patient_id_index');
    t.index(['doctor_id', 'date'], 'waiting_tickets_doctor_id_date_index');
    t.index(['unit_id'], 'waiting_tickets_unit_id_index');
    t.index(['appointment_id'], 'waiting_tickets_appointment_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('waiting_tickets');
}
