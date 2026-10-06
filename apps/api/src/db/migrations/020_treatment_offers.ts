import type { Knex } from 'knex';
import { money, ref, timestamps } from './helpers';

/**
 * Treatment plans and quotes become one thing, the treatment offer (owner decision, 2026-10-06). The offer is the
 * `quotes` table, which already holds the money (payments point at it); it gains what a plan had (the doctor, a
 * start date, notes) and its items move to `offer_items`, where each item now carries a binding price and an
 * optional cost. An offer's price is the sum of its items.
 *
 *  - every existing quote becomes an offer with ONE item (its title, price and cost), already `done`, so old
 *    money never raises "visit to book" notices;
 *  - a plan with a quote is merged into that quote; a plan without one becomes a new offer; their items are copied;
 *  - statuses: `paid` and `partially_paid` were derived, they become `accepted` (the payment state is derived now);
 *    `pending` becomes `sent`; a plan's `proposed` becomes `sent`, `in_progress` and `completed` become `accepted`;
 *  - the old plan tables are dropped; the saved role permissions for `quotes` and `plans` become `offers`.
 *
 * Every offer's item prices are checked against its price before the old tables go. Rolling back is refused:
 * an offer with several items cannot be turned back into one quote.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const PLAN_TO_OFFER: Record<string, string> = {
  draft: 'draft', proposed: 'sent', accepted: 'accepted', in_progress: 'accepted', completed: 'accepted', cancelled: 'cancelled',
};

export async function up(knex: Knex): Promise<void> {
  const sqlite = knex.client.config.client === 'better-sqlite3';

  // What an offer has that a quote did not.
  if (sqlite) {
    // Inline REFERENCES keeps SQLite from rebuilding the table.
    await knex.raw('ALTER TABLE quotes ADD COLUMN doctor_id INTEGER REFERENCES doctors(id) ON DELETE SET NULL ON UPDATE CASCADE');
    await knex.schema.alterTable('quotes', (t) => {
      t.date('start_date').nullable();
      t.text('notes').nullable();
    });
  } else {
    await knex.schema.alterTable('quotes', (t) => {
      t.integer('doctor_id').unsigned().nullable();
      t.foreign('doctor_id').references('id').inTable('doctors').onDelete('SET NULL').onUpdate('CASCADE');
      t.date('start_date').nullable();
      t.text('notes').nullable();
    });
  }

  await knex.schema.createTable('offer_items', (t) => {
    t.increments('id');
    ref(t, 'offer_id', 'quotes', { onDelete: 'RESTRICT' });
    ref(t, 'tooth_id', 'teeth', { nullable: true, onDelete: 'SET NULL' });
    ref(t, 'category_id', 'categories', { nullable: true, onDelete: 'SET NULL' });
    ref(t, 'appointment_id', 'appointments', { nullable: true, onDelete: 'SET NULL' });
    t.string('description').notNullable();
    money(t, 'price').notNullable().defaultTo(0);
    money(t, 'cost').nullable();
    t.integer('sequence').notNullable().defaultTo(0);
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | scheduled | done
    t.timestamp('completed_at').nullable();
    timestamps(t);
  });

  const paidBy = new Map<number, number>(
    (await knex('payments').whereNotNull('quote_id').whereNull('deleted_at').groupBy('quote_id').select('quote_id').sum({ s: 'amount' })).map((r: Row) => [r.quote_id, Number(r.s)]),
  );
  const hasItems = new Set<number>();

  // ----- plans: merged into their quote, or turned into a new offer -----------
  const plans: Row[] = await knex('treatment_plans').orderBy('id');
  for (const plan of plans) {
    const items: Row[] = await knex('treatment_plan_items').where({ plan_id: plan.id }).orderBy('sequence').orderBy('id');
    const sum = round2(items.reduce((s, i) => s + Number(i.est_price), 0));
    let offerId: number | null = plan.quote_id ?? null;
    const quote: Row | undefined = offerId ? await knex('quotes').where({ id: offerId }).first() : undefined;
    if (quote) {
      await knex('quotes').where({ id: quote.id }).update({ doctor_id: plan.doctor_id ?? null, start_date: plan.start_date ?? null, notes: plan.notes ?? null });
    } else {
      offerId = (await knex('quotes').insert({
        title: plan.title, description: null, type: 'clinic', price: sum, cost: 0, currency: '$', status: PLAN_TO_OFFER[plan.status] ?? 'draft', patient_id: plan.patient_id,
        doctor_id: plan.doctor_id ?? null, start_date: plan.start_date ?? null, notes: plan.notes ?? null, deleted_at: plan.deleted_at ?? null, deleted_by: plan.deleted_by ?? null,
        created_at: plan.created_at, updated_at: plan.updated_at,
      }))[0]!;
    }
    for (const i of items) {
      await knex('offer_items').insert({
        offer_id: offerId, tooth_id: i.tooth_id ?? null, category_id: i.category_id ?? null, appointment_id: i.appointment_id ?? null, description: i.description,
        price: Number(i.est_price), cost: null, sequence: i.sequence, status: i.status, completed_at: i.completed_at ?? null, created_at: i.created_at, updated_at: i.updated_at,
      });
    }
    // A quote's price was what the patient was asked to pay: keep it exactly, with an adjustment item for any difference.
    if (quote) {
      const paid = paidBy.get(quote.id) ?? 0;
      const target = round2(Number(quote.price));
      if (target > sum + 0.004) {
        await knex('offer_items').insert({
          offer_id: quote.id, description: 'Price adjustment', price: round2(target - sum), cost: null, sequence: items.length + 1, status: 'done', completed_at: quote.created_at ?? null,
          created_at: quote.created_at, updated_at: quote.updated_at,
        });
      } else if (sum > target + 0.004 && sum < paid - 0.004) {
        throw new Error(`Offer ${quote.id}: the items add up to less than what was paid`);
      }
      if (quote.status === 'draft' && plan.status !== 'draft') await knex('quotes').where({ id: quote.id }).update({ status: PLAN_TO_OFFER[plan.status] ?? 'draft' });
    }
    hasItems.add(offerId!);
  }

  // ----- every other quote: one item -------------------------------------------
  const quotes: Row[] = await knex('quotes').orderBy('id');
  for (const q of quotes) {
    if (hasItems.has(q.id)) continue;
    const price = round2(Number(q.price));
    await knex('offer_items').insert({
      offer_id: q.id, description: String(q.title).slice(0, 255), price, cost: q.cost == null ? null : round2(Number(q.cost)), sequence: 1,
      status: 'done', completed_at: q.created_at ?? null, created_at: q.created_at, updated_at: q.updated_at,
    });
  }

  // ----- statuses ---------------------------------------------------------------
  for (const q of await knex('quotes').select('id', 'status')) {
    const paid = paidBy.get(q.id) ?? 0;
    let next = q.status as string;
    if (next === 'paid' || next === 'partially_paid') next = 'accepted';
    else if (next === 'pending') next = paid > 0 ? 'accepted' : 'sent';
    if (next !== q.status) await knex('quotes').where({ id: q.id }).update({ status: next });
  }

  // ----- check: every offer's items add up to its price (cost likewise) ----------------
  const sums: Row[] = await knex('offer_items').groupBy('offer_id').select('offer_id').sum({ price: 'price' }).sum({ cost: 'cost' });
  const bySum = new Map<number, Row>(sums.map((r) => [r.offer_id, r]));
  for (const q of await knex('quotes').select('id', 'price')) {
    const s = bySum.get(q.id);
    const itemsTotal = round2(Number(s?.price ?? 0));
    if (Math.abs(itemsTotal - round2(Number(q.price))) > 0.004) {
      // A plan whose items add up to more than its quote: the offer's price follows its items from now on.
      if (itemsTotal > round2(Number(q.price))) await knex('quotes').where({ id: q.id }).update({ price: itemsTotal });
      else throw new Error(`Offer ${q.id}: items ${itemsTotal} do not match the price ${q.price}`);
    }
    await knex('quotes').where({ id: q.id }).update({ cost: round2(Number(s?.cost ?? 0)) });
  }

  // ----- permissions saved for the old modules ---------------------------------------
  if (await knex.schema.hasTable('role_permissions')) {
    await knex('role_permissions').where('permission', 'like', 'plans:%').del();
    for (const r of await knex('role_permissions').where('permission', 'like', 'quotes:%')) {
      await knex('role_permissions').where({ id: r.id }).update({ permission: String(r.permission).replace('quotes:', 'offers:') });
    }
  }

  await knex.schema.dropTable('treatment_plan_items');
  await knex.schema.dropTable('treatment_plans');
}

export async function down(): Promise<void> {
  throw new Error('Rolling back migration 020 is not supported: an offer with several items cannot be turned back into a quote. Restore a backup.');
}
