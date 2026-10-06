import bcrypt from 'bcryptjs';

export const hashPassword = (password: string, cost: number) => bcrypt.hash(password, cost);

/** Works with hashes written by PHP/Laravel (`$2y$`). */
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export function needsRehash(hash: string, cost: number): boolean {
  const m = /^\$2[abxy]\$(\d{2})\$/.exec(hash);
  return !m || Number(m[1]) < cost;
}

let dummy: Promise<string> | undefined;

/** Compared against when the account does not exist, so response time doesn't reveal it. */
export const dummyHash = (cost: number): Promise<string> => (dummy ??= bcrypt.hash('not-a-real-password', cost));
