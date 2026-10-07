import type { Knex } from 'knex';
import * as m001 from './migrations/001_initial_schema';
import * as m002 from './migrations/002_document_patient_visibility';
import * as m003 from './migrations/003_patient_usernames';
import * as m004 from './migrations/004_waiting_room';

type Migration = { up(k: Knex): Promise<void>; down(k: Knex): Promise<void> };

// Explicit list instead of directory scanning: no TypeScript loader needed at runtime.
// The project is deployed from zero (owner decision 2026-10-07), so the schema is one migration. From here on,
// every change is a new numbered file added to this list; never edit one that has been applied anywhere.
const migrations: Record<string, Migration> = {
  '001_initial_schema': m001,
  '002_document_patient_visibility': m002,
  '003_patient_usernames': m003,
  '004_waiting_room': m004,
};

export const migrationNames = Object.keys(migrations).sort();

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
