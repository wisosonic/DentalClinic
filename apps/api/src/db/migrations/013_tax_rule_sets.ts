import type { Knex } from 'knex';
import { timestamps } from './helpers';

/**
 * Income tax rules by year, and each doctor's family details for it.
 *
 * Laws change, so the rules (exchange rate, tax percentage, allowances, brackets) are saved as sets that
 * apply from a year until a later set takes over; the estimate for a year uses the latest set at or before
 * it. Migration 012's single set of rows becomes one set that applies from 2000. A doctor's spouse and
 * children (for the allowances) live on the doctor.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tax_rule_sets', (t) => {
    t.increments('id');
    t.integer('effective_year').notNullable().unique();
    t.text('settings').notNullable(); // JSON: usdToLbp, taxPercentage, allowances, brackets
    t.integer('updated_by').unsigned().nullable(); // no FK: the record of who changed it outlives the account
    timestamps(t);
  });

  const old: { key: string; value: string; updated_by: number | null }[] = await knex('tax_settings').select('key', 'value', 'updated_by');
  if (old.length > 0) {
    const saved = Object.fromEntries(old.map((r) => [r.key, JSON.parse(r.value) as unknown]));
    const now = knex.fn.now();
    await knex('tax_rule_sets').insert({
      effective_year: 2000,
      settings: JSON.stringify({ usdToLbp: saved.usd_to_lbp, taxPercentage: 35, allowances: saved.allowances, brackets: saved.brackets }),
      updated_by: old[0]!.updated_by,
      created_at: now, updated_at: now,
    });
  }
  await knex.schema.dropTableIfExists('tax_settings');

  await knex.schema.alterTable('doctors', (t) => {
    t.boolean('tax_spouse').notNullable().defaultTo(false);
    t.integer('tax_children').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  // SQLite would rebuild the table to drop a column, which the foreign keys to doctors refuse; its own DROP COLUMN does not.
  const sqlite = String(knex.client.config.client).includes('sqlite');
  for (const column of ['tax_spouse', 'tax_children']) {
    if (sqlite) await knex.raw(`ALTER TABLE doctors DROP COLUMN ${column}`);
    else await knex.schema.alterTable('doctors', (t) => t.dropColumn(column));
  }
  await knex.schema.createTable('tax_settings', (t) => {
    t.increments('id');
    t.string('key', 64).notNullable().unique();
    t.text('value').notNullable();
    t.integer('updated_by').unsigned().nullable();
    timestamps(t);
  });
  // keep the newest set, as migration 012 stored it
  const latest: { settings: string; updated_by: number | null } | undefined = await knex('tax_rule_sets').orderBy('effective_year', 'desc').first('settings', 'updated_by');
  if (latest) {
    const s = JSON.parse(latest.settings) as { usdToLbp: number; allowances: unknown; brackets: unknown };
    const now = knex.fn.now();
    const rows = [['usd_to_lbp', s.usdToLbp], ['allowances', s.allowances], ['brackets', s.brackets]] as const;
    await knex('tax_settings').insert(rows.map(([key, value]) => ({ key, value: JSON.stringify(value), updated_by: latest.updated_by, created_at: now, updated_at: now })));
  }
  await knex.schema.dropTableIfExists('tax_rule_sets');
}
