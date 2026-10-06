import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ReportJobDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { notify } from '../notifications/service';
import { REPORT_LIMITS } from './data';
import { ACCESS, buildQueued } from './registry';
import { renderXlsxToFile, type ReportTable } from './render';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/** How long a finished file can be downloaded. */
export const JOB_KEEP_DAYS = 7;
/** A person may have this many reports waiting or running at once. */
const MAX_ACTIVE_PER_USER = 3;
/** A job that has been "running" this long was lost (the server stopped): it is marked failed. */
const STALE_RUNNING_MS = 30 * 60_000;

const FILE_NAME = /^report-\d+-[a-f0-9]{12}\.xlsx$/;
export const isReportFile = (name: string | null | undefined): name is string => !!name && FILE_NAME.test(name);

const reportsDir = (ctx: AppContext) => path.resolve(ctx.env.UPLOAD_DIR, 'reports');
const at = (ctx: AppContext, plusMs = 0) => sqlNow(new Date(ctx.clock().getTime() + plusMs));

export const toJobDto = (r: Row): ReportJobDto => ({
  id: r.id, report: r.report, title: r.title, status: r.status, rows: r.row_count ?? null,
  createdAt: r.created_at ?? null, finishedAt: r.finished_at ?? null, expiresAt: r.expires_at ?? null,
  downloadUrl: r.status === 'done' && isReportFile(r.file_name) ? `/api/v1/reports/jobs/${r.id}/file` : null,
});

/** Puts a big report in the queue. Only the filters are saved, never any content. */
export async function queueReport(ctx: AppContext, user: AuthUser, key: string, title: string, params: object, rows: number): Promise<ReportJobDto> {
  if (rows > REPORT_LIMITS.background) {
    throw new HttpError(413, 'TOO_MANY_ROWS', `That report has more than ${REPORT_LIMITS.background.toLocaleString('en-US')} rows. Choose a shorter period.`);
  }
  const active = Number((await ctx.db('report_jobs').where({ user_id: user.id }).whereIn('status', ['queued', 'running']).count({ n: '*' }).first())?.n ?? 0);
  if (active >= MAX_ACTIVE_PER_USER) throw new HttpError(429, 'TOO_MANY_REPORTS', 'You already have reports being prepared. Wait for one to finish.');
  const now = at(ctx);
  const [id] = await ctx.db('report_jobs').insert({ user_id: user.id, report: key, title: title.slice(0, 120), params: JSON.stringify(params), status: 'queued', created_at: now, updated_at: now });
  await audit(ctx, null, { userId: user.id, action: 'report.queue', entity: 'report', entityId: key, diff: { rows, ...params } });
  return toJobDto(await ctx.db('report_jobs').where({ id }).first());
}

async function userFor(ctx: AppContext, id: number): Promise<AuthUser | null> {
  const row = await ctx.db('users').where({ id, is_active: true }).first();
  return row ? { id: row.id, name: row.name, email: row.email, role: row.role, mustChangePassword: Boolean(row.change_password) } : null;
}

async function fail(ctx: AppContext, job: Row, message: string): Promise<void> {
  await ctx.db('report_jobs').where({ id: job.id }).update({ status: 'failed', error: message.slice(0, 255), finished_at: at(ctx), updated_at: at(ctx) });
  await notify(ctx, { userIds: [job.user_id], type: 'report.ready', title: 'Report could not be made', content: `“${job.title}” could not be prepared. ${message}`, link: '/reports', dedupeKey: `report:${job.id}:failed` });
}

/** Makes one queued report: builds it as the person who asked (under their role today), writes the Excel file, tells them. */
export async function runReportJob(ctx: AppContext, id: number): Promise<void> {
  // The status in the WHERE makes sure only one worker takes it.
  const taken = await ctx.db('report_jobs').where({ id, status: 'queued' }).update({ status: 'running', updated_at: at(ctx) });
  if (!taken) return;
  const job: Row = await ctx.db('report_jobs').where({ id }).first();
  try {
    const user = await userFor(ctx, job.user_id);
    if (!user || !ACCESS[job.report]?.includes(user.role)) return await fail(ctx, job, 'You no longer have access to this report.');
    const table: ReportTable = await buildQueued(ctx, user, job.report, JSON.parse(job.params));
    if (table.rows.length > REPORT_LIMITS.background) return await fail(ctx, job, `It has more than ${REPORT_LIMITS.background.toLocaleString('en-US')} rows. Choose a shorter period.`);
    await mkdir(reportsDir(ctx), { recursive: true });
    const name = `report-${id}-${randomBytes(6).toString('hex')}.xlsx`;
    await renderXlsxToFile(table, path.join(reportsDir(ctx), name));
    await ctx.db('report_jobs').where({ id }).update({
      status: 'done', row_count: table.rows.length, file_name: name, finished_at: at(ctx), expires_at: at(ctx, JOB_KEEP_DAYS * 86_400_000), updated_at: at(ctx),
    });
    await audit(ctx, null, { userId: user.id, action: 'report.export', entity: 'report', entityId: job.report, diff: { format: 'xlsx', rows: table.rows.length, background: true } });
    await notify(ctx, { userIds: [user.id], type: 'report.ready', title: 'Report ready', content: `“${job.title}” is ready to download (${table.rows.length.toLocaleString('en-US')} rows, kept ${JOB_KEEP_DAYS} days).`, link: '/reports', dedupeKey: `report:${id}:ready` });
  } catch (err) {
    ctx.logger.error({ err, jobId: id, report: job.report }, 'report job failed');
    await fail(ctx, job, 'Something went wrong. Try again, or choose a shorter period.');
  }
}

let working = false;

/** Makes every queued report, one at a time. Safe to call as often as you like. */
export async function runPendingReportJobs(ctx: AppContext): Promise<number> {
  if (working) return 0;
  working = true;
  let done = 0;
  try {
    // A server that stopped in the middle leaves a job "running" for ever: give those up.
    const stale = at(ctx, -STALE_RUNNING_MS);
    for (const j of await ctx.db('report_jobs').where({ status: 'running' }).where('updated_at', '<', stale)) await fail(ctx, j, 'The server was restarted. Ask for it again.');
    for (const j of await ctx.db('report_jobs').where({ status: 'queued' }).orderBy('id').select('id')) {
      await runReportJob(ctx, j.id);
      done += 1;
    }
  } finally {
    working = false;
  }
  return done;
}

/** Deletes the files of reports past their keep time, and forgets old failed or expired records. */
export async function cleanupReportJobs(ctx: AppContext): Promise<number> {
  const now = at(ctx);
  let removed = 0;
  for (const j of await ctx.db('report_jobs').where({ status: 'done' }).where('expires_at', '<', now)) {
    if (isReportFile(j.file_name)) await unlink(path.join(reportsDir(ctx), j.file_name)).catch(() => undefined);
    await ctx.db('report_jobs').where({ id: j.id }).update({ status: 'expired', file_name: null, updated_at: now });
    removed += 1;
  }
  await ctx.db('report_jobs').whereIn('status', ['failed', 'expired']).where('updated_at', '<', at(ctx, -30 * 86_400_000)).del();
  return removed;
}

export const reportFilePath = (ctx: AppContext, name: string) => path.join(reportsDir(ctx), name);
