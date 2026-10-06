import type { Knex } from 'knex';
import { timestamps } from './helpers';

/**
 * Settings the admin edits on the Settings page (General and Appearance): one row per setting, the value as
 * text. Nothing is seeded: a setting with no row uses its default (the timezone, for example, falls back to
 * the server's CLINIC_TIMEZONE).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_settings', (t) => {
    t.increments('id');
    t.string('key', 64).notNullable().unique();
    t.text('value').notNullable();
    t.integer('updated_by').unsigned().nullable(); // no FK: the record of who changed it outlives the account
    timestamps(t);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_settings');
}
