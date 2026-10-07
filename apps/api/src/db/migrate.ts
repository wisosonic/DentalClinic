import type { Knex } from 'knex';
import * as m001 from './migrations/001_baseline';
import * as m002 from './migrations/002_auth';
import * as m003 from './migrations/003_plans_and_labs';
import * as m004 from './migrations/004_units_kinds_duration';
import * as m005 from './migrations/005_units_per_owner';
import * as m006 from './migrations/006_reports_and_doctor_login';
import * as m007 from './migrations/007_clinic_logo';
import * as m008 from './migrations/008_soft_delete';
import * as m009 from './migrations/009_money';
import * as m010 from './migrations/010_expenses_commission';
import * as m011 from './migrations/011_plans_and_lab_orders';
import * as m012 from './migrations/012_tax_settings';
import * as m013 from './migrations/013_tax_rule_sets';
import * as m014 from './migrations/014_tax_declarations';
import * as m015 from './migrations/015_app_settings';
import * as m016 from './migrations/016_tax_reopen';
import * as m017 from './migrations/017_clinic_delete_keeps_data';
import * as m018 from './migrations/018_role_permissions';
import * as m019 from './migrations/019_report_jobs';
import * as m020 from './migrations/020_treatment_offers';
import * as m021 from './migrations/021_patient_documents';
import * as m022 from './migrations/022_offer_statuses';
import * as m023 from './migrations/023_rename_quotes';
import * as m024 from './migrations/024_rename_offer_columns';

type Migration = { up(k: Knex): Promise<void>; down(k: Knex): Promise<void> };

// Explicit list instead of directory scanning: no TypeScript loader needed at runtime.
const migrations: Record<string, Migration> = {
  '001_baseline': m001,
  '002_auth': m002,
  '003_plans_and_labs': m003,
  '004_units_kinds_duration': m004,
  '005_units_per_owner': m005,
  '006_reports_and_doctor_login': m006,
  '007_clinic_logo': m007,
  '008_soft_delete': m008,
  '009_money': m009,
  '010_expenses_commission': m010,
  '011_plans_and_lab_orders': m011,
  '012_tax_settings': m012,
  '013_tax_rule_sets': m013,
  '014_tax_declarations': m014,
  '015_app_settings': m015,
  '016_tax_reopen': m016,
  '017_clinic_delete_keeps_data': m017,
  '018_role_permissions': m018,
  '019_report_jobs': m019,
  '020_treatment_offers': m020,
  '021_patient_documents': m021,
  '022_offer_statuses': m022,
  '023_rename_quotes': m023,
  '024_rename_offer_columns': m024,
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
