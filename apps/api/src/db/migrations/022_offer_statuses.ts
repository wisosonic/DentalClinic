import type { Knex } from 'knex';

/**
 * Treatment offers are made in the chair, after the patient agreed (owner decision 2026-10-06), so the online-quote
 * statuses go: `sent` becomes `accepted`, `rejected` and `expired` become `cancelled`. What stays is `draft`
 * (unfinished, not binding), `accepted` and `cancelled`. Old audit entries and notifications keep their wording.
 */
export async function up(knex: Knex): Promise<void> {
  await knex('quotes').where({ status: 'sent' }).update({ status: 'accepted' });
  await knex('quotes').whereIn('status', ['rejected', 'expired']).update({ status: 'cancelled' });
}

export async function down(): Promise<void> {
  throw new Error('Rolling back migration 022 is not supported: which offers were sent, rejected or expired is no longer known. Restore a backup.');
}
