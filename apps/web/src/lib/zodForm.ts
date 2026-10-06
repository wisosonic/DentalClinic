import type { ZodTypeAny } from 'zod';
import { translate } from '../i18n';

export type FieldErrors = Record<string, string>;

/** Validates form state with a shared schema and returns per-field messages (first issue per field). */
export function validate<T extends ZodTypeAny>(
  schema: T,
  value: unknown,
): { data: T['_output']; errors?: undefined } | { data?: undefined; errors: FieldErrors } {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) errors[issue.path.join('.') || '_'] ??= translate(issue.message);
  return { errors };
}
