import { Router } from 'express';
import { z } from 'zod';
import {
  categoryInputSchema,
  categoryUpdateSchema,
  medicationInputSchema,
  medicationUpdateSchema,
  type CategoryDto,
  type MedicationDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { isForeignKeyError } from '../../lib/dbErrors';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { audit } from '../audit/audit';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

const toMedication = (r: Row): MedicationDto => ({ id: r.id, name: r.name, type: r.type ?? null });

const parseList = <T>(value: unknown): T[] => {
  try {
    const list = JSON.parse(String(value));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

export const toCategory = (r: Row): CategoryDto => ({
  id: r.id,
  name: r.name,
  priceMin: Number(r.price_min),
  priceMax: Number(r.price_max),
  features: parseList<string>(r.features),
  featurePrices: parseList<number>(r.feature_prices).map(Number),
});

/**
 * The prescribing catalog: names only, no stock. Admins and doctors add and edit; only admins delete.
 * Mounted at /medications.
 */
export function medicationsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  const nameTaken = async (name: string, exceptId?: number) =>
    Boolean(
      await db('medications')
        .whereRaw('LOWER(name) = ?', [name.toLowerCase()])
        .modify((qb) => {
          if (exceptId) qb.whereNot({ id: exceptId });
        })
        .first('id'),
    );

  router.get('/', requirePermission('medications:read'), async (_req, res) => {
    res.json({ data: (await db('medications').orderBy('name')).map(toMedication) });
  });

  router.post('/', requirePermission('medications:create'), async (req, res) => {
    const user = requireUser(req);
    const input = medicationInputSchema.parse(req.body);
    if (await nameTaken(input.name)) throw new HttpError(409, 'NAME_TAKEN', 'This medication is already in the list');
    const now = sqlNow();
    const [id] = await db('medications').insert({ name: input.name, type: input.type ?? null, created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'medication.create', entity: 'medication', entityId: id as number });
    res.status(201).json({ medication: toMedication(await db('medications').where({ id }).first()) });
  });

  router.patch('/:id', requirePermission('medications:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = medicationUpdateSchema.parse(req.body);
    if (!Object.keys(input).length) throw badRequest('EMPTY_UPDATE', 'Nothing to update');
    if (!(await db('medications').where({ id }).first('id'))) throw notFound('Medication not found');
    if (input.name && (await nameTaken(input.name, id))) throw new HttpError(409, 'NAME_TAKEN', 'This medication is already in the list');
    await db('medications').where({ id }).update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      updated_at: sqlNow(),
    });
    await audit(ctx, req, { userId: user.id, action: 'medication.update', entity: 'medication', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ medication: toMedication(await db('medications').where({ id }).first()) });
  });

  router.delete('/:id', requireRole('admin'), requirePermission('medications:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    try {
      if (!(await db('medications').where({ id }).del())) throw notFound('Medication not found');
    } catch (err) {
      if (isForeignKeyError(err)) throw new HttpError(409, 'MEDICATION_IN_USE', 'This medication appears in prescriptions and cannot be deleted');
      throw err;
    }
    await audit(ctx, req, { userId: user.id, action: 'medication.delete', entity: 'medication', entityId: id });
    res.status(204).end();
  });

  return router;
}

/**
 * Procedures (categories), with their price range and optional priced extras. Reading is in the
 * reference router; admins change them here. Mounted at /categories.
 */
export function categoriesRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx)); // writes are admin-only through the permission matrix; GET falls through to the reference router

  const values = (input: z.infer<typeof categoryUpdateSchema>) => ({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.priceMin !== undefined ? { price_min: input.priceMin } : {}),
    ...(input.priceMax !== undefined ? { price_max: input.priceMax } : {}),
    ...(input.features !== undefined ? { features: JSON.stringify(input.features) } : {}),
    ...(input.featurePrices !== undefined ? { feature_prices: JSON.stringify(input.featurePrices) } : {}),
  });

  router.post('/', requirePermission('categories:create'), async (req, res) => {
    const user = requireUser(req);
    const input = categoryInputSchema.parse(req.body);
    const now = sqlNow();
    const [id] = await db('categories').insert({ ...values(input), created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'category.create', entity: 'category', entityId: id as number });
    res.status(201).json({ category: toCategory(await db('categories').where({ id }).first()) });
  });

  router.patch('/:id', requirePermission('categories:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = categoryUpdateSchema.parse(req.body);
    if (!Object.keys(input).length) throw badRequest('EMPTY_UPDATE', 'Nothing to update');
    const current = await db('categories').where({ id }).first();
    if (!current) throw notFound('Procedure not found');

    // The price range and the extras must still make sense together once merged with what's stored.
    const merged = {
      priceMin: input.priceMin ?? Number(current.price_min),
      priceMax: input.priceMax ?? Number(current.price_max),
      features: input.features ?? parseList<string>(current.features),
      featurePrices: input.featurePrices ?? parseList<number>(current.feature_prices),
    };
    if (merged.priceMin > merged.priceMax) throw badRequest('INVALID_PRICE_RANGE', 'The maximum price must be at least the minimum');
    if (merged.features.length !== merged.featurePrices.length) throw badRequest('INVALID_EXTRAS', 'Each extra needs a price');

    await db('categories').where({ id }).update({ ...values(input), updated_at: sqlNow() });
    await audit(ctx, req, { userId: user.id, action: 'category.update', entity: 'category', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ category: toCategory(await db('categories').where({ id }).first()) });
  });

  router.delete('/:id', requirePermission('categories:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    try {
      if (!(await db('categories').where({ id }).del())) throw notFound('Procedure not found');
    } catch (err) {
      if (isForeignKeyError(err)) throw new HttpError(409, 'CATEGORY_IN_USE', 'This procedure is used by appointments and cannot be deleted');
      throw err;
    }
    await audit(ctx, req, { userId: user.id, action: 'category.delete', entity: 'category', entityId: id });
    res.status(204).end();
  });

  return router;
}
