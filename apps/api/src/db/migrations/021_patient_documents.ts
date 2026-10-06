import type { Knex } from 'knex';
import { ref, timestamps } from './helpers';

/**
 * Documents uploaded for a patient (x-ray, panoramic, CBCT report, blood analysis...). The file itself is on the
 * server disk under UPLOAD_DIR/documents with a random name; this row says whose it is and what it is. Soft deleted
 * (the Trash), and erased with its file from there or with the patient.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('patient_documents', (t) => {
    t.increments('id');
    ref(t, 'patient_id', 'patients', { onDelete: 'RESTRICT' });
    ref(t, 'appointment_id', 'appointments', { nullable: true, onDelete: 'SET NULL' });
    t.string('category', 20).notNullable(); // xray | panoramic | cbct | blood_test | other
    t.string('title', 120).notNullable();
    t.date('taken_on').nullable();
    t.string('note', 500).nullable();
    t.string('file_name', 40).notNullable().unique(); // random, set by the server: doc-<12 hex>.<ext>
    t.string('original_name', 255).notNullable(); // display only
    t.string('mime', 40).notNullable();
    t.integer('size_bytes').unsigned().notNullable();
    t.string('sha256', 64).notNullable();
    t.integer('uploaded_by').unsigned().nullable(); // no FK: the record of who uploaded it outlives the account
    t.timestamp('deleted_at').nullable();
    t.integer('deleted_by').unsigned().nullable();
    timestamps(t);
    t.index(['patient_id', 'deleted_at']);
    t.index(['sha256']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('patient_documents');
}
