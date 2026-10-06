import { Router } from 'express';
import { DEFAULT_TAX_SETTINGS, taxSettingsSchema, taxYearSchema, type TaxRuleSetDto, type TaxSettings } from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { sqlNow } from '../../db/connection';
import { notFound } from '../../lib/errors';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { audit } from '../audit/audit';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/** A stored set, re-validated: a bad row must never silently produce a wrong tax figure. */
function parseSet(row: Row): TaxRuleSetDto | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.settings);
  } catch {
    return null;
  }
  const parsed = taxSettingsSchema.safeParse(raw);
  return parsed.success ? { effectiveYear: row.effective_year, settings: parsed.data as TaxSettings, updatedAt: row.updated_at ?? null } : null;
}

export async function listTaxRuleSets(db: Db): Promise<TaxRuleSetDto[]> {
  const rows: Row[] = await db('tax_rule_sets').orderBy('effective_year', 'desc');
  return rows.map(parseSet).filter((s): s is TaxRuleSetDto => s !== null);
}

/**
 * The rules for a tax year: the latest saved set that applies from that year or before. With none, the
 * owner's starting values are used and `rulesFrom` is null.
 */
export async function loadTaxSettings(db: Db, year: number): Promise<{ settings: TaxSettings; rulesFrom: number | null; usingDefaults: boolean }> {
  const set = (await listTaxRuleSets(db)).find((s) => s.effectiveYear <= year);
  return set ? { settings: set.settings, rulesFrom: set.effectiveYear, usingDefaults: false } : { settings: DEFAULT_TAX_SETTINGS, rulesFrom: null, usingDefaults: true };
}

const yearParam = taxYearSchema;

/** Settings pages. For now only the income tax rules, by year; admin only. */
export function settingsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin'));

  /** Every saved set, newest first, and the starting values to begin from when there are none. */
  const everything = async () => ({ sets: await listTaxRuleSets(db), defaults: DEFAULT_TAX_SETTINGS });

  router.get('/tax', requirePermission('settings:read'), async (_req, res) => {
    res.json(await everything());
  });

  /** Saves the set that applies from this year (adds it, or replaces the one already there). */
  router.put('/tax/:year', requirePermission('settings:update'), async (req, res) => {
    const user = requireUser(req);
    const year = yearParam.parse(req.params.year);
    const input = taxSettingsSchema.parse(req.body);
    const now = sqlNow();
    const settings = JSON.stringify(input);
    const updated = await db('tax_rule_sets').where({ effective_year: year }).update({ settings, updated_by: user.id, updated_at: now });
    if (!updated) await db('tax_rule_sets').insert({ effective_year: year, settings, updated_by: user.id, created_at: now, updated_at: now });
    // The rules are not secret, but the log keeps to what happened, not the figures.
    await audit(ctx, req, { userId: user.id, action: 'settings.tax.update', entity: 'settings', entityId: `tax:${year}`, diff: { year, brackets: input.brackets.length, replaced: updated > 0 } });
    res.json(await everything());
  });

  router.delete('/tax/:year', requirePermission('settings:update'), async (req, res) => {
    const user = requireUser(req);
    const year = yearParam.parse(req.params.year);
    const removed = await db('tax_rule_sets').where({ effective_year: year }).del();
    if (!removed) throw notFound('Tax rules not found');
    await audit(ctx, req, { userId: user.id, action: 'settings.tax.delete', entity: 'settings', entityId: `tax:${year}`, diff: { year } });
    res.json(await everything());
  });

  return router;
}
