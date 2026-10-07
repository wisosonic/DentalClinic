import { Router } from 'express';
import { z } from 'zod';
import type { AuditEntryDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, notFound } from '../../lib/errors';
import { requireAuth, requirePermission, requireUser } from '../../middleware/auth';
import { audit } from './audit';

type Row = Record<string, string | number | null>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().trim().max(80).optional(),
  userId: z.coerce.number().int().positive().optional(),
  /** 'views' = someone opened a patient's record; 'changes' = everything else (edits, sign-ins, ...). */
  kind: z.enum(['views', 'changes']).optional(),
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(40).optional(),
  from: date.optional(),
  to: date.optional(),
  sort: z.enum(['time', 'user', 'action']).default('time'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const EXPORT_MAX = 100_000;

/** One CSV cell. A leading = + - @ would make a spreadsheet run it as a formula, so it gets a quote in front. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const DOCUMENTS = ['report.pdf', 'quote.pdf', 'offer.pdf', 'payment.receipt'];

export function auditRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requirePermission('audit:read'));

  /** The entries a filter selects, with the person's name. */
  const filtered = (q: z.output<typeof query>) =>
    ctx.db('audit_log as l')
      .leftJoin('users as u', 'u.id', 'l.user_id')
      .modify((qb) => {
        if (q.action) qb.where('l.action', q.action);
        if (q.userId) qb.where('l.user_id', q.userId);
        // Opening a record, or taking a document out of it (a PDF), is a view; everything else is a change.
        if (q.kind === 'views') qb.where((w) => w.where('l.action', 'like', '%.view').orWhereIn('l.action', DOCUMENTS));
        if (q.kind === 'changes') qb.whereNot('l.action', 'like', '%.view').whereNotIn('l.action', DOCUMENTS);
        if (q.entity) qb.where('l.entity', q.entity);
        if (q.entityId) qb.where('l.entity_id', q.entityId);
        if (q.from) qb.where('l.created_at', '>=', `${q.from} 00:00:00`);
        if (q.to) qb.where('l.created_at', '<=', `${q.to} 23:59:59`);
      });

  // The log as a spreadsheet file: the same filters as the list, every matching entry, oldest first. Ids and names only, like the list.
  router.get('/export.csv', async (req, res) => {
    const user = requireUser(req);
    const q = query.parse(req.query);
    const base = filtered(q);
    const total = Number((await base.clone().count({ n: '*' }).first())?.n ?? 0);
    if (total > EXPORT_MAX) throw new HttpError(413, 'TOO_MANY_ROWS', `There are ${total} entries; narrow the dates (the limit is ${EXPORT_MAX})`);
    const rows: Row[] = await base.clone().select('l.*', 'u.name as user_name').orderBy([{ column: 'l.created_at', order: 'asc' }, { column: 'l.id', order: 'asc' }]);
    const lines = [['When (UTC)', 'Person', 'Action', 'Record type', 'Record id', 'Details', 'IP address'].map(csvCell).join(',')];
    for (const r of rows) lines.push([r.created_at, r.user_name, r.action, r.entity, r.entity_id, r.diff, r.ip].map(csvCell).join(','));
    await audit(ctx, req, { userId: user.id, action: 'audit.export', diff: { rows: rows.length, from: q.from ?? null, to: q.to ?? null } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="activity-log-${sqlNow().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
  });

  router.get('/', async (req, res) => {
    const q = query.parse(req.query);
    const base = filtered(q);
    const total = Number((await base.clone().count({ n: '*' }).first())?.n ?? 0);

    const column = { time: 'l.created_at', user: 'u.name', action: 'l.action' }[q.sort];
    const rows = await base.clone()
      .select('l.*', 'u.name as user_name')
      .orderBy([{ column, order: q.order }, { column: 'l.id', order: q.order }])
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);

    // Patient names for patient entries: one query, not one per row.
    const patientIds: number[] = [...new Set<number>(rows.filter((r: Row) => r.entity === 'patient').map((r: Row) => Number(r.entity_id)))];
    const names = new Map<number, string>();
    if (patientIds.length) {
      for (const p of (await ctx.db('patients').whereIn('id', patientIds).select(['id', 'fname', 'lname'])) as Row[]) {
        names.set(p.id as number, `${p.fname} ${p.lname}`.trim());
      }
    }

    const data: AuditEntryDto[] = rows.map((r: Row) => ({
      id: r.id as number,
      userId: (r.user_id as number | null) ?? null,
      userName: (r.user_name as string | null) ?? null,
      action: r.action as string,
      entity: (r.entity as string | null) ?? null,
      entityId: (r.entity_id as string | null) ?? null,
      entityLabel: r.entity === 'patient' ? names.get(Number(r.entity_id)) ?? null : null,
      diff: r.diff ? JSON.parse(r.diff as string) : null,
      ip: (r.ip as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
    res.json({ data, meta: { page: q.page, pageSize: q.pageSize, total } });
  });

  // Removes one entry. Only that it happened is recorded (its id and kind), never its content.
  router.delete('/:id', requirePermission('audit:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const entry = await ctx.db('audit_log').where({ id }).first('action');
    if (!entry) throw notFound('Log entry not found');
    await ctx.db('audit_log').where({ id }).del();
    await audit(ctx, req, { userId: user.id, action: 'audit.delete', diff: { entryId: id, entryAction: entry.action } });
    res.status(204).end();
  });

  // Wipes the whole log (an owner decision, 2026-10-02). The wipe itself is recorded afterwards: who did it and how many entries went.
  router.delete('/', requirePermission('audit:delete'), async (req, res) => {
    const user = requireUser(req);
    const removed = await ctx.db('audit_log').del();
    await audit(ctx, req, { userId: user.id, action: 'audit.clear', diff: { removed } });
    res.json({ removed });
  });

  return router;
}
