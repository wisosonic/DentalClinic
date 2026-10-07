import { z } from 'zod';
import { emailSchema } from './common';

export { emailSchema };

export const ROLES = ['admin', 'doctor', 'staff', 'patient'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES = ['admin', 'doctor', 'staff'] as const;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789', '1234567890', '12345678910',
  'qwertyuiop', 'qwerty123', 'iloveyou12', 'admin12345', 'welcome123', 'letmein123',
  'azertyuiop', 'abc1234567', 'clinic1234', 'dentist123',
]);

export const PASSWORD_MIN_LENGTH = 10;

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(password: string, context: { email?: string } = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > 128) return 'Password must be at most 128 characters';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Password is too common';
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character';
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Password must not contain your email name';
  return null;
}


export const passwordSchema = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
});

/** What a person types to sign in: their email, or the username of a patient login. */
export const loginNameSchema = z.string().trim().toLowerCase().min(1).max(255);

export const loginSchema = z.object({
  identifier: loginNameSchema,
  password: z.string().min(1).max(128),
  remember: z.boolean().optional().default(false),
});

/** What the server accepts: the same, with `email` still understood as the old name of `identifier`. */
export const loginRequestSchema = z.preprocess((v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.identifier === undefined && o.email !== undefined) return { ...o, identifier: o.email };
  }
  return v;
}, loginSchema);
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export interface PublicUser {
  id: number;
  name: string;
  email: string;
  /** The patient login's username (also what a patient signs in with); null for everyone else. */
  username: string | null;
  role: Role;
  mustChangePassword: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  /**
   * For a doctor login: the linked doctor profile and its kind, or null when the login is not
   * linked to one yet (such a login sees nothing). Absent for other roles.
   */
  doctor?: { id: number; kind: 'owner' | 'external' } | null;
  /** What this role may do now ("module:action"), so the screens can hide what would be refused. */
  permissions?: string[];
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
}

export * from './clinical';
export * from './visits';
export * from './finance';
export * from './plans';
export * from './offers';
export * from './documents';
export * from './tax';
export * from './settings';
export * from './roles';
