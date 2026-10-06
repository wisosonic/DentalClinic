import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { limiter } from '../../middleware/rateLimit';
import { requireAuth, requirePermission, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { contactOverride } from '../settings/app';
import {
  REPORT_LIMITS, appointmentsList, dailySchedule, labOrdersReport, outstandingBalances, patientsReport, proceduresReport, revenue,
} from './data';
import { isReportFile, queueReport, reportFilePath, runPendingReportJobs, toJobDto } from './jobs';
import { ACCESS } from './registry';
import { renderPdf, renderXlsx, type Letterhead, type ReportTable } from './render';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');
const period = z.object({ from: date, to: date }).refine((p) => p.from <= p.to, { message: 'The start must not be after the end', path: ['to'] })
  .refine((p) => Date.parse(p.to) - Date.parse(p.from) <= 5 * 366 * 86_400_000, { message: 'Choose a period of up to five years', path: ['to'] });
const format = z.enum(['xlsx', 'pdf']);
const positive = z.coerce.number().int().positive();

const FILE = {
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  pdf: { type: 'application/pdf', ext: 'pdf' },
} as const;

/** Reports and exports. They carry patient and money data, so each is permission-gated, limited like the screens, and logged. */
export function reportsRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), limiter(env, { windowMs: 60_000, limit: 30, message: 'Too many reports. Please wait a minute.' }));

  const letterhead = async (): Promise<Letterhead> => {
    const clinic = await db('clinics').orderBy('id').first('name', 'address', 'phone');
    const c = await contactOverride(db);
    return { name: clinic?.name ?? 'Clinic', address: c.address ?? clinic?.address ?? null, phone: c.phone ?? clinic?.phone ?? null, email: c.email ?? null };
  };

  /** Writes the report in the chosen format, and records who exported what (never the content). */
  async function send(req: Parameters<typeof audit>[1], res: Response, user: AuthUser, key: string, table: ReportTable, fmt: 'xlsx' | 'pdf', params: object, landscape = false) {
    if (table.rows.length > REPORT_LIMITS.sync) {
      // Too big to wait for: Excel files are made in the background (the person is sent to the Reports page, where it appears); a PDF of that size is refused.
      if (fmt !== 'xlsx') throw new HttpError(413, 'TOO_MANY_ROWS', `That report has more than ${REPORT_LIMITS.sync.toLocaleString('en-US')} rows. Choose a shorter period.`);
      const job = await queueReport(ctx, user, key, table.title, params, table.rows.length);
      if (env.NODE_ENV !== 'test') void runPendingReportJobs(ctx).catch((err) => ctx.logger.error({ err }, 'report jobs failed'));
      res.redirect(303, `/reports?queued=${job.id}`);
      return;
    }
    const body = fmt === 'xlsx' ? await renderXlsx(table) : await renderPdf(table, await letterhead(), { compress: env.NODE_ENV !== 'test', landscape });
    await audit(ctx, req, { userId: user.id, action: 'report.export', entity: 'report', entityId: key, diff: { format: fmt, rows: table.rows.length, ...params } });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', FILE[fmt].type);
    res.setHeader('Content-Disposition', `attachment; filename="${key}-${stamp}.${FILE[fmt].ext}"`);
    res.setHeader('Cache-Control', 'no-store'); // patient and money data: never kept by a cache
    res.send(body);
  }

  const gate = (key: string, user: AuthUser) => {
    if (!ACCESS[key]!.includes(user.role)) throw forbidden();
  };
  const range = (q: unknown) => {
    const r = period.safeParse(q);
    if (!r.success) throw badRequest('INVALID_PERIOD', r.error.issues[0]!.message);
    return r.data;
  };

  router.get('/', requirePermission('reports:read'), (req, res) => {
    const role = requireUser(req).role;
    res.json({ data: Object.entries(ACCESS).filter(([, roles]) => roles.includes(role)).map(([key]) => key) });
  });

  // Reports made in the background: your own, newest first, and the finished file (only for the person who asked).
  router.get('/jobs', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    const rows = await db('report_jobs').where({ user_id: user.id }).whereNot({ status: 'expired' }).orderBy('id', 'desc').limit(20);
    res.set('Cache-Control', 'no-store').json({ data: rows.map(toJobDto) });
  });

  router.get('/jobs/:id/file', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    const job = await db('report_jobs').where({ id: positive.parse(req.params.id), user_id: user.id }).first();
    if (!job) throw notFound('Report not found');
    if (job.status !== 'done' || !isReportFile(job.file_name)) throw new HttpError(409, 'REPORT_NOT_READY', 'This report is not ready, or has expired');
    await audit(ctx, req, { userId: user.id, action: 'report.download', entity: 'report', entityId: job.report, diff: { jobId: job.id } });
    res.set({ 'Content-Type': FILE.xlsx.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.download(reportFilePath(ctx, job.file_name), `${job.report}-${String(job.created_at).slice(0, 10)}.xlsx`, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Report not found' } });
    });
  });

  router.get('/daily-schedule', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    gate('daily-schedule', user);
    const q = z.object({ date, doctorId: positive.optional() }).parse(req.query);
    await send(req, res, user, 'daily-schedule', await dailySchedule(ctx, user, q.date, q.doctorId), 'pdf', { date: q.date, doctorId: q.doctorId ?? null }, true);
  });

  router.get('/revenue', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    gate('revenue', user);
    const p = range(req.query);
    const q = z.object({ groupBy: z.enum(['month', 'type', 'doctor']).default('month'), format: format.default('xlsx') }).parse(req.query);
    if (q.groupBy === 'doctor' && user.role !== 'admin') throw forbidden(); // one doctor's collections are not another's business
    await send(req, res, user, 'revenue', await revenue(ctx, user, p, q.groupBy), q.format, { ...p, groupBy: q.groupBy });
  });

  router.get('/outstanding-balances', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    gate('outstanding-balances', user);
    const q = z.object({ format: format.default('xlsx') }).parse(req.query);
    await send(req, res, user, 'outstanding-balances', await outstandingBalances(ctx, user), q.format, {});
  });

  router.get('/appointments', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    gate('appointments', user);
    const p = range(req.query);
    const q = z.object({ doctorId: positive.optional(), status: z.string().regex(/^[a-z_,]+$/).optional() }).parse(req.query);
    await send(req, res, user, 'appointments', await appointmentsList(ctx, user, p, q), 'xlsx', { ...p, doctorId: q.doctorId ?? null, status: q.status ?? null });
  });

  router.get('/procedures', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    gate('procedures', user);
    const p = range(req.query);
    await send(req, res, user, 'procedures', await proceduresReport(ctx, user, p), 'xlsx', p);
  });

  router.get('/patients', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    gate('patients', user);
    const p = range(req.query);
    await send(req, res, user, 'patients', await patientsReport(ctx, user, p), 'xlsx', p);
  });

  router.get('/lab-orders', requirePermission('reports:read'), async (req, res) => {
    const user = requireUser(req);
    gate('lab-orders', user);
    const p = range(req.query);
    const q = z.object({ status: z.string().regex(/^[a-z_,]+$/).optional() }).parse(req.query);
    await send(req, res, user, 'lab-orders', await labOrdersReport(ctx, user, p, q.status), 'xlsx', { ...p, status: q.status ?? null });
  });

  return router;
}
