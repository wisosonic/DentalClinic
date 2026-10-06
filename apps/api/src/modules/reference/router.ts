import { Router } from 'express';
import { DEFAULT_DURATION, DURATION_STEP, MAX_DURATION, MIN_DURATION, type CategoryDto, type ClinicConfigDto, type ToothDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { toCategory } from '../catalog/router';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/** Read-only reference data and the clinic's booking rules. */
export function referenceRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  const auth = requireAuth(ctx);

  router.get('/teeth', auth, requirePermission('teeth:read'), async (_req, res) => {
    const rows = await db('teeth').orderBy('id');
    const data: ToothDto[] = rows.map((r: Row) => ({ id: r.id, index: r.index, name: r.name, type: r.type }));
    res.json({ data });
  });

  router.get('/categories', auth, requirePermission('categories:read'), async (_req, res) => {
    const rows = await db('categories').orderBy('name');
    const data: CategoryDto[] = rows.map(toCategory);
    res.json({ data });
  });

  // Any signed-in user: the booking screens need the slot length and today's date at the clinic.
  router.get('/config', auth, (_req, res) => {
    const body: ClinicConfigDto = {
      defaultDuration: DEFAULT_DURATION,
      durationStep: DURATION_STEP,
      minDuration: MIN_DURATION,
      maxDuration: MAX_DURATION,
      cancelMinHours: env.CANCEL_MIN_HOURS,
      timezone: env.CLINIC_TIMEZONE,
      today: clinicNow(env, ctx.clock()).date,
    };
    res.json(body);
  });

  return router;
}
