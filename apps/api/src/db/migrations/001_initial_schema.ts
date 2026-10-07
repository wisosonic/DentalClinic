import type { Knex } from 'knex';

/**
 * The whole schema in one migration. The project is deployed from zero on a new server (owner decision
 * 2026-10-07): there is no older database to upgrade, so the history of changes made while it was built was
 * squashed into this file. Everything here must stay portable to MariaDB/MySQL (Knex builder only).
 * Dates are DATE columns holding 'YYYY-MM-DD'; money is DECIMAL(12,2); financial rows are soft-deleted
 * (`deleted_at`) and use RESTRICT foreign keys.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('email').notNullable();
    t.timestamp('email_verified_at').nullable();
    t.string('password').notNullable();
    t.string('role', 20).notNullable().defaultTo('staff');
    t.boolean('change_password').notNullable().defaultTo(false);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('failed_logins').notNullable().defaultTo(0);
    t.timestamp('locked_until').nullable();
    t.timestamp('last_login_at').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['email'], 'users_email_unique');
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
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.string('kind', 10).notNullable().defaultTo('external');
    t.decimal('commission_percent', 5, 2).nullable();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL').onUpdate('CASCADE');
    t.boolean('tax_spouse').notNullable().defaultTo(false);
    t.integer('tax_children').notNullable().defaultTo(0);
    t.unique(['user_id'], 'doctors_user_id_unique');
  });

  await knex.schema.createTable('clinics', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('phone').nullable();
    t.string('address').nullable();
    t.string('type').nullable();
    t.string('latitude').nullable();
    t.string('longitude').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.string('logo_file', 80).nullable();
  });

  await knex.schema.createTable('patients', (t) => {
    t.increments('id');
    t.string('patient_identifier').notNullable();
    t.string('fname').notNullable();
    t.string('lname').notNullable();
    t.string('phone').notNullable();
    t.date('date_of_birth').nullable();
    t.string('gender').nullable();
    t.string('email').nullable();
    t.string('address').nullable();
    t.timestamp('last_visit').nullable();
    t.text('description').nullable();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('doctor_id').unsigned().nullable().references('id').inTable('doctors').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('deleted_at').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.integer('deleted_by').nullable();
    t.index(['phone'], 'patients_phone_index');
    t.index(['lname', 'fname'], 'patients_lname_fname_index');
    t.index(['doctor_id'], 'patients_doctor_id_index');
    t.index(['user_id'], 'patients_user_id_index');
    t.unique(['patient_identifier'], 'patients_patient_identifier_unique');
  });

  await knex.schema.createTable('categories', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.decimal('price_min', 12, 2).notNullable().defaultTo(0);
    t.decimal('price_max', 12, 2).notNullable().defaultTo(0);
    t.text('features').notNullable().defaultTo('[]');
    t.text('feature_prices').notNullable().defaultTo('[]');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
  });

  await knex.schema.createTable('teeth', (t) => {
    t.increments('id');
    t.string('index').notNullable();
    t.string('name').notNullable();
    t.string('type').notNullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['index'], 'teeth_index_unique');
  });

  await knex.schema.createTable('promotions', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.string('type').notNullable();
    t.string('code').notNullable();
    t.string('discount').notNullable();
    t.timestamp('expiry_date').notNullable();
    t.string('status').notNullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
  });

  await knex.schema.createTable('events', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.timestamp('date').notNullable();
    t.string('location').notNullable();
    t.string('latitude').nullable();
    t.string('longitude').nullable();
    t.text('description').notNullable();
    t.integer('promotion_id').unsigned().nullable().references('id').inTable('promotions').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['promotion_id'], 'events_promotion_id_index');
  });

  await knex.schema.createTable('event_patient', (t) => {
    t.increments('id');
    t.integer('event_id').unsigned().notNullable().references('id').inTable('events').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('CASCADE').onUpdate('CASCADE');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['patient_id'], 'event_patient_patient_id_index');
    t.index(['event_id'], 'event_patient_event_id_index');
  });

  await knex.schema.createTable('treatment_offers', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.string('type').notNullable();
    t.decimal('cost', 12, 2).notNullable().defaultTo(0);
    t.decimal('price', 12, 2).notNullable().defaultTo(0);
    t.string('currency', 8).notNullable();
    t.string('status').notNullable();
    t.string('description').nullable();
    t.integer('patient_id').unsigned().nullable().references('id').inTable('patients').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('event_id').unsigned().nullable().references('id').inTable('events').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('deleted_at').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.integer('deleted_by').nullable();
    t.integer('doctor_id').unsigned().nullable().references('id').inTable('doctors').onDelete('SET NULL').onUpdate('CASCADE');
    t.text('notes').nullable();
    t.index(['event_id'], 'treatment_offers_event_id_index');
    t.index(['patient_id'], 'treatment_offers_patient_id_index');
  });

  await knex.schema.createTable('dental_units', (t) => {
    t.increments('id');
    t.integer('clinic_id').unsigned().nullable().references('id').inTable('clinics').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('owner_doctor_id').unsigned().notNullable().references('id').inTable('doctors').onDelete('RESTRICT').onUpdate('CASCADE');
    t.string('name', 100).notNullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['owner_doctor_id'], 'dental_units_owner_doctor_id_index');
    t.index(['clinic_id'], 'dental_units_clinic_id_index');
  });

  await knex.schema.createTable('appointments', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.string('time', 5).notNullable();
    t.string('status').notNullable();
    t.text('intended').nullable();
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('doctor_id').unsigned().notNullable().references('id').inTable('doctors').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('clinic_id').unsigned().nullable().references('id').inTable('clinics').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('offer_id').unsigned().nullable().references('id').inTable('treatment_offers').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.integer('duration_minutes').notNullable().defaultTo(30);
    t.integer('unit_id').unsigned().nullable().references('id').inTable('dental_units').onDelete('RESTRICT').onUpdate('CASCADE');
    t.timestamp('deleted_at').nullable();
    t.integer('deleted_by').nullable();
    t.index(['offer_id'], 'appointments_offer_id_index');
    t.index(['deleted_at'], 'appointments_deleted_at_index');
    t.index(['unit_id', 'date', 'time'], 'appointments_unit_id_date_time_index');
    t.index(['date'], 'appointments_date_index');
    t.index(['patient_id', 'date'], 'appointments_patient_id_date_index');
    t.index(['doctor_id', 'date', 'time'], 'appointments_doctor_id_date_time_index');
    t.index(['clinic_id'], 'appointments_clinic_id_index');
    t.index(['doctor_id'], 'appointments_doctor_id_index');
    t.index(['patient_id'], 'appointments_patient_id_index');
  });

  await knex.schema.createTable('appointment_category', (t) => {
    t.increments('id');
    t.integer('appointment_id').unsigned().notNullable().references('id').inTable('appointments').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('category_id').unsigned().notNullable().references('id').inTable('categories').onDelete('RESTRICT').onUpdate('CASCADE');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['category_id'], 'appointment_category_category_id_index');
    t.index(['appointment_id'], 'appointment_category_appointment_id_index');
  });

  await knex.schema.createTable('appointment_tooth', (t) => {
    t.increments('id');
    t.integer('appointment_id').unsigned().notNullable().references('id').inTable('appointments').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('tooth_id').unsigned().notNullable().references('id').inTable('teeth').onDelete('RESTRICT').onUpdate('CASCADE');
    t.text('description').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['tooth_id'], 'appointment_tooth_tooth_id_index');
    t.index(['appointment_id'], 'appointment_tooth_appointment_id_index');
  });

  await knex.schema.createTable('payments', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.string('type').nullable();
    t.decimal('amount', 12, 2).notNullable();
    t.decimal('remaining', 12, 2).nullable();
    t.string('currency', 8).notNullable();
    t.text('description').nullable();
    t.decimal('dr_part', 12, 2).nullable();
    t.integer('offer_id').unsigned().nullable().references('id').inTable('treatment_offers').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('model_id').nullable();
    t.timestamp('deleted_at').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.string('method', 20).nullable();
    t.integer('created_by').nullable();
    t.integer('deleted_by').nullable();
    t.integer('collected_by_doctor_id').unsigned().nullable().references('id').inTable('doctors').onDelete('SET NULL').onUpdate('CASCADE');
    t.index(['offer_id'], 'payments_offer_id_index');
    t.index(['collected_by_doctor_id'], 'payments_collected_by_doctor_id_index');
    t.index(['date'], 'payments_date_index');
  });

  await knex.schema.createTable('expenses', (t) => {
    t.increments('id');
    t.date('date').notNullable();
    t.string('type').nullable();
    t.decimal('amount', 12, 2).notNullable();
    t.string('currency', 8).notNullable();
    t.string('description').nullable();
    t.integer('model_id').nullable();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.timestamp('deleted_at').nullable();
    t.integer('deleted_by').nullable();
    t.integer('appointment_id').unsigned().nullable().references('id').inTable('appointments').onDelete('SET NULL').onUpdate('CASCADE');
    t.index(['appointment_id'], 'expenses_appointment_id_index');
    t.index(['deleted_at'], 'expenses_deleted_at_index');
    t.index(['date'], 'expenses_date_index');
    t.index(['user_id'], 'expenses_user_id_index');
  });

  await knex.schema.createTable('labs', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('personal').nullable();
    t.string('address').nullable();
    t.string('phone').notNullable();
    t.text('description').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
  });

  await knex.schema.createTable('suppliers', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('personal').nullable();
    t.string('address').nullable();
    t.string('phone').notNullable();
    t.text('description').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
  });

  await knex.schema.createTable('medications', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('type').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
  });

  await knex.schema.createTable('reports', (t) => {
    t.increments('id');
    t.integer('appointment_id').unsigned().notNullable().references('id').inTable('appointments').onDelete('CASCADE').onUpdate('CASCADE');
    t.text('summary').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.timestamp('deleted_at').nullable();
    t.integer('deleted_by').nullable();
    t.index(['deleted_at'], 'reports_deleted_at_index');
    t.unique(['appointment_id'], 'reports_appointment_id_unique');
    t.index(['appointment_id'], 'reports_appointment_id_index');
  });

  await knex.schema.createTable('report_tooth', (t) => {
    t.increments('id');
    t.integer('report_id').unsigned().notNullable().references('id').inTable('reports').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('tooth_id').unsigned().notNullable().references('id').inTable('teeth').onDelete('RESTRICT').onUpdate('CASCADE');
    t.date('date').notNullable();
    t.text('labial').nullable();
    t.text('buccal').nullable();
    t.text('lingual').nullable();
    t.text('mesial').nullable();
    t.text('distal').nullable();
    t.text('occlusal').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['report_id', 'tooth_id'], 'report_tooth_report_id_tooth_id_unique');
    t.index(['tooth_id'], 'report_tooth_tooth_id_index');
    t.index(['report_id'], 'report_tooth_report_id_index');
  });

  await knex.schema.createTable('medication_report', (t) => {
    t.increments('id');
    t.integer('medication_id').unsigned().notNullable().references('id').inTable('medications').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('report_id').unsigned().notNullable().references('id').inTable('reports').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('dose').notNullable();
    t.string('frequency').notNullable();
    t.string('time_unit').notNullable();
    t.text('notes').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['report_id'], 'medication_report_report_id_index');
    t.index(['medication_id'], 'medication_report_medication_id_index');
  });

  await knex.schema.createTable('notifications', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.string('content').notNullable();
    t.string('status').notNullable();
    t.string('type', 40).nullable();
    t.string('link').nullable();
    t.timestamp('read_at').nullable();
    t.string('dedupe_key').nullable();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('appointment_id').unsigned().nullable().references('id').inTable('appointments').onDelete('SET NULL').onUpdate('CASCADE');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['user_id', 'status'], 'notifications_user_id_status_index');
    t.index(['appointment_id'], 'notifications_appointment_id_index');
    t.index(['user_id'], 'notifications_user_id_index');
    t.unique(['dedupe_key'], 'notifications_dedupe_key_unique');
  });

  await knex.schema.createTable('refresh_tokens', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('family_id', 64).notNullable();
    t.string('token_hash', 64).notNullable();
    t.boolean('remember').notNullable().defaultTo(false);
    t.timestamp('expires_at').notNullable();
    t.timestamp('revoked_at').nullable();
    t.integer('replaced_by').nullable();
    t.string('user_agent').nullable();
    t.string('ip', 64).nullable();
    t.timestamp('created_at').nullable();
    t.unique(['token_hash'], 'refresh_tokens_token_hash_unique');
    t.index(['family_id'], 'refresh_tokens_family_id_index');
    t.index(['user_id'], 'refresh_tokens_user_id_index');
  });

  await knex.schema.createTable('password_reset_tokens', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('token_hash', 64).notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at').nullable();
    t.timestamp('created_at').nullable();
    t.unique(['token_hash'], 'password_reset_tokens_token_hash_unique');
    t.index(['user_id'], 'password_reset_tokens_user_id_index');
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.integer('user_id').nullable();
    t.string('action', 80).notNullable();
    t.string('entity', 60).nullable();
    t.string('entity_id', 40).nullable();
    t.text('diff').nullable();
    t.string('ip', 64).nullable();
    t.timestamp('created_at').notNullable();
    t.index(['created_at'], 'audit_log_created_at_index');
    t.index(['entity', 'entity_id'], 'audit_log_entity_entity_id_index');
    t.index(['action'], 'audit_log_action_index');
    t.index(['user_id'], 'audit_log_user_id_index');
  });

  await knex.schema.createTable('lab_orders', (t) => {
    t.increments('id');
    t.integer('lab_id').unsigned().notNullable().references('id').inTable('labs').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('appointment_id').unsigned().nullable().references('id').inTable('appointments').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('tooth_id').unsigned().nullable().references('id').inTable('teeth').onDelete('SET NULL').onUpdate('CASCADE');
    t.string('item').notNullable();
    t.decimal('cost', 12, 2).notNullable().defaultTo(0);
    t.string('currency', 8).notNullable().defaultTo('$');
    t.date('sent_at').nullable();
    t.date('due_at').nullable();
    t.date('received_at').nullable();
    t.string('status', 20).notNullable().defaultTo('draft');
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.timestamp('deleted_at').nullable();
    t.integer('deleted_by').nullable();
    t.index(['deleted_at'], 'lab_orders_deleted_at_index');
    t.index(['tooth_id'], 'lab_orders_tooth_id_index');
    t.index(['appointment_id'], 'lab_orders_appointment_id_index');
    t.index(['patient_id'], 'lab_orders_patient_id_index');
    t.index(['lab_id'], 'lab_orders_lab_id_index');
  });

  await knex.schema.createTable('clinic_doctor', (t) => {
    t.increments('id');
    t.integer('doctor_id').unsigned().notNullable().references('id').inTable('doctors').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('clinic_id').unsigned().notNullable().references('id').inTable('clinics').onDelete('CASCADE').onUpdate('CASCADE');
    t.decimal('dr_part', 12, 2).notNullable().defaultTo(0);
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['clinic_id'], 'clinic_doctor_clinic_id_index');
    t.index(['doctor_id'], 'clinic_doctor_doctor_id_index');
  });

  await knex.schema.createTable('tax_rule_sets', (t) => {
    t.increments('id');
    t.integer('effective_year').notNullable();
    t.text('settings').notNullable();
    t.integer('updated_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['effective_year'], 'tax_rule_sets_effective_year_unique');
  });

  await knex.schema.createTable('tax_declarations', (t) => {
    t.increments('id');
    t.integer('year').notNullable();
    t.integer('doctor_id').unsigned().nullable().references('id').inTable('doctors').onDelete('RESTRICT').onUpdate('CASCADE');
    t.string('scope', 32).notNullable();
    t.text('snapshot').notNullable();
    t.decimal('tax_payable', 18, 0).notNullable();
    t.date('paid_date').notNullable();
    t.text('note').nullable();
    t.integer('declared_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.string('active_scope', 32).nullable();
    t.timestamp('voided_at').nullable();
    t.integer('voided_by').nullable();
    t.unique(['year', 'active_scope'], 'tax_declarations_year_active_scope_unique');
    t.index(['doctor_id'], 'tax_declarations_doctor_id_index');
  });

  await knex.schema.createTable('app_settings', (t) => {
    t.increments('id');
    t.string('key', 64).notNullable();
    t.text('value').notNullable();
    t.integer('updated_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['key'], 'app_settings_key_unique');
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.increments('id');
    t.string('role', 16).notNullable();
    t.string('permission', 64).notNullable();
    t.boolean('allowed').notNullable();
    t.integer('updated_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.unique(['role', 'permission'], 'role_permissions_role_permission_unique');
  });

  await knex.schema.createTable('report_jobs', (t) => {
    t.increments('id');
    t.integer('user_id').notNullable();
    t.string('report', 40).notNullable();
    t.string('title', 120).notNullable();
    t.text('params').notNullable();
    t.string('status', 12).notNullable().defaultTo('queued');
    t.integer('row_count').nullable();
    t.string('file_name', 80).nullable();
    t.string('error').nullable();
    t.timestamp('finished_at').nullable();
    t.timestamp('expires_at').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['user_id', 'status'], 'report_jobs_user_id_status_index');
  });

  await knex.schema.createTable('offer_items', (t) => {
    t.increments('id');
    t.integer('offer_id').unsigned().notNullable().references('id').inTable('treatment_offers').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('tooth_id').unsigned().nullable().references('id').inTable('teeth').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('category_id').unsigned().nullable().references('id').inTable('categories').onDelete('SET NULL').onUpdate('CASCADE');
    t.integer('appointment_id').unsigned().nullable().references('id').inTable('appointments').onDelete('SET NULL').onUpdate('CASCADE');
    t.string('description').notNullable();
    t.decimal('price', 12, 2).notNullable().defaultTo(0);
    t.decimal('cost', 12, 2).nullable();
    t.integer('sequence').notNullable().defaultTo(0);
    t.string('status', 20).notNullable().defaultTo('pending');
    t.timestamp('completed_at').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['appointment_id'], 'offer_items_appointment_id_index');
    t.index(['category_id'], 'offer_items_category_id_index');
    t.index(['tooth_id'], 'offer_items_tooth_id_index');
    t.index(['offer_id'], 'offer_items_offer_id_index');
  });

  await knex.schema.createTable('patient_documents', (t) => {
    t.increments('id');
    t.integer('patient_id').unsigned().notNullable().references('id').inTable('patients').onDelete('RESTRICT').onUpdate('CASCADE');
    t.integer('appointment_id').unsigned().nullable().references('id').inTable('appointments').onDelete('SET NULL').onUpdate('CASCADE');
    t.string('category', 20).notNullable();
    t.string('title', 120).notNullable();
    t.date('taken_on').nullable();
    t.string('note', 500).nullable();
    t.string('file_name', 40).notNullable();
    t.string('original_name').notNullable();
    t.string('mime', 40).notNullable();
    t.integer('size_bytes').notNullable();
    t.string('sha256', 64).notNullable();
    t.integer('uploaded_by').nullable();
    t.timestamp('deleted_at').nullable();
    t.integer('deleted_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['sha256'], 'patient_documents_sha256_index');
    t.index(['patient_id', 'deleted_at'], 'patient_documents_patient_id_deleted_at_index');
    t.unique(['file_name'], 'patient_documents_file_name_unique');
    t.index(['appointment_id'], 'patient_documents_appointment_id_index');
    t.index(['patient_id'], 'patient_documents_patient_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  const tables = [
    'patient_documents',
    'offer_items',
    'report_jobs',
    'role_permissions',
    'app_settings',
    'tax_declarations',
    'tax_rule_sets',
    'clinic_doctor',
    'lab_orders',
    'audit_log',
    'password_reset_tokens',
    'refresh_tokens',
    'notifications',
    'medication_report',
    'report_tooth',
    'reports',
    'medications',
    'suppliers',
    'labs',
    'expenses',
    'payments',
    'appointment_tooth',
    'appointment_category',
    'appointments',
    'dental_units',
    'treatment_offers',
    'event_patient',
    'events',
    'promotions',
    'teeth',
    'categories',
    'patients',
    'clinics',
    'doctors',
    'users',
  ];
  for (const table of tables) await knex.schema.dropTableIfExists(table);
}
