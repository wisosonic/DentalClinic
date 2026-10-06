import type { Knex } from 'knex';

/**
 * Phase 4:
 *  - at most one visit report per appointment (owner decision), and one note per tooth in a report
 *  - a doctor profile can be linked to a login (`doctors.user_id`), so the app knows who the
 *    "treating doctor" and the "primary doctor" are when they sign in
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reports', (t) => {
    t.unique(['appointment_id']);
  });
  await knex.schema.alterTable('report_tooth', (t) => {
    t.unique(['report_id', 'tooth_id']);
  });

  if (knex.client.config.client === 'better-sqlite3') {
    // Inline REFERENCES keeps SQLite from rebuilding the doctors table (other tables point at it).
    await knex.raw('ALTER TABLE doctors ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE');
    await knex.raw('CREATE UNIQUE INDEX doctors_user_id_unique ON doctors (user_id)');
  } else {
    await knex.schema.alterTable('doctors', (t) => {
      t.integer('user_id').unsigned().nullable();
      t.foreign('user_id').references('id').inTable('users').onDelete('SET NULL').onUpdate('CASCADE');
      t.unique(['user_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (knex.client.config.client === 'better-sqlite3') {
    throw new Error('Rolling back migration 006 is not supported on SQLite. Restore the database from a backup instead.');
  }
  await knex.schema.alterTable('doctors', (t) => {
    t.dropForeign(['user_id']);
    t.dropUnique(['user_id']);
    t.dropColumn('user_id');
  });
  await knex.schema.alterTable('report_tooth', (t) => {
    t.dropUnique(['report_id', 'tooth_id']);
  });
  await knex.schema.alterTable('reports', (t) => {
    t.dropUnique(['appointment_id']);
  });
}
