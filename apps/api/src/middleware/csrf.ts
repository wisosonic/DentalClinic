import type { RequestHandler } from 'express';
import { forbidden } from '../lib/errors';
import { safeEqual } from '../lib/crypto';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Endpoints used before a session exists: there is nothing to forge yet.
const EXEMPT = new Set(['/auth/login', '/auth/forgot-password', '/auth/reset-password']);

/**
 * Double-submit cookie check. The SPA reads the (non-httpOnly) csrf cookie and echoes it
 * in a header; a cross-site attacker can't read the cookie, so can't set the header.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || EXEMPT.has(req.path)) return next();
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);
  if (typeof cookie !== 'string' || typeof header !== 'string' || !safeEqual(cookie, header)) {
    return next(forbidden('Missing or invalid CSRF token'));
  }
  next();
};
