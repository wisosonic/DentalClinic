import type { Knex } from 'knex';
import { applyOwnershipDefaults } from '../ownershipDefaults';
import { ref, timestamps } from './helpers';

/**
 * Owner decisions of 2026-10-01:
 *  - appointments have a variable length (`duration_minutes`)
 *  - doctors are owners or externals, and externals carry a commission percentage
 *  - appointments take place on a dental unit, one per owner doctor
 *  - doctors have no fixed working hours, so `clinic_doctor.schedule` goes
 *
 * `appointments.unit_id` stays nullable in the database (SQLite can't make a column NOT NULL
 * without rebuilding the table); the API requires it for every new appointment.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('doctors', (t) => {
    t.string('kind', 10).notNullable().defaultTo('external'); // owner | external
    t.decimal('commission_percent', 5, 2).nullable();
  });

  await knex.schema.createTable('dental_units', (t) => {
    t.increments('id');
    ref(t, 'clinic_id', 'clinics', { onDelete: 'RESTRICT' });
    ref(t, 'owner_doctor_id', 'doctors', { onDelete: 'RESTRICT' });
    t.string('name', 100).notNullable();
    timestamps(t);
    t.unique(['clinic_id', 'owner_doctor_id']);
  });

  await knex.schema.alterTable('appointments', (t) => {
    t.integer('duration_minutes').notNullable().defaultTo(30);
  });
  if (knex.client.config.client === 'better-sqlite3') {
    // Inline REFERENCES keeps SQLite from rebuilding (and cascading through) the appointments table.
    await knex.raw('ALTER TABLE appointments ADD COLUMN unit_id INTEGER REFERENCES dental_units(id) ON DELETE RESTRICT ON UPDATE CASCADE');
    await knex.raw('CREATE INDEX appointments_unit_id_date_time_index ON appointments (unit_id, date, time)');
  } else {
    await knex.schema.alterTable('appointments', (t) => {
      t.integer('unit_id').unsigned().nullable();
      t.foreign('unit_id').references('id').inTable('dental_units').onDelete('RESTRICT').onUpdate('CASCADE');
      t.index(['unit_id', 'date', 'time']);
    });
  }

  await knex.schema.alterTable('clinic_doctor', (t) => {
    t.dropColumn('schedule');
  });

  await applyOwnershipDefaults(knex);
}

export async function down(knex: Knex): Promise<void> {
  if (knex.client.config.client === 'better-sqlite3') {
    // SQLite can only drop these columns by rebuilding tables that other tables reference.
    throw new Error('Rolling back migration 004 is not supported on SQLite. Restore the database from a backup instead.');
  }
  await knex.schema.alterTable('clinic_doctor', (t) => {
    t.text('schedule').nullable();
  });
  await knex.schema.alterTable('appointments', (t) => {
    t.dropIndex(['unit_id', 'date', 'time']);
    t.dropColumn('unit_id');
    t.dropColumn('duration_minutes');
  });
  await knex.schema.dropTableIfExists('dental_units');
  await knex.schema.alterTable('doctors', (t) => {
    t.dropColumn('commission_percent');
    t.dropColumn('kind');
  });
}
