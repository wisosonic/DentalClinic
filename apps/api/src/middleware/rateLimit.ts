import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Env } from '../config/env';

export function limiter(env: Env, opts: { windowMs: number; limit: number; message?: string }): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: opts.message ?? 'Too many requests, please try again later' },
      });
    },
  });
}
