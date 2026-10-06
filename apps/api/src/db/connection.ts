import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import knex, { type Knex } from 'knex';
import type { Env } from '../config/env';

export type Db = Knex;

export function createDb(env: Env): Db {
  if (env.DB_CLIENT === 'mysql') {
    return knex({
      client: 'mysql2',
      connection: {
        host: env.DB_HOST,
        port: env.DB_PORT,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
        charset: 'utf8mb4',
        // Return DATE/DATETIME as 'YYYY-MM-DD' strings, like SQLite does.
        dateStrings: true,
        timezone: 'Z',
      },
      pool: { min: 0, max: 10 },
    });
  }

  const inMemory = env.DB_FILENAME === ':memory:';
  const filename = inMemory ? ':memory:' : resolve(env.DB_FILENAME);
  if (!inMemory) mkdirSync(dirname(filename), { recursive: true });

  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    // One connection: an in-memory database exists per connection, and a single writer
    // avoids SQLITE_BUSY between concurrent transactions. Fine for development.
    pool: {
      min: 1,
      max: 1,
      afterCreate: (conn: { pragma: (s: string) => void }, done: (err?: Error) => void) => {
        try {
          conn.pragma('foreign_keys = ON');
          if (!inMemory) conn.pragma('journal_mode = WAL');
          done();
        } catch (err) {
          done(err as Error);
        }
      },
    },
  });
}

/** 'YYYY-MM-DD HH:MM:SS' in UTC: the same text format in SQLite and MySQL. */
export function sqlNow(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function sqlFuture(ms: number): string {
  return sqlNow(new Date(Date.now() + ms));
}
