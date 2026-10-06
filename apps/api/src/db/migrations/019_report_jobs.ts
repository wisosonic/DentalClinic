import type { Knex } from 'knex';
import { timestamps } from './helpers';

/**
 * Reports too big to build while the person waits (more than 50,000 rows) are made in the background and kept
 * for a few days. A row says who asked, which report and with what filters (`params`, JSON), how it is going,
 * and where the finished file is. The file is under UPLOAD_DIR/reports with a random name; only the person who
 * asked can download it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('report_jobs', (t) => {
    t.increments('id');
    t.integer('user_id').unsigned().notNullable(); // no FK: the file and its record outlive nothing else, and an account is switched off, not deleted
    t.string('report', 40).notNullable();
    t.string('title', 120).notNullable();
    t.text('params').notNullable();
    t.string('status', 12).notNullable().defaultTo('queued'); // queued | running | done | failed | expired
    t.integer('row_count').nullable();
    t.string('file_name', 80).nullable();
    t.string('error', 255).nullable();
    t.timestamp('finished_at').nullable();
    t.timestamp('expires_at').nullable();
    timestamps(t);
    t.index(['user_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('report_jobs');
}
