import { Router } from 'express';
import { z } from 'zod';
import type { NotificationDto, Paginated } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { notFound } from '../../lib/errors';
import { requireAuth, requirePermission, requireUser } from '../../middleware/auth';
import { notificationBus, toDto } from './service';

const idParam = z.coerce.number().int().positive();
const listQuery = z.object({
  status: z.enum(['unread', 'read']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Seconds between the comments that keep a quiet stream from being closed by a proxy. */
const HEARTBEAT_MS = 25_000;

/** A person's own notifications: the list, the unread count, marking read, and a live stream. */
export function notificationsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  const mine = (userId: number) => db('notifications').where({ user_id: userId });

  router.get('/', requirePermission('notifications:read'), async (req, res) => {
    const user = requireUser(req);
    const q = listQuery.parse(req.query);
    const base = () => mine(user.id).modify((qb) => { if (q.status) qb.where({ status: q.status }); });
    const total = (await base().count({ n: '*' }).first()) as { n: number } | undefined;
    const unread = (await mine(user.id).where({ status: 'unread' }).count({ n: '*' }).first()) as { n: number } | undefined;
    const rows = await base().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const body: Paginated<NotificationDto> & { unread: number } = {
      data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) }, unread: Number(unread?.n ?? 0),
    };
    res.json(body);
  });

  router.post('/read-all', requirePermission('notifications:update'), async (req, res) => {
    const user = requireUser(req);
    const now = sqlNow();
    await mine(user.id).where({ status: 'unread' }).update({ status: 'read', read_at: now, updated_at: now });
    res.status(204).end();
  });

  /** Live delivery: Server-Sent Events. The page falls back to asking again every minute if this cannot stay open. */
  router.get('/stream', requirePermission('notifications:read'), async (req, res) => {
    const user = requireUser(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = (n: NotificationDto) => res.write(`id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);

    // A page that reconnects says where it was; whatever it missed is sent first.
    const lastId = Number(req.headers['last-event-id']);
    if (Number.isInteger(lastId) && lastId > 0) {
      const missed = await mine(user.id).where('id', '>', lastId).orderBy('id').limit(50);
      for (const row of missed) send(toDto(row));
    }
    res.write(': connected\n\n');

    const channel = `user:${user.id}`;
    notificationBus.on(channel, send);
    const beat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      notificationBus.off(channel, send);
    });
  });

  router.patch('/:id/read', requirePermission('notifications:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const row = await mine(user.id).where({ id }).first();
    if (!row) throw notFound('Notification not found'); // someone else's looks like none at all
    if (row.status !== 'read') {
      const now = sqlNow();
      await mine(user.id).where({ id }).update({ status: 'read', read_at: now, updated_at: now });
    }
    res.json({ notification: toDto(await mine(user.id).where({ id }).first()) });
  });

  return router;
}
