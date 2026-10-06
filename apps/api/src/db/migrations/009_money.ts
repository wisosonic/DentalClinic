import type { Knex } from 'knex';

/**
 * Phase 5 (money), part one: quotes and payments.
 *  - payments: how it was paid, who collected it (a snapshot of the patient's primary doctor), who entered it
 *  - soft delete: who deleted a quote or payment (they already have `deleted_at`)
 * The balance after each payment (`remaining`) is recomputed by the server, so the old values are
 * recalculated here from the amounts.
 */
export async function up(knex: Knex): Promise<void> {
  const sqlite = knex.client.config.client === 'better-sqlite3';

  await knex.schema.alterTable('payments', (t) => {
    t.string('method', 20).nullable();
    t.integer('created_by').unsigned().nullable(); // no FK: the record of who entered it outlives the account
    t.integer('deleted_by').unsigned().nullable();
  });
  await knex.schema.alterTable('quotes', (t) => {
    t.integer('deleted_by').unsigned().nullable();
  });

  if (sqlite) {
    // Inline REFERENCES keeps SQLite from rebuilding the doctors-linked tables.
    await knex.raw('ALTER TABLE payments ADD COLUMN collected_by_doctor_id INTEGER REFERENCES doctors(id) ON DELETE SET NULL ON UPDATE CASCADE');
  } else {
    await knex.schema.alterTable('payments', (t) => {
      t.integer('collected_by_doctor_id').unsigned().nullable();
      t.foreign('collected_by_doctor_id').references('id').inTable('doctors').onDelete('SET NULL').onUpdate('CASCADE');
    });
  }
  await knex.schema.alterTable('payments', (t) => t.index(['collected_by_doctor_id']));

  // Existing clinic payments were collected by the patient's primary doctor.
  const rows = await knex('payments as p')
    .join('quotes as q', 'q.id', 'p.quote_id')
    .join('patients as pt', 'pt.id', 'q.patient_id')
    .whereNotNull('pt.doctor_id')
    .select('p.id', 'pt.doctor_id');
  for (const r of rows) await knex('payments').where({ id: r.id }).update({ collected_by_doctor_id: r.doctor_id });

  // Recompute the running balance of every quote's payments (oldest first), to the cent.
  const quotes = await knex('quotes').select('id', 'price');
  for (const q of quotes) {
    const payments = await knex('payments').where({ quote_id: q.id }).orderBy([{ column: 'date' }, { column: 'id' }]).select('id', 'amount');
    let paid = 0;
    for (const p of payments) {
      paid = Math.round((paid + Number(p.amount)) * 100) / 100;
      await knex('payments').where({ id: p.id }).update({ remaining: Math.round((Number(q.price) - paid) * 100) / 100 });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const drop = async (table: string, columns: string[]) => {
    for (const c of columns) {
      if (knex.client.config.client === 'better-sqlite3') {
        if (c === 'collected_by_doctor_id') await knex.raw('DROP INDEX IF EXISTS payments_collected_by_doctor_id_index');
        await knex.raw(`ALTER TABLE ${table} DROP COLUMN ${c}`);
      } else {
        await knex.schema.alterTable(table, (t) => t.dropColumn(c));
      }
    }
  };
  await drop('quotes', ['deleted_by']);
  await drop('payments', ['collected_by_doctor_id', 'deleted_by', 'created_by', 'method']);
}
