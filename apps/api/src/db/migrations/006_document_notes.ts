import type { Knex } from 'knex';

/**
 * Comments, tags and annotations on patient documents (owner request 2026-10-09). All three belong to one document and
 * go with it (CASCADE; nothing financial hangs on them). They are clinic-internal: no patient-facing route reads them.
 * An annotation's position is stored as fractions of the picture (0 to 1), so it is right at any size.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('document_comments', (t) => {
    t.increments('id');
    t.integer('document_id').unsigned().notNullable().references('id').inTable('patient_documents').onDelete('CASCADE').onUpdate('CASCADE');
    t.integer('user_id').nullable();
    t.text('body').notNullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['document_id'], 'document_comments_document_id_index');
  });
  await knex.schema.createTable('document_tags', (t) => {
    t.increments('id');
    t.integer('document_id').unsigned().notNullable().references('id').inTable('patient_documents').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('tag', 30).notNullable();
    t.string('tag_key', 30).notNullable(); // lower case, for telling two tags apart and for the filter
    t.integer('created_by').nullable();
    t.timestamp('created_at').nullable();
    t.unique(['document_id', 'tag_key'], 'document_tags_document_id_tag_key_unique');
    t.index(['tag_key'], 'document_tags_tag_key_index');
  });
  await knex.schema.createTable('document_annotations', (t) => {
    t.increments('id');
    t.integer('document_id').unsigned().notNullable().references('id').inTable('patient_documents').onDelete('CASCADE').onUpdate('CASCADE');
    t.string('kind', 8).notNullable(); // pin | box
    t.float('x').notNullable();
    t.float('y').notNullable();
    t.float('w').nullable();
    t.float('h').nullable();
    t.string('label', 200).notNullable();
    t.integer('created_by').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
    t.index(['document_id'], 'document_annotations_document_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('document_annotations');
  await knex.schema.dropTableIfExists('document_tags');
  await knex.schema.dropTableIfExists('document_comments');
}
