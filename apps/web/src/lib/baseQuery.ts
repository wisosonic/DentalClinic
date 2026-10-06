import { fetchBaseQuery, type BaseQueryFn, type FetchArgs, type FetchBaseQueryError } from '@reduxjs/toolkit/query/react';
import { sessionExpired } from '../features/auth/authSlice';
import { translate } from '../i18n';
import { OFFER_STATUS_LABEL } from '../features/offers/labels';
import { statusLabel } from './format';

const CSRF_COOKIE = 'csrf_token';

export function readCookie(name: string): string | undefined {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

const rawBaseQuery = fetchBaseQuery({
  // Absolute (same origin) so it also resolves under jsdom, where Request rejects relative URLs.
  baseUrl: `${window.location.origin}/api/v1`,
  credentials: 'same-origin',
  prepareHeaders: (headers) => {
    // Echo the CSRF cookie in a header; the server compares the two (double-submit).
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set('x-csrf-token', csrf);
    return headers;
  },
});

// These must not trigger a refresh: a 401 there is a real answer, not an expired token.
const NO_REFRESH = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/reset-password'];
const urlOf = (args: string | FetchArgs) => (typeof args === 'string' ? args : args.url);

// One refresh at a time. Refresh tokens rotate, so two parallel refreshes would make the
// server treat the second as token reuse and end the session.
let refreshing: Promise<boolean> | null = null;

export const baseQueryWithReauth: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args,
  api,
  extra,
) => {
  let result = await rawBaseQuery(args, api, extra);
  if (result.error?.status !== 401 || NO_REFRESH.includes(urlOf(args))) return result;

  refreshing ??= (async () => {
    const res = await rawBaseQuery({ url: '/auth/refresh', method: 'POST' }, api, extra);
    return !res.error;
  })().finally(() => {
    refreshing = null;
  });

  if (await refreshing) {
    result = await rawBaseQuery(args, api, extra);
  } else {
    api.dispatch(sessionExpired());
  }
  return result;
};

const VERBS: Record<string, string> = {
  confirm: 'confirmed', cancel: 'cancelled', complete: 'completed', 'no-show': 'marked as a no-show',
};

/**
 * A few server messages contain a time, a status or a number. The server sends those parts in
 * `details`, and the sentence is built here in the user's language.
 */
function dynamicMessage(code: string | undefined, d: Record<string, unknown> | undefined): string | null {
  if (!d) return null;
  const status = typeof d.status === 'string' ? statusLabel(d.status as never).toLowerCase() : '';
  switch (code) {
    case 'DOCTOR_BUSY':
      return translate('The doctor already has an appointment from {{start}} to {{end}}', { start: d.start, end: d.end });
    case 'UNIT_BUSY':
      return translate('The dental unit is already in use from {{start}} to {{end}}', { start: d.start, end: d.end });
    case 'TOO_LATE_TO_CANCEL':
      return translate('Appointments can only be cancelled online at least {{hours}} hours ahead. Please call the clinic.', { hours: d.hours });
    case 'NOT_EDITABLE':
      return status ? translate("A {{status}} appointment can't be changed", { status }) : null;
    case 'NOT_TREATED':
      return status ? translate('A {{status}} appointment has no visit to report on', { status }) : null;
    case 'INVALID_TRANSITION':
      return status && typeof d.action === 'string'
        ? translate("A {{status}} appointment can't be {{action}}", { status, action: translate(VERBS[d.action] ?? d.action) })
        : null;
    case 'INVALID_OFFER_TRANSITION': {
      const offerStatus = typeof d.status === 'string' ? OFFER_STATUS_LABEL[d.status as keyof typeof OFFER_STATUS_LABEL] : undefined;
      const verb = { send: 'sent', accept: 'accepted', reject: 'rejected', expire: 'marked as expired', cancel: 'cancelled' }[String(d.action)];
      return offerStatus && verb ? translate('A {{status}} offer cannot be {{action}}', { status: translate(offerStatus).toLowerCase(), action: translate(verb) }) : null;
    }
    default:
      return null;
  }
}

/** Pulls a readable message out of the API's `{ error: { message, details } }` shape, in the current language. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = error as { status?: unknown; data?: { error?: { code?: string; message?: string; details?: unknown } } };
  if (e?.status === 'FETCH_ERROR') return translate('Cannot reach the server. Check your connection.');
  const apiError = e?.data?.error;
  if (!apiError) return translate(fallback);

  const details = apiError.details;
  const built = dynamicMessage(apiError.code, Array.isArray(details) ? undefined : (details as Record<string, unknown> | undefined));
  if (built) return built;

  const message = translate(apiError.message ?? fallback);
  const first = Array.isArray(details) ? (details[0] as { message?: string } | undefined)?.message : undefined;
  return first ? `${message}: ${translate(first)}` : message;
}

export function errorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: { code?: string } } })?.data?.error?.code;
}
