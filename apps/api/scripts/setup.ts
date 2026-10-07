import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db/connection';
import { migrateLatest } from '../src/db/migrate';
import { createFirstAdmin, seedTeeth } from '../src/db/setup';

// Usage: npm run db:setup -- --admin-name "Dr Name" --admin-email name@clinic.example [--admin-password ...]
// Creates the schema, adds the 32 teeth and, on an empty installation, the first administrator (a random temporary
// password is printed once when none is given; it must be changed at the first sign-in). Safe to run again.
const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = loadEnv();
const db = createDb(env);
try {
  const applied = await migrateLatest(db);
  console.log(applied.length ? `Schema created: ${applied.join(', ')}` : 'Schema is up to date.');
  console.log(`Teeth added: ${await seedTeeth(db)}`);

  const email = arg('admin-email');
  const name = arg('admin-name');
  if (email && name) {
    const admin = await createFirstAdmin(db, { name, email, password: arg('admin-password') }, env.BCRYPT_COST);
    if (!admin.created) console.log('The clinic already has users: no administrator was created.');
    else {
      console.log(`Administrator created: ${email}`);
      if (admin.password) console.log(`Temporary password (shown once, change it at first sign-in): ${admin.password}`);
    }
  } else if (!(await db('users').first('id'))) {
    console.log('No users yet: run again with --admin-name and --admin-email to create the first administrator.');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
