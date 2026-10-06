import type { Logger } from 'pino';
import type { Env } from './config/env';
import type { Db } from './db/connection';

export interface AppContext {
  db: Db;
  env: Env;
  logger: Logger;
  /** Injectable so tests can fix "now". */
  clock: () => Date;
}
