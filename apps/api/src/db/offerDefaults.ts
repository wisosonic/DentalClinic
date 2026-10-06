import type { Knex } from 'knex';
import { sqlNow } from './connection';

type Conn = Knex | Knex.Transaction;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * One-time setup for quotes that come from the old app's dump: they predate treatment offers, so each one gets
 * ONE item (its title, price and cost, already done, so old money never raises "visit to book" notices) and its
 * old status is mapped (`paid`, `partially_paid`, `pending` and `sent` all become `accepted`: an offer is made after the
 * patient agreed; `rejected` and `expired` become `cancelled`). Same rules as migration 020, for data imported after it.
 * Safe to run twice: a quote that already has items is left alone.
 */
export async function applyOfferDefaults(db: Conn): Promise<number> {
  const now = sqlNow();
  const withItems = new Set<number>((await db('offer_items').distinct('offer_id')).map((r: { offer_id: number }) => r.offer_id));
  let made = 0;
  for (const q of await db('quotes').select('id', 'title', 'price', 'cost', 'status', 'created_at', 'updated_at')) {
    if (!withItems.has(q.id)) {
      await db('offer_items').insert({
        offer_id: q.id, description: String(q.title).slice(0, 255), price: round2(Number(q.price)), cost: q.cost == null ? null : round2(Number(q.cost)), sequence: 1,
        status: 'done', completed_at: q.created_at ?? now, created_at: q.created_at ?? now, updated_at: q.updated_at ?? now,
      });
      made += 1;
    }
    let next = q.status as string;
    if (['paid', 'partially_paid', 'pending', 'sent'].includes(next)) next = 'accepted';
    else if (next === 'rejected' || next === 'expired') next = 'cancelled';
    if (next !== q.status) await db('quotes').where({ id: q.id }).update({ status: next });
  }
  return made;
}
