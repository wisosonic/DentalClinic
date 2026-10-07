import type { Db } from '../db/connection';

/** Longest username (the column is 40 characters; room is left for a number on the end). */
export const USERNAME_MAX = 40;

/** The email an internal patient login carries: the reserved `.invalid` domain can never receive mail. */
export const PATIENT_EMAIL_DOMAIN = 'patients.invalid';
export const patientLoginEmail = (username: string): string => `${username}@${PATIENT_EMAIL_DOMAIN}`;

const plain = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * `firstname.lastname` in plain lowercase letters and digits (accents removed, spaces and punctuation dropped), for
 * example "Hicham Cheaib" gives `hicham.cheaib` and "Élie Abi Nader" gives `elie.abinader`. A name with no Latin
 * letters (Arabic script) falls back to `patient` plus the patient's number.
 */
export function usernameBase(fname: string, lname: string, fallbackNumber: string | number): string {
  const first = plain(fname.trim().split(/\s+/)[0] ?? '');
  const last = plain(lname);
  const base = first && last ? `${first}.${last}` : first || last || `patient${plain(String(fallbackNumber))}`;
  return base.slice(0, USERNAME_MAX - 4);
}

/**
 * A username nobody has: `base`, then `base2`, `base3`... Checked against the patients' reserved usernames and every
 * login, in lowercase. The database's unique indexes are the final word (a concurrent registration retries).
 */
export async function uniqueUsername(db: Db, base: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? base : `${base}${n}`;
    const taken = (await db('patients').where({ username: candidate }).first('id')) || (await db('users').where({ username: candidate }).first('id'));
    if (!taken) return candidate;
  }
  throw new Error('Could not find a free username');
}
