import type { Knex } from 'knex';
import { ref, timestamps } from './helpers';

/**
 * A tax year declared and paid. The figures that were used (payments, family details, the rules, the
 * result) are stored as they were, so the year is never recalculated: laws change, and a past year must keep
 * the numbers it was filed with. One declaration per year and taxpayer (the whole clinic, or one doctor).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tax_declarations', (t) => {
    t.increments('id');
    t.integer('year').notNullable();
    ref(t, 'doctor_id', 'doctors', { nullable: true, onDelete: 'RESTRICT' }); // null: the whole clinic
    t.string('scope', 32).notNullable(); // 'clinic' or 'doctor:<id>': what makes (year, taxpayer) unique, since NULLs do not
    t.text('snapshot').notNullable(); // JSON: everything the page showed, as it was
    t.decimal('tax_payable', 18, 0).notNullable(); // LBP, whole pounds
    t.date('paid_date').notNullable();
    t.text('note').nullable();
    t.integer('declared_by').unsigned().nullable(); // no FK: the record of who did it outlives the account
    timestamps(t);
    t.unique(['year', 'scope']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('tax_declarations');
}
