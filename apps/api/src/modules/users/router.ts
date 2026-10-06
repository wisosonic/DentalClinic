import { Router } from 'express';
import { z } from 'zod';
import { STAFF_ROLES, emailSchema, passwordProblem, passwordSchema, type Paginated, type PublicUser } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlFuture, sqlNow } from '../../db/connection';
import { generatePassword, randomToken, sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { hashPassword } from '../../lib/password';
import { requireAuth, requirePermission, requireUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { revokeAllForUser, toPublicUser } from '../auth/session';

const idParam = z.coerce.number().int().positive();

/** How long a link handed over by an admin stays valid. */
const RESET_LINK_HOURS = 24;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  role: z.enum(['admin', 'doctor', 'staff', 'patient']).optional(),
});

const createBody = z.object({
  name: z.string().trim().min(1).max(255),
  email: emailSchema,
  role: z.enum(STAFF_ROLES),
  password: passwordSchema.optional(),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    role: z.enum(STAFF_ROLES),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export function usersRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', requirePermission('users:read'), async (req, res) => {
    const { page, pageSize, q, role } = listQuery.parse(req.query);
    const base = db('users').modify((qb) => {
      if (role) qb.where({ role });
      if (q) qb.where((w) => w.whereLike('name', `%${q}%`).orWhereLike('email', `%${q}%`));
    });
    const total = Number((await base.clone().count({ n: '*' }).first())?.n ?? 0);
    const rows = await base.clone().orderBy('name').limit(pageSize).offset((page - 1) * pageSize);
    const body: Paginated<PublicUser> = {
      data: rows.map(toPublicUser),
      meta: { page, pageSize, total },
    };
    res.json(body);
  });

  router.post('/', requirePermission('users:create'), async (req, res) => {
    const actor = requireUser(req);
    const body = createBody.parse(req.body);

    const problem = body.password ? passwordProblem(body.password, { email: body.email }) : null;
    if (problem) throw badRequest('WEAK_PASSWORD', problem);
    if (await db('users').whereRaw('lower(email) = ?', [body.email]).first('id')) {
      throw conflict('EMAIL_TAKEN', 'A user with this email already exists');
    }

    // Without an explicit password, generate one; it is shown once and must be changed at first login.
    const temporaryPassword = body.password ? undefined : generatePassword();
    const now = sqlNow();
    const [id] = await db('users').insert({
      name: body.name,
      email: body.email,
      role: body.role,
      password: await hashPassword(body.password ?? temporaryPassword!, env.BCRYPT_COST),
      change_password: true,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
    await audit(ctx, req, { userId: actor.id, action: 'user.create', entity: 'user', entityId: id as number, diff: { email: body.email, role: body.role } });

    const row = await db('users').where({ id }).first();
    res.status(201).json({ user: toPublicUser(row), temporaryPassword });
  });

  router.patch('/:id', requirePermission('users:update'), async (req, res) => {
    const actor = requireUser(req);
    const id = idParam.parse(req.params.id);
    const body = updateBody.parse(req.body);

    const target = await db('users').where({ id }).first();
    if (!target) throw notFound('User not found');
    if (target.role === 'patient' && body.role) {
      throw badRequest('PATIENT_ROLE_LOCKED', 'Patient accounts are managed through the patient record');
    }

    const losesAdmin =
      target.role === 'admin' && target.is_active && (body.isActive === false || (body.role && body.role !== 'admin'));
    if (losesAdmin) {
      if (id === actor.id) throw conflict('SELF_MODIFY', 'You cannot remove your own admin access');
      const others = await db('users').where({ role: 'admin', is_active: true }).whereNot({ id }).count({ n: '*' }).first();
      if (Number(others?.n) === 0) throw conflict('LAST_ADMIN', 'There must be at least one active admin');
    }
    if (id === actor.id && body.isActive === false) throw conflict('SELF_MODIFY', 'You cannot deactivate yourself');

    const update: Record<string, unknown> = { updated_at: sqlNow() };
    if (body.name !== undefined) update.name = body.name;
    if (body.role !== undefined) update.role = body.role;
    if (body.isActive !== undefined) update.is_active = body.isActive;
    await db('users').where({ id }).update(update);

    // A role change or deactivation must end existing sessions.
    if (body.isActive === false || (body.role && body.role !== target.role)) await revokeAllForUser(ctx, id);

    await audit(ctx, req, {
      userId: actor.id, action: body.isActive === false ? 'user.deactivate' : 'user.update', entity: 'user', entityId: id, diff: body,
    });
    res.json({ user: toPublicUser(await db('users').where({ id }).first()) });
  });

  router.post('/:id/reset-password', requirePermission('users:update'), async (req, res) => {
    const actor = requireUser(req);
    const id = idParam.parse(req.params.id);
    if (!(await db('users').where({ id }).first('id'))) throw notFound('User not found');

    const temporaryPassword = generatePassword();
    await db('users').where({ id }).update({
      password: await hashPassword(temporaryPassword, env.BCRYPT_COST),
      change_password: true,
      failed_logins: 0,
      locked_until: null,
      updated_at: sqlNow(),
    });
    await revokeAllForUser(ctx, id);
    await audit(ctx, req, { userId: actor.id, action: 'user.reset-password', entity: 'user', entityId: id });
    res.json({ temporaryPassword });
  });

  // A one-time link the admin hands to the person (the clinic has no email). It lets them choose
  // their own password, so the admin never knows it. A new link cancels any earlier one.
  router.post('/:id/reset-link', requirePermission('users:update'), async (req, res) => {
    const actor = requireUser(req);
    const id = idParam.parse(req.params.id);
    const target = await db('users').where({ id }).first();
    if (!target) throw notFound('User not found');
    if (!target.is_active) throw badRequest('USER_INACTIVE', 'This account is switched off');

    const token = randomToken(32);
    await db('password_reset_tokens').where({ user_id: id }).whereNull('used_at').update({ used_at: sqlNow() });
    await db('password_reset_tokens').insert({
      user_id: id, token_hash: sha256(token), expires_at: sqlFuture(RESET_LINK_HOURS * 60 * 60 * 1000), created_at: sqlNow(),
    });
    await audit(ctx, req, { userId: actor.id, action: 'user.reset-link', entity: 'user', entityId: id });
    res.json({ link: `${env.APP_URL}/reset-password/${token}`, expiresInHours: RESET_LINK_HOURS });
  });

  return router;
}
