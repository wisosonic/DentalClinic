import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

const base = { JWT_SECRET: 'a-real-looking-secret-with-enough-length-1234' };

describe('parseEnv', () => {
  it('applies safe defaults', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({ DB_CLIENT: 'sqlite', BCRYPT_COST: 12, COOKIE_SECURE: false, RATE_LIMIT_ENABLED: true });
  });

  it('turns on secure cookies in production', () => {
    expect(parseEnv({ ...base, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
  });

  it('rejects a short JWT secret', () => {
    expect(() => parseEnv({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('refuses the placeholder secret from .env.example in production only', () => {
    const placeholder = { JWT_SECRET: 'change-me-to-a-long-random-string-of-at-least-32-chars' };
    expect(() => parseEnv({ ...placeholder, NODE_ENV: 'production' })).toThrow(/placeholder/);
    expect(() => parseEnv({ ...placeholder, NODE_ENV: 'development' })).not.toThrow();
  });

  it('rejects an unknown database client', () => {
    expect(() => parseEnv({ ...base, DB_CLIENT: 'postgres' })).toThrow(/DB_CLIENT/);
  });
});
