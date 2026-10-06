import type { Knex } from 'knex';

/**
 * Phase 5 part two: expenses and commission.
 *  - expenses: the appointment a commission expense was for, soft delete (and who deleted)
 *  - the old app's `general` expenses are the new `clinic` type
 * `expenses.model_id` stays a plain number whose meaning follows `type`: supplier id, lab id, or the
 * specialist's doctor id for a commission (the same for commission payments, where it is the payer).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('expenses', (t) => {
    t.timestamp('deleted_at').nullable();
    t.integer('deleted_by').unsigned().nullable();
    t.index(['deleted_at']);
  });
  if (knex.client.config.client === 'better-sqlite3') {
    await knex.raw('ALTER TABLE expenses ADD COLUMN appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL ON UPDATE CASCADE');
  } else {
    await knex.schema.alterTable('expenses', (t) => {
      t.integer('appointment_id').unsigned().nullable();
      t.foreign('appointment_id').references('id').inTable('appointments').onDelete('SET NULL').onUpdate('CASCADE');
    });
  }
  await knex.schema.alterTable('expenses', (t) => t.index(['appointment_id']));
  await knex('expenses').where({ type: 'general' }).update({ type: 'clinic' });
}

export async function down(knex: Knex): Promise<void> {
  const sqlite = knex.client.config.client === 'better-sqlite3';
  for (const c of ['appointment_id', 'deleted_by', 'deleted_at']) {
    if (sqlite) {
      if (c === 'appointment_id') await knex.raw('DROP INDEX IF EXISTS expenses_appointment_id_index');
      if (c === 'deleted_at') await knex.raw('DROP INDEX IF EXISTS expenses_deleted_at_index');
      await knex.raw(`ALTER TABLE expenses DROP COLUMN ${c}`);
    } else {
      await knex.schema.alterTable('expenses', (t) => t.dropColumn(c));
    }
  }
}
