import type { Knex } from 'knex';
import { money, ref, timestamps } from './helpers';

/**
 * Domain schema, translated from aya_clinic.sql with the fixes from the plan:
 *  - money columns are DECIMAL(12,2), dates are DATE, `ammount` is spelled `amount`
 *  - appointment_tooth references `teeth` (the dump pointed at a non-existent `tooths`)
 *  - financial rows use RESTRICT foreign keys and soft delete instead of cascading deletes
 *  - Laravel infrastructure tables (cache, jobs, sessions, ...) are not recreated
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('email').notNullable().unique();
    t.timestamp('email_verified_at').nullable();
    t.string('password').notNullable();
    t.string('role', 20).notNullable().defaultTo('staff'); // admin | doctor | staff | patient
    t.boolean('change_password').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('failed_logins').notNullable().defaultTo(0);
    t.timestamp('locked_until').nullable();
    t.timestamp('last_login_at').nullable();
    timestamps(t);
  });

  // Kept as-is until the owner explains the permission string (see CLAUDE.md).
  await knex.schema.createTable('roles', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('role').notNullable();
    timestamps(t);
  });
  await knex.schema.createTable('role_user', (t) => {
    t.increments('id');
    ref(t, 'role_id', 'roles');
    ref(t, 'user_id', 'users');
    timestamps(t);
  });

  await knex.schema.createTable('doctors', (t) => {
    t.increments('id');
    t.string('fname').notNullable();
    t.string('lname').notNullable();
    t.string('email').nullable();
    t.string('speciality').nullable();
    t.string('gender').nullable();
    t.string('phone').nullable();
    t.string('address').nullable();
    t.string('facebook').nullable();
    t.string('instagram').nullable();
    t.string('twitter').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('clinics', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('phone').nullable();
    t.string('address').nullable();
    t.string('type').nullable();
    t.string('latitude').nullable();
    t.string('longitude').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('clinic_doctor', (t) => {
    t.increments('id');
    ref(t, 'doctor_id', 'doctors');
    ref(t, 'clinic_id', 'clinics');
    // Unconfirmed whether this is a percentage or an amount (plan section 14, Q1).
    money(t, 'dr_part').notNullable().defaultTo(0);
    t.text('schedule').nullable(); // free text today, e.g. "09 AM - 07 PM"
    timestamps(t);
  });

  await knex.schema.createTable('patients', (t) => {
    t.increments('id');
    t.string('patient_identifier').notNullable().unique();
    t.string('fname').notNullable();
    t.string('lname').notNullable();
    t.string('phone').notNullable();
    t.date('date_of_birth').nullable();
    t.string('gender').nullable();
    t.string('email').nullable();
    t.string('address').nullable();
    t.datetime('last_visit').nullable();
    t.text('description').nullable();
    ref(t, 'user_id', 'users', { nullable: true, onDelete: 'SET NULL' });
    ref(t, 'doctor_id', 'doctors', { nullable: true, onDelete: 'SET NULL' });
    t.timestamp('deleted_at').nullable();
    timestamps(t);
    t.index(['lname', 'fname']);
    t.index(['phone']);
  });

  await knex.schema.createTable('categories', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    money(t, 'price_min').notNullable().defaultTo(0);
    money(t, 'price_max').notNullable().defaultTo(0);
    t.text('features').notNullable().defaultTo('[]'); // JSON array
    t.text('feature_prices').notNullable().defaultTo('[]'); // JSON array
    timestamps(t);
  });

  await knex.schema.createTable('teeth', (t) => {
    t.increments('id');
    t.string('index').notNullable().unique(); // FDI number
    t.string('name').notNullable();
    t.string('type').notNullable();
    timestamps(t);
  });

  await knex.schema.createTable('promotions', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.string('type').notNullable();
    t.string('code').notNullable();
    t.string('discount').notNullable();
    t.datetime('expiry_date').notNullable();
    t.string('status').notNullable();
    timestamps(t);
  });

  await knex.schema.createTable('events', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.datetime('date').notNullable();
    t.string('location').notNullable();
    t.string('latitude').nullable();
    t.string('longitude').nullable();
    t.text('description').notNullable();
    ref(t, 'promotion_id', 'promotions', { nullable: true, onDelete: 'SET NULL' });
    timestamps(t);
  });
  await knex.schema.createTable('event_patient', (t) => {
    t.increments('id');
    ref(t, 'event_id', 'events');
    ref(t, 'patient_id', 'patients');
    timestamps(t);
  });

  await knex.schema.createTable('quotes', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.string('type').notNullable();
    money(t, 'cost').notNullable().defaultTo(0);
    money(t, 'price').notNullable().defaultTo(0);
    t.string('currency', 8).notNullable();
    t.string('status').notNullable();
    t.string('description').nullable();
    ref(t, 'patient_id', 'patients', { nullable: true, onDelete: 'RESTRICT' });
    ref(t, 'event_id', 'events', { nullable: true, onDelete: 'SET NULL' });
    t.timestamp('deleted_at').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('appointments', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.string('time', 5).notNullable(); // 'HH:MM'
    t.string('status').notNullable();
    t.text('intended').nullable();
    ref(t, 'patient_id', 'patients', { onDelete: 'RESTRICT' });
    ref(t, 'doctor_id', 'doctors', { onDelete: 'RESTRICT' });
    ref(t, 'clinic_id', 'clinics', { onDelete: 'RESTRICT' });
    ref(t, 'quote_id', 'quotes', { nullable: true, onDelete: 'SET NULL' });
    timestamps(t);
    t.index(['doctor_id', 'date', 'time']);
    t.index(['patient_id', 'date']);
    t.index(['date']);
  });
  await knex.schema.createTable('appointment_category', (t) => {
    t.increments('id');
    ref(t, 'appointment_id', 'appointments');
    ref(t, 'category_id', 'categories', { onDelete: 'RESTRICT' });
    timestamps(t);
  });
  await knex.schema.createTable('appointment_tooth', (t) => {
    t.increments('id');
    ref(t, 'appointment_id', 'appointments');
    ref(t, 'tooth_id', 'teeth', { onDelete: 'RESTRICT' });
    t.text('description').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('payments', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.string('type').nullable();
    money(t, 'amount').notNullable();
    money(t, 'remaining').nullable();
    t.string('currency', 8).notNullable();
    t.text('description').nullable();
    money(t, 'dr_part').nullable();
    ref(t, 'quote_id', 'quotes', { nullable: true, onDelete: 'RESTRICT' });
    t.integer('model_id').nullable(); // supplier/lab reference, resolved by `type`
    t.timestamp('deleted_at').nullable();
    timestamps(t);
    t.index(['date']);
  });

  await knex.schema.createTable('expenses', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.string('type').nullable();
    money(t, 'amount').notNullable();
    t.string('currency', 8).notNullable();
    t.string('description').nullable();
    t.integer('model_id').nullable();
    ref(t, 'user_id', 'users', { nullable: true, onDelete: 'SET NULL' });
    timestamps(t);
    t.index(['date']);
  });

  for (const name of ['labs', 'suppliers']) {
    await knex.schema.createTable(name, (t) => {
      t.increments('id');
      t.string('name').notNullable();
      t.string('personal').nullable();
      t.string('address').nullable();
      t.string('phone').notNullable();
      t.text('description').nullable();
      timestamps(t);
    });
  }

  await knex.schema.createTable('medications', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('type').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('reports', (t) => {
    t.increments('id');
    ref(t, 'appointment_id', 'appointments');
    t.text('summary').nullable();
    timestamps(t);
  });
  await knex.schema.createTable('report_tooth', (t) => {
    t.increments('id');
    ref(t, 'report_id', 'reports');
    ref(t, 'tooth_id', 'teeth', { onDelete: 'RESTRICT' });
    t.date('date').notNullable();
    for (const surface of ['labial', 'buccal', 'lingual', 'mesial', 'distal', 'occlusal']) {
      t.text(surface).nullable();
    }
    timestamps(t);
  });
  await knex.schema.createTable('medication_report', (t) => {
    t.increments('id');
    ref(t, 'medication_id', 'medications', { onDelete: 'RESTRICT' });
    ref(t, 'report_id', 'reports');
    t.string('dose').notNullable();
    t.string('frequency').notNullable();
    t.string('time_unit').notNullable();
    t.text('notes').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('notifications', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.string('content').notNullable();
    t.string('status').notNullable(); // unread | read
    t.string('type', 40).nullable();
    t.string('link').nullable();
    t.timestamp('read_at').nullable();
    t.string('dedupe_key').nullable().unique(); // makes the reminder job idempotent
    ref(t, 'user_id', 'users', { nullable: true });
    ref(t, 'appointment_id', 'appointments', { nullable: true, onDelete: 'SET NULL' });
    timestamps(t);
    t.index(['user_id', 'status']);
  });

  await knex.schema.createTable('numbering', (t) => {
    t.increments('id');
    t.integer('numbering').notNullable();
    timestamps(t);
  });

  await knex.schema.createTable('settings', (t) => {
    t.increments('id');
    t.string('type').notNullable();
    t.string('datatype').notNullable();
    t.string('key').notNullable().unique();
    t.string('value').notNullable();
    t.string('description').notNullable();
    timestamps(t);
  });
}

export async function down(knex: Knex): Promise<void> {
  const tables = [
    'settings', 'numbering', 'notifications', 'medication_report', 'report_tooth', 'reports',
    'medications', 'suppliers', 'labs', 'expenses', 'payments', 'appointment_tooth',
    'appointment_category', 'appointments', 'quotes', 'event_patient', 'events', 'promotions',
    'teeth', 'categories', 'patients', 'clinic_doctor', 'clinics', 'doctors', 'role_user',
    'roles', 'users',
  ];
  for (const t of tables) await knex.schema.dropTableIfExists(t);
}
