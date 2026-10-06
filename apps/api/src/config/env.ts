import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),

  // 'sqlite' for development; set to 'mysql' (MariaDB/MySQL) later without code changes.
  DB_CLIENT: z.enum(['sqlite', 'mysql']).default('sqlite'),
  DB_FILENAME: z.string().default('./data/aya_clinic.sqlite'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('aya_clinic'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REFRESH_TTL_DAYS_REMEMBER: z.coerce.number().int().positive().default(30),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // Doctors have no fixed hours, so there are no working-day or slot settings.
  CLINIC_TIMEZONE: z.string().default('Asia/Beirut'),
  /** Patients may cancel online only at least this many hours before the appointment. */
  CANCEL_MIN_HOURS: z.coerce.number().int().min(0).max(720).default(24),

  /** Where uploaded files (clinic logos) are kept. Back this folder up with the database. */
  UPLOAD_DIR: z.string().default('./data/uploads'),

  /** Browser origins allowed to call the API directly, comma-separated. The web app's dev server proxies /api, so it needs none. */
  CORS_ORIGIN: z.string().default('http://localhost:5180'),
  APP_URL: z.string().default('http://localhost:5180'),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default('false'),
  RATE_LIMIT_ENABLED: bool.default('true'),
});

export type Env = z.infer<typeof schema> & { COOKIE_SECURE: boolean };

export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && /change-me|dev-only/i.test(env.JWT_SECRET)) {
    throw new Error('Invalid environment configuration:\n  JWT_SECRET is still a placeholder; generate a real secret');
  }
  return { ...env, COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production' };
}

export function loadEnv(): Env {
  try {
    process.loadEnvFile?.();
  } catch {
    // no .env file; rely on the real environment
  }
  return parseEnv(process.env);
}
