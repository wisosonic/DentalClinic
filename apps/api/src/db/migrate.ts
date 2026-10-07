import type { Knex } from 'knex';
import * as m001 from './migrations/001_initial_schema';

type Migration = { up(k: Knex): Promise<void>; down(k: Knex): Promise<void> };

// Explicit list instead of directory scanning: no TypeScript loader needed at runtime.
// The project is deployed from zero (owner decision 2026-10-07), so the schema is one migration. From here on,
// every change is a new numbered file added to this list; never edit one that has been applied anywhere.
const migrations: Record<string, Migration> = {
  '001_initial_schema': m001,
};

const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations).sort(),
  getMigrationName: (name) => name,
  getMigration: async (name) => migrations[name]!,
};

export const migrationConfig = { migrationSource, tableName: 'knex_migrations' };

export async function migrateLatest(db: Knex): Promise<string[]> {
  const [, applied] = await db.migrate.latest(migrationConfig);
  return applied as string[];
}
