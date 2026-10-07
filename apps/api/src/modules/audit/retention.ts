import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { operating } from '../settings/operating';
import { audit } from './audit';

/** The activity-log retention rule: entries older than the chosen number of days are removed. Off when the setting is 0. */
export async function runAuditRetention(ctx: AppContext): Promise<number> {
  const { auditDays } = (await operating(ctx)).retention;
  if (auditDays <= 0) return 0;
  const cutoff = sqlNow(new Date(ctx.clock().getTime() - auditDays * 24 * 60 * 60 * 1000));
  const removed = await ctx.db('audit_log').where('created_at', '<', cutoff).del();
  if (removed) await audit(ctx, null, { userId: null, action: 'audit.retention', diff: { days: auditDays, removed } });
  return removed;
}
