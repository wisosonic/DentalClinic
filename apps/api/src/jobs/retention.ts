import cron from 'node-cron';
import type { AppContext } from '../context';
import { runAuditRetention } from '../modules/audit/retention';
import { runTrashRetention } from '../modules/trash/retention';

/** Once a night: erase what has been in the Trash too long and trim the activity log, as the admin chose in Settings (both off until chosen). One API process only. */
export function startRetentionJobs(ctx: AppContext): { stop: () => void } {
  const run = (name: string, job: () => Promise<number>) => async () => {
    try {
      const n = await job();
      if (n) ctx.logger.info({ job: name, n }, 'retention');
    } catch (err) {
      ctx.logger.error({ err, job: name }, 'retention job failed');
    }
  };
  const tasks = [cron.schedule('30 3 * * *', run('trash-retention', () => runTrashRetention(ctx))), cron.schedule('40 3 * * *', run('audit-retention', () => runAuditRetention(ctx)))];
  return { stop: () => tasks.forEach((t) => t.stop()) };
}
