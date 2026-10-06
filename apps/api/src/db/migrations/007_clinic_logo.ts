import type { Knex } from 'knex';

/** A clinic can have a logo. Only the file name is stored; the image lives in UPLOAD_DIR. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('clinics', (t) => {
    t.string('logo_file', 80).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  if (knex.client.config.client === 'better-sqlite3') {
    await knex.raw('ALTER TABLE clinics DROP COLUMN logo_file');
  } else {
    await knex.schema.alterTable('clinics', (t) => t.dropColumn('logo_file'));
  }
}
