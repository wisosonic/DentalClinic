import type { Knex } from 'knex';
import { timestamps } from './helpers';

/**
 * What the admin changed in what a role may do (Administration > Roles). The built-in table in
 * `lib/permissions.ts` stays the default; a row here only records a difference from it (`allowed` 1 = granted,
 * 0 = taken away), so an empty table means "exactly the defaults".
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('role_permissions', (t) => {
    t.increments('id');
    t.string('role', 16).notNullable();
    t.string('permission', 64).notNullable(); // "module:action"
    t.boolean('allowed').notNullable();
    t.integer('updated_by').unsigned().nullable(); // no FK: the record of who changed it outlives the account
    timestamps(t);
    t.unique(['role', 'permission']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('role_permissions');
}
