import type { Knex } from 'knex';
import { timestamps } from './helpers';

/**
 * Income tax settings the admin edits in Settings: the USD to LBP rate, the family allowances and the
 * brackets. One row per setting, the value as JSON text. (The old `settings` table holds values of 255
 * characters at most, too small for a list of brackets, and the settings page there is still to come.)
 * Nothing is seeded: until a row is saved, the owner's starting values in `@aya/shared` are used.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tax_settings', (t) => {
    t.increments('id');
    t.string('key', 64).notNullable().unique();
    t.text('value').notNullable();
    t.integer('updated_by').unsigned().nullable(); // no FK: the record of who changed it outlives the account
    timestamps(t);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tax_settings');
}
