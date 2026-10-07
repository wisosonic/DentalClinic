import { pino } from 'pino';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createDb } from './db/connection';
import { migrateLatest } from './db/migrate';
import { startNotificationJobs } from './jobs/notifications';
import { startReportJobs } from './jobs/reports';
import { startRetentionJobs } from './jobs/retention';

const env = loadEnv();
const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: ['req.headers.cookie', 'req.headers.authorization'],
});
const db = createDb(env);

const applied = await migrateLatest(db);
if (applied.length) logger.info({ applied }, 'database migrated');

const ctx = { db, env, logger, clock: () => new Date() };
const app = createApp(ctx);
// Reminders and overdue lab orders, every 15 minutes (this process only; see the note in jobs/notifications.ts).
const jobs = startNotificationJobs(ctx);
const reportJobs = startReportJobs(ctx);
const retentionJobs = startRetentionJobs(ctx);
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT} (db: ${env.DB_CLIENT})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    jobs.stop();
    reportJobs.stop();
    retentionJobs.stop();
    server.close(() => db.destroy().then(() => process.exit(0)));
  });
}
