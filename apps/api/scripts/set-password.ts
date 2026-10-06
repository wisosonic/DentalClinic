import { passwordProblem } from '@aya/shared';
import { loadEnv } from '../src/config/env';
import { createDb, sqlNow } from '../src/db/connection';
import { generatePassword } from '../src/lib/crypto';
import { hashPassword } from '../src/lib/password';

// Usage: npm run user:set-password -- <email> [new-password]
// Without a password, a random one is generated and printed. The user must change it at next login.
const [emailArg, passwordArg] = process.argv.slice(2);
if (!emailArg) {
  console.error('Usage: npm run user:set-password -- <email> [new-password]');
  process.exit(1);
}

const env = loadEnv();
const db = createDb(env);
try {
  const user = await db('users').whereRaw('lower(email) = ?', [emailArg.toLowerCase()]).first();
  if (!user) throw new Error(`No user with email ${emailArg}`);

  const password = passwordArg ?? generatePassword();
  const problem = passwordProblem(password, { email: user.email });
  if (problem) throw new Error(problem);

  await db('users').where({ id: user.id }).update({
    password: await hashPassword(password, env.BCRYPT_COST),
    change_password: true,
    failed_logins: 0,
    locked_until: null,
    is_active: true,
    updated_at: sqlNow(),
  });
  await db('refresh_tokens').where({ user_id: user.id }).whereNull('revoked_at').update({ revoked_at: sqlNow() });
  console.log(`Password updated for ${user.email}.`);
  if (!passwordArg) console.log(`Temporary password: ${password}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
