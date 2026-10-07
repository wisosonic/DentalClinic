import { passwordProblem } from '@aya/shared';
import { generatePassword } from '../lib/crypto';
import { hashPassword } from '../lib/password';
import { sqlNow, type Db } from './connection';

/**
 * What a new installation needs besides the empty schema: the 32 permanent teeth (FDI numbering, 18 to 11, 21 to 28,
 * 38 to 31, 41 to 48, the order the screens expect) and a first administrator. Safe to run again: nothing that
 * exists is touched. Medical terms stay English (owner decision).
 */
const QUADRANT: Record<string, string> = { '1': 'Upper right', '2': 'Upper left', '3': 'Lower left', '4': 'Lower right' };
const POSITION: Record<string, [name: string, type: string]> = {
  '1': ['central incisor', 'Incisor'], '2': ['lateral incisor', 'Incisor'], '3': ['canine', 'Canine'],
  '4': ['first premolar', 'Premolar'], '5': ['second premolar', 'Premolar'],
  '6': ['first molar', 'Molar'], '7': ['second molar', 'Molar'], '8': ['third molar', 'Molar'],
};
const ORDER = ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28',
  '38', '37', '36', '35', '34', '33', '32', '31', '41', '42', '43', '44', '45', '46', '47', '48'];

export const TEETH = ORDER.map((index) => {
  const [name, type] = POSITION[index[1]!]!;
  return { index, name: `${QUADRANT[index[0]!]} ${name}`, type };
});

/** Adds the teeth that are missing. Returns how many were added. */
export async function seedTeeth(db: Db): Promise<number> {
  const have = new Set((await db('teeth').select('index')).map((t: { index: string }) => t.index));
  const now = sqlNow();
  const missing = TEETH.filter((t) => !have.has(t.index));
  for (const t of missing) await db('teeth').insert({ ...t, created_at: now, updated_at: now });
  return missing.length;
}

export interface FirstAdmin { name: string; email: string; password?: string }

/**
 * Creates the first administrator, who must change the password at the first sign-in. Does nothing when the
 * clinic already has any user. Without a password a random one is made and returned (shown once, never stored).
 */
export async function createFirstAdmin(db: Db, input: FirstAdmin, bcryptCost: number): Promise<{ created: boolean; password?: string }> {
  if (await db('users').first('id')) return { created: false };
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address for the administrator');
  if (!input.name.trim()) throw new Error('Enter the administrator’s name');
  const password = input.password ?? generatePassword();
  const problem = passwordProblem(password, { email });
  if (problem) throw new Error(problem);
  const now = sqlNow();
  await db('users').insert({
    name: input.name.trim(), email, password: await hashPassword(password, bcryptCost), role: 'admin',
    change_password: true, is_active: true, created_at: now, updated_at: now,
  });
  return { created: true, ...(input.password ? {} : { password }) };
}
