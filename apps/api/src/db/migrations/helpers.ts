import type { Knex } from 'knex';

export type Table = Knex.CreateTableBuilder;
type OnDelete = 'CASCADE' | 'RESTRICT' | 'SET NULL';

export function timestamps(t: Table): void {
  t.timestamp('created_at').nullable();
  t.timestamp('updated_at').nullable();
}

/** Foreign key to `<table>.id`. Same code path for SQLite and MySQL. */
export function ref(
  t: Table,
  column: string,
  table: string,
  opts: { nullable?: boolean; onDelete?: OnDelete } = {},
): void {
  const { nullable = false, onDelete = 'CASCADE' } = opts;
  const col = t.integer(column).unsigned();
  if (nullable) col.nullable();
  else col.notNullable();
  col.references('id').inTable(table).onDelete(onDelete).onUpdate('CASCADE');
  t.index([column]);
}

export const money = (t: Table, column: string) => t.decimal(column, 12, 2);
