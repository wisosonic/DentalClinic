import jwt from 'jsonwebtoken';
import type { Role } from '@aya/shared';
import type { Env } from '../config/env';

export interface AccessClaims {
  sub: number;
  role: Role;
}

export function signAccessToken(env: Env, claims: AccessClaims): string {
  return jwt.sign({ role: claims.role }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(claims.sub),
    expiresIn: env.ACCESS_TTL_MIN * 60,
  });
}

export function verifyAccessToken(env: Env, token: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) return null;
    return { sub: Number(payload.sub), role: payload.role as Role };
  } catch {
    return null;
  }
}
