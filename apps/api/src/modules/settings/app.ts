import { Router } from 'express';
import {
  appearanceSettingsSchema, generalSettingsSchema, isTimeZone,
  type AppearanceSettingsDto, type GeneralSettingsDto, type PublicSettingsDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { sqlNow } from '../../db/connection';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { loadOperating } from './operating';

const KEYS = {
  language: 'general.language',
  timezone: 'general.timezone',
  address: 'clinic.address',
  phone: 'clinic.phone',
  email: 'clinic.email',
  mode: 'appearance.mode',
  textSize: 'appearance.textSize',
  remindersOn: 'notify.reminders',
  eventsOn: 'notify.events',
} as const;

export async function readAll(db: Db): Promise<Map<string, string>> {
  const rows: { key: string; value: string }[] = await db('app_settings').select('key', 'value');
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function save(db: Db, userId: number, values: Record<string, string | null>): Promise<void> {
  const now = sqlNow();
  await db.transaction(async (trx) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        await trx('app_settings').where({ key }).del(); // cleared: back to the default
        continue;
      }
      const updated = await trx('app_settings').where({ key }).update({ value, updated_by: userId, updated_at: now });
      if (!updated) await trx('app_settings').insert({ key, value, updated_by: userId, created_at: now, updated_at: now });
    }
  });
}

/** The timezone the server was started with (CLINIC_TIMEZONE): what is used until the admin saves one. */
const startupTimezone = new WeakMap<object, string>();

/** Makes the saved timezone the one every date calculation uses (`clinicNow` reads it from the environment). */
export async function applyTimezone(ctx: AppContext): Promise<void> {
  if (!startupTimezone.has(ctx)) startupTimezone.set(ctx, ctx.env.CLINIC_TIMEZONE);
  const saved = (await readAll(ctx.db)).get(KEYS.timezone);
  ctx.env.CLINIC_TIMEZONE = saved && isTimeZone(saved) ? saved : startupTimezone.get(ctx)!;
}

/** The two notification switches. Both are on until an admin turns one off (Settings > General). */
export async function notificationSwitches(db: Db): Promise<{ reminders: boolean; events: boolean }> {
  const all = await readAll(db);
  return { reminders: all.get(KEYS.remindersOn) !== '0', events: all.get(KEYS.eventsOn) !== '0' };
}

export async function loadGeneral(ctx: AppContext): Promise<GeneralSettingsDto> {
  const all = await readAll(ctx.db);
  const saved = all.get(KEYS.timezone);
  return {
    language: all.get(KEYS.language) === 'ar' ? 'ar' : 'en',
    timezone: saved && isTimeZone(saved) ? saved : (startupTimezone.get(ctx) ?? ctx.env.CLINIC_TIMEZONE),
    clinic: { address: all.get(KEYS.address) ?? null, phone: all.get(KEYS.phone) ?? null, email: all.get(KEYS.email) ?? null },
    notifications: { reminders: all.get(KEYS.remindersOn) !== '0', events: all.get(KEYS.eventsOn) !== '0' },
  };
}

export async function loadAppearance(db: Db): Promise<AppearanceSettingsDto> {
  const all = await readAll(db);
  const size = all.get(KEYS.textSize);
  return { mode: all.get(KEYS.mode) === 'dark' ? 'dark' : 'light', textSize: size === 'small' || size === 'large' ? size : 'medium' };
}

/**
 * The clinic's contact details from Settings, for the letterhead of the PDFs. A detail that is set there
 * replaces the one on the clinic's own record; one that is not set leaves the record's as it was.
 */
export async function contactOverride(db: Db): Promise<{ address?: string; phone?: string; email?: string }> {
  const all = await readAll(db);
  return {
    ...(all.get(KEYS.address) ? { address: all.get(KEYS.address) } : {}),
    ...(all.get(KEYS.phone) ? { phone: all.get(KEYS.phone) } : {}),
    ...(all.get(KEYS.email) ? { email: all.get(KEYS.email) } : {}),
  };
}

/** What is open to everyone, signed in or not: the look of the app and the language to start in. */
export function publicSettingsRouter(ctx: AppContext): Router {
  const router = Router();
  router.get('/public-settings', async (_req, res) => {
    const [general, appearance] = [await loadGeneral(ctx), await loadAppearance(ctx.db)];
    const body: PublicSettingsDto = { language: general.language, mode: appearance.mode, textSize: appearance.textSize, passwordMinLength: (await loadOperating(ctx.db, ctx.env)).security.passwordMinLength };
    res.json(body);
  });
  return router;
}

/** General and Appearance settings; admin only. */
export function appSettingsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin'));

  router.get('/general', requirePermission('settings:read'), async (_req, res) => {
    res.json(await loadGeneral(ctx));
  });

  router.put('/general', requirePermission('settings:update'), async (req, res) => {
    const user = requireUser(req);
    const input = generalSettingsSchema.parse(req.body);
    await save(db, user.id, {
      [KEYS.language]: input.language,
      [KEYS.timezone]: input.timezone,
      [KEYS.address]: input.clinic.address ?? null,
      [KEYS.phone]: input.clinic.phone ?? null,
      [KEYS.email]: input.clinic.email ?? null,
      ...(input.notifications ? { [KEYS.remindersOn]: input.notifications.reminders ? '1' : '0', [KEYS.eventsOn]: input.notifications.events ? '1' : '0' } : {}),
    });
    await applyTimezone(ctx);
    // Which settings changed, never the contact details themselves.
    await audit(ctx, req, { userId: user.id, action: 'settings.general.update', entity: 'settings', entityId: 'general', diff: { language: input.language, timezone: input.timezone, ...(input.notifications ? { notifications: input.notifications } : {}) } });
    res.json(await loadGeneral(ctx));
  });

  router.get('/appearance', requirePermission('settings:read'), async (_req, res) => {
    res.json(await loadAppearance(db));
  });

  router.put('/appearance', requirePermission('settings:update'), async (req, res) => {
    const user = requireUser(req);
    const input = appearanceSettingsSchema.parse(req.body);
    await save(db, user.id, { [KEYS.mode]: input.mode, [KEYS.textSize]: input.textSize });
    await audit(ctx, req, { userId: user.id, action: 'settings.appearance.update', entity: 'settings', entityId: 'appearance', diff: input });
    res.json(await loadAppearance(db));
  });

  return router;
}
