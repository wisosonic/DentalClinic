import type { Knex } from 'knex';
import { sqlNow } from './connection';

type Conn = Knex | Knex.Transaction;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * One-time setup for quotes that come from the old app's dump: they predate treatment offers, so each one gets
 * ONE item (its title, price and cost, already done, so old money never raises "visit to book" notices) and its
 * old status is mapped (`paid` and `partially_paid` were derived and become `accepted`; `pending` becomes `sent`,
 * or `accepted` when something was paid on it). Same rules as migration 020, for data imported after it.
 * Safe to run twice: a quote that already has items is left alone.
 */
export async function applyOfferDefaults(db: Conn): Promise<number> {
  const now = sqlNow();
  const sums = (await db('payments').whereNotNull('quote_id').whereNull('deleted_at').groupBy('quote_id').select('quote_id').sum({ s: 'amount' })) as unknown as { quote_id: number; s: number }[];
  const paid = new Map<number, number>(sums.map((r) => [r.quote_id, Number(r.s)]));
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
    if (next === 'paid' || next === 'partially_paid') next = 'accepted';
    else if (next === 'pending') next = (paid.get(q.id) ?? 0) > 0 ? 'accepted' : 'sent';
    if (next !== q.status) await db('quotes').where({ id: q.id }).update({ status: next });
  }
  return made;
}
