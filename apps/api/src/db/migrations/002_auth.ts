import type { Knex } from 'knex';
import { ref } from './helpers';

export async function up(knex: Knex): Promise<void> {
  // Only a hash of each refresh token is stored. Tokens rotate on every use and
  // belong to a family; reuse of a revoked token revokes the whole family.
  await knex.schema.createTable('refresh_tokens', (t) => {
    t.increments('id');
    ref(t, 'user_id', 'users');
    t.string('family_id', 64).notNullable().index();
    t.string('token_hash', 64).notNullable().unique();
    t.boolean('remember').notNullable().defaultTo(false);
    t.timestamp('expires_at').notNullable();
    t.timestamp('revoked_at').nullable();
    t.integer('replaced_by').nullable();
    t.string('user_agent', 255).nullable();
    t.string('ip', 64).nullable();
    t.timestamp('created_at').nullable();
  });

  await knex.schema.createTable('password_reset_tokens', (t) => {
    t.increments('id');
    ref(t, 'user_id', 'users');
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at').nullable();
    t.timestamp('created_at').nullable();
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().nullable(); // no FK: the log must outlive users
    t.string('action', 80).notNullable();
    t.string('entity', 60).nullable();
    t.string('entity_id', 40).nullable();
    t.text('diff').nullable(); // JSON
    t.string('ip', 64).nullable();
    t.timestamp('created_at').notNullable();
    t.index(['user_id']);
    t.index(['action']);
    t.index(['entity', 'entity_id']);
    t.index(['created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['audit_log', 'password_reset_tokens', 'refresh_tokens']) {
    await knex.schema.dropTableIfExists(t);
  }
}
