import type { Knex } from 'knex';
import { money, ref, timestamps } from './helpers';

/** New tables the original schema lacked: treatment plans and lab orders. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('treatment_plans', (t) => {
    t.increments('id');
    ref(t, 'patient_id', 'patients', { onDelete: 'RESTRICT' });
    ref(t, 'doctor_id', 'doctors', { nullable: true, onDelete: 'SET NULL' });
    ref(t, 'quote_id', 'quotes', { nullable: true, onDelete: 'SET NULL' });
    t.string('title').notNullable();
    // draft | proposed | accepted | in_progress | completed | cancelled
    t.string('status', 20).notNullable().defaultTo('draft');
    t.date('start_date').nullable();
    t.text('notes').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('treatment_plan_items', (t) => {
    t.increments('id');
    ref(t, 'plan_id', 'treatment_plans');
    ref(t, 'tooth_id', 'teeth', { nullable: true, onDelete: 'SET NULL' });
    ref(t, 'category_id', 'categories', { nullable: true, onDelete: 'SET NULL' });
    ref(t, 'appointment_id', 'appointments', { nullable: true, onDelete: 'SET NULL' });
    t.string('description').notNullable();
    money(t, 'est_price').notNullable().defaultTo(0);
    t.integer('sequence').notNullable().defaultTo(0);
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | scheduled | done
    t.timestamp('completed_at').nullable();
    timestamps(t);
  });

  await knex.schema.createTable('lab_orders', (t) => {
    t.increments('id');
    ref(t, 'lab_id', 'labs', { onDelete: 'RESTRICT' });
    ref(t, 'patient_id', 'patients', { onDelete: 'RESTRICT' });
    ref(t, 'appointment_id', 'appointments', { nullable: true, onDelete: 'SET NULL' });
    ref(t, 'tooth_id', 'teeth', { nullable: true, onDelete: 'SET NULL' });
    t.string('item').notNullable();
    money(t, 'cost').notNullable().defaultTo(0);
    t.string('currency', 8).notNullable().defaultTo('$');
    t.date('sent_at').nullable();
    t.date('due_at').nullable();
    t.date('received_at').nullable();
    t.string('status', 20).notNullable().defaultTo('draft'); // draft | sent | received | fitted
    timestamps(t);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['lab_orders', 'treatment_plan_items', 'treatment_plans']) {
    await knex.schema.dropTableIfExists(t);
  }
}
