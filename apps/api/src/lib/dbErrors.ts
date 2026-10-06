/** True when a database error is a foreign-key violation (SQLite or MySQL). */
export function isForeignKeyError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string } | null;
  return (
    e?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    // SQLite reports ON DELETE RESTRICT violations under a different code, but the same message.
    (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT') && /FOREIGN KEY constraint failed/i.test(e.message ?? '')) ||
    e?.code === 'ER_ROW_IS_REFERENCED_2' ||
    e?.errno === 1451
  );
}

/** True when a database error is a unique-constraint violation (SQLite or MySQL). */
export function isUniqueError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null;
  return (
    e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062
  );
}
