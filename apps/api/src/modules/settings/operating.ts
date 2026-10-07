import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_DURATION, OPERATING_GROUPS, OPERATING_SCHEMAS, type OperatingGroup, type OperatingSettings } from '@aya/shared';
import type { AppContext } from '../../context';
import type { Env } from '../../config/env';
import type { Db } from '../../db/connection';
import { HttpError, notFound } from '../../lib/errors';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { readAll, save } from './app';

/**
 * The operating settings (owner decision 2026-10-07): numbers and switches an admin changes under Settings, in seven
 * groups (appointments, security, portal, waiting, uploads, display, retention). Each value is one row of `app_settings` named
 * `<group>.<field>`; with no row, the starting value below applies. Where the server's environment used to hold the
 * value (cancel notice, lockout, how long "keep me signed in" lasts) the environment is now only that starting value.
 */
export function operatingDefaults(env: Env): OperatingSettings {
  return {
    appointments: { defaultDuration: DEFAULT_DURATION, cancelMinHours: env.CANCEL_MIN_HOURS, staffReminderMinutes: 120, patientReminderHours: 24 },
    security: { maxFailedLogins: env.MAX_FAILED_LOGINS, lockoutMinutes: env.LOCKOUT_MINUTES, passwordMinLength: 10, rememberDays: env.REFRESH_TTL_DAYS_REMEMBER },
    portal: { enabled: true, showPayments: true, documentsVisibleByDefault: false },
    waiting: { chime: true, unitLetters: false, finishedCallSeconds: 0 },
    uploads: { maxDocumentMb: 25, maxDocumentsPerPatient: 200 },
    display: { weekStart: 'monday', timeFormat: '24h' },
    retention: { trashDays: 0, auditDays: 0 },
  };
}

const keyOf = (group: OperatingGroup, field: string) => `${group}.${field}`;

/** A saved text value as the field's own type, or undefined when it is not one. */
function fromText(raw: string, sample: unknown): unknown {
  if (typeof sample === 'boolean') return raw === '1';
  if (typeof sample === 'number') return Number(raw);
  return raw;
}

/** Every group with its saved values over the starting values; a saved value that is no longer valid falls back to the starting one. */
export async function loadOperating(db: Db, env: Env): Promise<OperatingSettings> {
  const saved = await readAll(db);
  const out = operatingDefaults(env) as unknown as Record<OperatingGroup, Record<string, unknown>>;
  for (const group of OPERATING_GROUPS) {
    const shape = OPERATING_SCHEMAS[group].shape as Record<string, z.ZodTypeAny>;
    for (const field of Object.keys(shape)) {
      const raw = saved.get(keyOf(group, field));
      if (raw === undefined) continue;
      const parsed = shape[field]!.safeParse(fromText(raw, out[group]![field]));
      if (parsed.success) out[group]![field] = parsed.data;
    }
  }
  return out as unknown as OperatingSettings;
}

export const operating = (ctx: AppContext): Promise<OperatingSettings> => loadOperating(ctx.db, ctx.env);

/** The patient portal is switched off: nothing in it answers, a patient cannot cancel online, and the clinic is told so. */
export async function assertPortalOn(ctx: AppContext): Promise<OperatingSettings> {
  const settings = await operating(ctx);
  if (!settings.portal.enabled) throw new HttpError(403, 'PORTAL_OFF', 'The patient portal is switched off. Please contact the clinic.');
  return settings;
}

/** `GET` and `PUT /settings/<group>` for the seven groups, admin only. */
export function operatingSettingsRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin'));
  const groupOf = (name: string): OperatingGroup => {
    if (!(OPERATING_GROUPS as string[]).includes(name)) throw notFound('Unknown settings page');
    return name as OperatingGroup;
  };

  router.get('/:group', requirePermission('settings:read'), async (req, res) => {
    const group = groupOf(String(req.params.group));
    res.json((await operating(ctx))[group]);
  });

  router.put('/:group', requirePermission('settings:update'), async (req, res) => {
    const user: AuthUser = requireUser(req);
    const group = groupOf(String(req.params.group));
    const input = OPERATING_SCHEMAS[group].parse(req.body) as Record<string, unknown>;
    const before = (await operating(ctx))[group] as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const [field, value] of Object.entries(input)) values[keyOf(group, field)] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    await save(ctx.db, user.id, values);
    const changed = Object.fromEntries(Object.entries(input).filter(([field, value]) => before[field] !== value));
    await audit(ctx, req, { userId: user.id, action: `settings.${group}.update`, entity: 'settings', entityId: group, diff: changed }); // numbers and switches only
    res.json((await operating(ctx))[group]);
  });

  return router;
}
