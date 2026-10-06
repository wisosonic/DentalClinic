import type { Request, RequestHandler } from 'express';
import type { Role } from '@aya/shared';
import type { AppContext } from '../context';
import { forbidden, unauthorized, HttpError } from '../lib/errors';
import { can, type Permission } from '../lib/permissions';
import { verifyAccessToken } from '../lib/tokens';

export const ACCESS_COOKIE = 'access_token';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * Authenticates the request. The user row is loaded on every request so that
 * deactivating an account or changing its role takes effect immediately, not when the
 * 15-minute access token expires.
 *
 * Accounts flagged `change_password` are limited to the password-change endpoints.
 */
export const requireAuth =
  (ctx: AppContext, opts: { allowPasswordChange?: boolean } = {}): RequestHandler =>
  async (req, _res, next) => {
    const token = req.cookies?.[ACCESS_COOKIE];
    const claims = typeof token === 'string' ? verifyAccessToken(ctx.env, token) : null;
    if (!claims) return next(unauthorized());

    const row = await ctx.db('users').where({ id: claims.sub }).first();
    if (!row || !row.is_active) return next(unauthorized());

    req.user = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      mustChangePassword: Boolean(row.change_password),
    };
    if (req.user.mustChangePassword && !opts.allowPasswordChange) {
      return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password first'));
    }
    next();
  };

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user.role, permission)) return next(forbidden());
    next();
  };

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
