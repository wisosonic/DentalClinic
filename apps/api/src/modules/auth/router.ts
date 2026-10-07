import { Router } from 'express';
import {
  changePasswordSchema,
  loginRequestSchema,
  passwordProblem,
  resetPasswordSchema,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlFuture, sqlNow } from '../../db/connection';
import { sha256 } from '../../lib/crypto';
import { badRequest, HttpError, unauthorized } from '../../lib/errors';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from '../../lib/password';
import { requireAuth, requireUser } from '../../middleware/auth';
import { limiter } from '../../middleware/rateLimit';
import { audit } from '../audit/audit';
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  revokeAllForUser,
  revokeFamily,
  startSession,
  publicUser,
  type UserRow,
} from './session';

const MINUTE = 60 * 1000;
const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email, username or password');

export function authRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();

  router.post('/login', limiter(env, { windowMs: MINUTE, limit: 10 }), async (req, res) => {
    const body = loginRequestSchema.parse(req.body);

    // An email has an @; a username (a patient's) never does.
    const user = (await db('users').modify((qb) => {
      if (body.identifier.includes('@')) qb.whereRaw('lower(email) = ?', [body.identifier]);
      else qb.where({ username: body.identifier });
    }).first()) as UserRow | undefined;
    const usable = Boolean(user && user.is_active);
    const locked = Boolean(user?.locked_until && user.locked_until > sqlNow());

    // Always run one bcrypt comparison so timing doesn't reveal whether the account exists.
    const hash = user && usable && !locked ? user.password : await dummyHash(env.BCRYPT_COST);
    const passwordOk = await verifyPassword(body.password, hash);

    if (!user || !usable || locked || !passwordOk) {
      if (user && usable && !locked) {
        await db('users').where({ id: user.id }).increment('failed_logins', 1);
        const fresh = await db('users').where({ id: user.id }).first('failed_logins');
        if (fresh.failed_logins >= env.MAX_FAILED_LOGINS) {
          await db('users')
            .where({ id: user.id })
            .update({ failed_logins: 0, locked_until: sqlFuture(env.LOCKOUT_MINUTES * MINUTE) });
          await audit(ctx, req, { userId: user.id, action: 'auth.lockout' });
        }
      }
      await audit(ctx, req, {
        userId: user?.id ?? null,
        action: 'auth.login.failed',
        diff: { identifier: body.identifier, reason: !user ? 'unknown' : !usable ? 'inactive' : locked ? 'locked' : 'password' },
      });
      // Same response for every failure, including a locked account.
      throw invalidCredentials();
    }

    const update: Record<string, unknown> = { failed_logins: 0, locked_until: null, last_login_at: sqlNow() };
    // Re-hash with the current cost, e.g. hashes from the old Laravel app made with a lower one.
    if (needsRehash(user.password, env.BCRYPT_COST)) {
      update.password = await hashPassword(body.password, env.BCRYPT_COST);
    }
    await db('users').where({ id: user.id }).update(update);

    await startSession(ctx, req, res, user, { remember: body.remember });
    await audit(ctx, req, { userId: user.id, action: 'auth.login.success' });
    res.json({ user: await publicUser(ctx, { ...user, last_login_at: update.last_login_at as string }) });
  });

  router.post('/refresh', limiter(env, { windowMs: MINUTE, limit: 60 }), async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (typeof raw !== 'string' || !raw) throw unauthorized();

    const token = await db('refresh_tokens').where({ token_hash: sha256(raw) }).first();
    const reject = () => {
      clearSessionCookies(ctx, res);
      return unauthorized('Session expired');
    };
    if (!token) throw reject();

    // A revoked token being presented again means it was copied: kill the whole family.
    if (token.revoked_at) {
      await revokeFamily(ctx, token.family_id);
      await audit(ctx, req, { userId: token.user_id, action: 'auth.refresh.reuse', entity: 'refresh_token', entityId: token.id });
      throw reject();
    }
    if (token.expires_at <= sqlNow()) throw reject();

    const user = (await db('users').where({ id: token.user_id }).first()) as UserRow | undefined;
    if (!user || !user.is_active) throw reject();

    // Claim the token atomically; if another request got there first, treat it as reuse.
    const claimed = await db('refresh_tokens').where({ id: token.id }).whereNull('revoked_at').update({ revoked_at: sqlNow() });
    if (!claimed) {
      await revokeFamily(ctx, token.family_id);
      throw reject();
    }
    const { refreshTokenId } = await startSession(ctx, req, res, user, {
      remember: Boolean(token.remember),
      familyId: token.family_id,
    });
    await db('refresh_tokens').where({ id: token.id }).update({ replaced_by: refreshTokenId });
    res.json({ user: await publicUser(ctx, user) });
  });

  router.post('/logout', async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (typeof raw === 'string' && raw) {
      const token = await db('refresh_tokens').where({ token_hash: sha256(raw) }).first();
      if (token) {
        await revokeFamily(ctx, token.family_id);
        await audit(ctx, req, { userId: token.user_id, action: 'auth.logout' });
      }
    }
    clearSessionCookies(ctx, res);
    res.status(204).end();
  });

  router.get('/me', requireAuth(ctx, { allowPasswordChange: true }), async (req, res) => {
    const user = requireUser(req);
    const row = await db('users').where({ id: user.id }).first();
    res.json({ user: await publicUser(ctx, row) });
  });

  router.post(
    '/change-password',
    limiter(env, { windowMs: 15 * MINUTE, limit: 10 }),
    requireAuth(ctx, { allowPasswordChange: true }),
    async (req, res) => {
      const user = requireUser(req);
      const body = changePasswordSchema.parse(req.body);

      const row = (await db('users').where({ id: user.id }).first()) as UserRow;
      if (!(await verifyPassword(body.currentPassword, row.password))) {
        throw new HttpError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
      }
      if (body.currentPassword === body.newPassword) {
        throw badRequest('PASSWORD_UNCHANGED', 'New password must be different from the current one');
      }
      const problem = passwordProblem(body.newPassword, { email: user.email });
      if (problem) throw badRequest('WEAK_PASSWORD', problem);

      await db('users')
        .where({ id: user.id })
        .update({ password: await hashPassword(body.newPassword, env.BCRYPT_COST), change_password: false, updated_at: sqlNow() });

      // Sign out every other device, then continue with a fresh session here.
      await revokeAllForUser(ctx, user.id);
      await startSession(ctx, req, res, row, { remember: false });
      await audit(ctx, req, { userId: user.id, action: 'auth.password.change' });
      res.json({ user: await publicUser(ctx, { ...row, change_password: false }) });
    },
  );

  router.post('/reset-password', limiter(env, { windowMs: 15 * MINUTE, limit: 10 }), async (req, res) => {
    const body = resetPasswordSchema.parse(req.body);
    const invalid = () => badRequest('INVALID_TOKEN', 'This reset link is invalid or has expired');

    const token = await db('password_reset_tokens').where({ token_hash: sha256(body.token) }).first();
    if (!token || token.used_at || token.expires_at <= sqlNow()) throw invalid();
    const user = (await db('users').where({ id: token.user_id }).first()) as UserRow | undefined;
    if (!user || !user.is_active) throw invalid();

    const problem = passwordProblem(body.password, { email: user.email });
    if (problem) throw badRequest('WEAK_PASSWORD', problem);

    const password = await hashPassword(body.password, env.BCRYPT_COST);
    const used = await db('password_reset_tokens').where({ id: token.id }).whereNull('used_at').update({ used_at: sqlNow() });
    if (!used) throw invalid(); // lost a race with another use of the same link

    await db('users')
      .where({ id: user.id })
      .update({ password, change_password: false, failed_logins: 0, locked_until: null, updated_at: sqlNow() });
    await revokeAllForUser(ctx, user.id);
    await audit(ctx, req, { userId: user.id, action: 'auth.password.reset.complete' });
    res.json({ message: 'Password updated. You can now sign in.' });
  });

  return router;
}
