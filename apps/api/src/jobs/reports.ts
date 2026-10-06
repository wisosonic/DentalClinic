import cron from 'node-cron';
import type { AppContext } from '../context';
import { cleanupReportJobs, runPendingReportJobs } from '../modules/reports/jobs';

/**
 * Background reports: picks up any queued report every minute (a report is also started as soon as it is asked
 * for; this catches the ones left over after a restart), and once an hour deletes the files that have expired.
 * One API process only, like the notification jobs.
 */
export function startReportJobs(ctx: AppContext): { stop: () => void } {
  const run = (name: string, job: () => Promise<number>) => async () => {
    try {
      const n = await job();
      if (n) ctx.logger.info({ job: name, n }, 'report jobs');
    } catch (err) {
      ctx.logger.error({ err, job: name }, 'report job run failed');
    }
  };
  const tasks = [cron.schedule('* * * * *', run('make-reports', () => runPendingReportJobs(ctx))), cron.schedule('17 * * * *', run('clean-reports', () => cleanupReportJobs(ctx)))];
  return { stop: () => tasks.forEach((t) => t.stop()) };
}
