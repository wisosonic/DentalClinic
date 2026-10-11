import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { audit } from '../audit/audit';
import { removeDocumentFiles } from '../documents/router';
import { recalcOffer } from '../offers/service';
import { operating } from '../settings/operating';
import { countsOf, erase, footprint, TRASH_KINDS, TRASH_TABLES, type Counts, type TrashKind } from './purge';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Erases one item that is in the Trash, with what is attached to it, in one transaction; its files go once the change is safe. Returns what went. */
export async function purgeItem(ctx: AppContext, kind: TrashKind, id: number): Promise<Counts> {
  let files: string[] = [];
  const counts = await ctx.db.transaction(async (trx) => {
    const f = await footprint(trx, kind, id);
    const c = await countsOf(trx, f);
    if (f.documents.length) files = (await trx('patient_documents').whereIn('id', f.documents).select('file_name')).map((r: { file_name: string }) => r.file_name);
    const offerOfPayment = kind === 'payment' ? (await trx('payments').where({ id }).first('offer_id'))?.offer_id : null;
    await erase(trx, f);
    if (offerOfPayment) await recalcOffer(trx, offerOfPayment);
    return c;
  });
  await removeDocumentFiles(ctx.env, files);
  return counts;
}

/** Parts before the whole, so an old payment goes before its offer and a visit's report before the visit. */
const ORDER: TrashKind[] = ['payment', 'commission', 'expense', 'document', 'lab_order', 'report', 'offer', 'appointment', 'patient'];

/**
 * The Trash retention rule (Settings > Trash and activity log): items that have been in the Trash longer than the
 * chosen number of days are erased for good, exactly as an admin would from the Trash (with what is attached).
 * Off when the setting is 0. One entry in the activity log says how much went, by kind, never what it was.
 */
export async function runTrashRetention(ctx: AppContext): Promise<number> {
  const { trashDays } = (await operating(ctx)).retention;
  if (trashDays <= 0) return 0;
  const cutoff = sqlNow(new Date(ctx.clock().getTime() - trashDays * DAY_MS));
  const { erased, total } = await eraseTrash(ctx, cutoff);
  if (total) await audit(ctx, null, { userId: null, action: 'trash.autopurge', diff: { days: trashDays, erased } });
  return total;
}

/** The ids of the items of one kind in the Trash, only those deleted before `cutoff` when one is given. */
async function trashIds(ctx: AppContext, kind: TrashKind, cutoff: string | null): Promise<number[]> {
  const rows = await ctx.db(TRASH_TABLES[kind]).whereNotNull('deleted_at').modify((qb) => {
    if (cutoff) qb.where('deleted_at', '<', cutoff);
    if (kind === 'commission') qb.where('type', 'commission');
    if (kind === 'payment') qb.whereNot('type', 'commission');
  }).select('id');
  return (rows as { id: number }[]).map((r) => r.id);
}

/** How many items of each kind are in the Trash. */
export async function trashSummary(ctx: AppContext): Promise<{ counts: Record<TrashKind, number>; total: number }> {
  const counts = {} as Record<TrashKind, number>;
  for (const kind of TRASH_KINDS) counts[kind] = (await trashIds(ctx, kind, null)).length;
  return { counts, total: TRASH_KINDS.reduce((n, k) => n + counts[k], 0) };
}

/**
 * Erases what is in the Trash for good, each item with what is attached to it, one transaction per item (a patient
 * takes their visits, offers and payments with them). `cutoff` limits it to items deleted before then; none erases all.
 * An item that cannot be erased is left where it is and counted in `failed`.
 */
export async function eraseTrash(ctx: AppContext, cutoff: string | null): Promise<{ erased: Partial<Record<TrashKind, number>>; total: number; failed: number }> {
  const erased: Partial<Record<TrashKind, number>> = {};
  let failed = 0;
  for (const kind of ORDER) {
    const table = TRASH_TABLES[kind];
    for (const id of await trashIds(ctx, kind, cutoff)) {
      // An earlier erase (a patient with its visits) may have taken it already.
      if (!(await ctx.db(table).where({ id }).whereNotNull('deleted_at').first('id'))) continue;
      try {
        await purgeItem(ctx, kind, id);
        erased[kind] = (erased[kind] ?? 0) + 1;
      } catch (err) {
        failed += 1;
        ctx.logger.error({ err, kind, id }, 'trash: erase failed');
      }
    }
  }
  return { erased, total: TRASH_KINDS.reduce((n, k) => n + (erased[k] ?? 0), 0), failed };
}
