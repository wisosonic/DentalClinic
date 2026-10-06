import type { CookieOptions, Request, Response } from 'express';
import type { PublicUser } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlFuture, sqlNow } from '../../db/connection';
import { randomToken, sha256 } from '../../lib/crypto';
import { effectivePermissions } from '../../lib/permissions';
import { signAccessToken } from '../../lib/tokens';
import { ACCESS_COOKIE } from '../../middleware/auth';
import { CSRF_COOKIE } from '../../middleware/csrf';

export const REFRESH_COOKIE = 'refresh_token';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UserRow {
  id: number;
  name: string;
  email: string;
  role: PublicUser['role'];
  change_password: number | boolean;
  is_active: number | boolean;
  last_login_at: string | null;
  locked_until: string | null;
  password: string;
}

/** The user as the web app sees it, with the doctor profile for a doctor login. */
export async function publicUser(
  ctx: AppContext,
  row: Omit<UserRow, 'password'> & { password?: string },
): Promise<PublicUser> {
  const user = toPublicUser(row);
  if (row.role !== 'doctor') return user;
  const profile = await ctx.db('doctors').where({ user_id: row.id }).first('id', 'kind');
  return { ...user, doctor: profile ? { id: profile.id, kind: profile.kind } : null };
}

export function toPublicUser(row: Omit<UserRow, 'password'> & { password?: string }): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    mustChangePassword: Boolean(row.change_password),
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at ?? null,
    permissions: effectivePermissions(row.role),
  };
}

function cookieBase(ctx: AppContext): CookieOptions {
  return { secure: ctx.env.COOKIE_SECURE };
}

export function clearSessionCookies(ctx: AppContext, res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase(ctx), httpOnly: true, sameSite: 'lax', path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(ctx), httpOnly: true, sameSite: 'strict', path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { ...cookieBase(ctx), sameSite: 'lax', path: '/' });
}

/**
 * Starts (or continues, when `familyId` is given) a session: stores a new refresh token
 * (hash only) and sets the access, refresh and CSRF cookies.
 */
export async function startSession(
  ctx: AppContext,
  req: Request,
  res: Response,
  user: Pick<UserRow, 'id' | 'role'>,
  opts: { remember: boolean; familyId?: string },
): Promise<{ refreshTokenId: number }> {
  const { env, db } = ctx;
  const refreshToken = randomToken(32);
  const ttlMs = (opts.remember ? env.REFRESH_TTL_DAYS_REMEMBER : env.REFRESH_TTL_DAYS) * DAY_MS;

  const [inserted] = await db('refresh_tokens')
    .insert({
      user_id: user.id,
      family_id: opts.familyId ?? randomToken(16),
      token_hash: sha256(refreshToken),
      remember: opts.remember,
      expires_at: sqlFuture(ttlMs),
      user_agent: (req.get('user-agent') ?? '').slice(0, 255) || null,
      ip: req.ip ?? null,
      created_at: sqlNow(),
    });
  const refreshTokenId = inserted as number; // SQLite rowid / MySQL insertId

  const base = cookieBase(ctx);
  // "Remember me" gives persistent cookies; otherwise they vanish when the browser closes.
  const persistent = opts.remember ? { maxAge: ttlMs } : {};

  res.cookie(ACCESS_COOKIE, signAccessToken(env, { sub: user.id, role: user.role }), {
    ...base, httpOnly: true, sameSite: 'lax', path: '/api', maxAge: env.ACCESS_TTL_MIN * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base, httpOnly: true, sameSite: 'strict', path: '/api/v1/auth', ...persistent,
  });
  res.cookie(CSRF_COOKIE, randomToken(24), { ...base, httpOnly: false, sameSite: 'lax', path: '/', ...persistent });

  return { refreshTokenId };
}

export async function revokeAllForUser(ctx: AppContext, userId: number): Promise<void> {
  await ctx.db('refresh_tokens').where({ user_id: userId }).whereNull('revoked_at').update({ revoked_at: sqlNow() });
}

export async function revokeFamily(ctx: AppContext, familyId: string): Promise<void> {
  await ctx.db('refresh_tokens').where({ family_id: familyId }).whereNull('revoked_at').update({ revoked_at: sqlNow() });
}
