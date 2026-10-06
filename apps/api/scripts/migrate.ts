import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db/connection';
import { migrateLatest } from '../src/db/migrate';

const env = loadEnv();
const db = createDb(env);
try {
  const applied = await migrateLatest(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} finally {
  await db.destroy();
}
