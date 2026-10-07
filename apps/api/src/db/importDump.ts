import type { Db } from './connection';
import { applyOfferDefaults } from './offerDefaults';
import { applyOwnershipDefaults } from './ownershipDefaults';

export type Scalar = string | number | null;
export interface ParsedTable {
  columns: string[];
  rows: Scalar[][];
}

/** Extracts every `INSERT INTO ... VALUES (...)` statement from a MySQL/MariaDB dump. */
export function parseDump(sql: string): Record<string, ParsedTable> {
  const tables: Record<string, ParsedTable> = {};
  const header = /INSERT INTO `([^`]+)` \(([^)]*)\) VALUES\s*/g;
  let match: RegExpExecArray | null;

  while ((match = header.exec(sql))) {
    const table = match[1]!;
    const columns = match[2]!.split(',').map((c) => c.trim().replace(/^`|`$/g, ''));
    const { rows, end } = parseTuples(sql, header.lastIndex);
    const target = (tables[table] ??= { columns, rows: [] });
    target.rows.push(...rows);
    header.lastIndex = end;
  }
  return tables;
}

function parseTuples(sql: string, start: number): { rows: Scalar[][]; end: number } {
  const rows: Scalar[][] = [];
  let i = start;
  const n = sql.length;

  for (;;) {
    while (i < n && /\s/.test(sql[i]!)) i++;
    if (sql[i] !== '(') throw new Error(`Expected "(" at offset ${i}`);
    i++;
    const row: Scalar[] = [];

    for (;;) {
      while (i < n && /\s/.test(sql[i]!)) i++;
      const ch = sql[i]!;
      if (ch === "'") {
        const parsed = readString(sql, i);
        row.push(parsed.value);
        i = parsed.end;
      } else {
        let j = i;
        while (j < n && sql[j] !== ',' && sql[j] !== ')') j++;
        const token = sql.slice(i, j).trim();
        row.push(token.toUpperCase() === 'NULL' ? null : Number(token));
        if (token.toUpperCase() !== 'NULL' && Number.isNaN(row[row.length - 1])) {
          throw new Error(`Cannot parse value "${token}" at offset ${i}`);
        }
        i = j;
      }
      while (i < n && /\s/.test(sql[i]!)) i++;
      if (sql[i] === ',') {
        i++;
        continue;
      }
      if (sql[i] === ')') {
        i++;
        break;
      }
      throw new Error(`Unexpected "${sql[i]}" at offset ${i}`);
    }
    rows.push(row);

    while (i < n && /\s/.test(sql[i]!)) i++;
    if (sql[i] === ',') {
      i++;
      continue;
    }
    if (sql[i] === ';') return { rows, end: i + 1 };
    throw new Error(`Expected "," or ";" after row at offset ${i}`);
  }
}

const ESCAPES: Record<string, string> = {
  n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\x1a', '\\': '\\', "'": "'", '"': '"',
};

function readString(sql: string, start: number): { value: string; end: number } {
  let out = '';
  let i = start + 1;
  for (;;) {
    if (i >= sql.length) throw new Error(`Unterminated string starting at offset ${start}`);
    const ch = sql[i]!;
    if (ch === '\\') {
      const next = sql[i + 1]!;
      out += ESCAPES[next] ?? next;
      i += 2;
    } else if (ch === "'") {
      if (sql[i + 1] === "'") {
        out += "'";
        i += 2;
      } else {
        return { value: out, end: i + 1 };
      }
    } else {
      out += ch;
      i++;
    }
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

type Kind = 'money' | 'date' | 'datetime' | 'time' | 'bool' | 'lower';
interface TableSpec {
  rename?: Record<string, string>;
  /** Column kinds, keyed by the NEW column name. */
  kinds?: Record<string, Kind>;
  /** The table's name in the dump, when it differs from ours (the old app called treatment offers `quotes`). */
  source?: string;
  /** Source columns that are not carried over. */
  drop?: string[];
  /** Columns that may be NULL after conversion. Others abort the import when unparseable. */
  nullable?: string[];
}

/** Dependency order: parents before children. Tables not listed here are not imported. */
const IMPORT_ORDER: Record<string, TableSpec> = {
  users: { kinds: { change_password: 'bool' }, drop: ['remember_token'] },
  roles: {},
  role_user: {},
  doctors: { kinds: { gender: 'lower' }, nullable: ['gender'] },
  clinics: {},
  clinic_doctor: { kinds: { dr_part: 'money' } },
  patients: {
    kinds: { date_of_birth: 'date', last_visit: 'datetime', gender: 'lower' },
    nullable: ['date_of_birth', 'last_visit', 'gender'],
  },
  categories: { kinds: { price_min: 'money', price_max: 'money' } },
  teeth: {},
  promotions: {},
  events: {},
  event_patient: {},
  treatment_offers: { source: 'quotes', kinds: { cost: 'money', price: 'money' } },
  appointments: { rename: { quote_id: 'offer_id' }, kinds: { date: 'date', time: 'time' } },
  appointment_category: {},
  appointment_tooth: {},
  payments: {
    rename: { ammount: 'amount', quote_id: 'offer_id' },
    kinds: { date: 'date', amount: 'money', remaining: 'money', dr_part: 'money' },
    nullable: ['remaining', 'dr_part'],
  },
  expenses: { rename: { ammount: 'amount' }, kinds: { date: 'date', amount: 'money' } },
  labs: {},
  suppliers: {},
  medications: {},
  reports: {},
  report_tooth: { kinds: { date: 'date' } },
  medication_report: {},
  notifications: {},
  numbering: {},
  settings: {},
};

export const IMPORT_TABLES = Object.keys(IMPORT_ORDER);

/** Parses a money string into integer cents, or null if it is not a plain number. */
export function toCents(raw: Scalar): number | null {
  if (raw === null) return null;
  const text = String(raw).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2)) + (Number(frac[2] ?? 0) >= 5 ? 1 : 0);
  return negative ? -cents : cents;
}

const pad = (n: number) => String(n).padStart(2, '0');

function convert(kind: Kind, raw: Scalar): Scalar | undefined {
  // `undefined` means "could not parse".
  if (raw === null || raw === '') return null;
  const text = String(raw).trim();
  switch (kind) {
    case 'money': {
      const cents = toCents(text);
      return cents === null ? undefined : cents / 100;
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
      if (!m) return undefined;
      const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
      return d.getUTCMonth() === +m[2]! - 1 ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
    }
    case 'datetime': {
      const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
      if (m) return `${m[1]} ${m[2]}:${m[3]}:${m[4] ?? '00'}`;
      const d = convert('date', text);
      return typeof d === 'string' ? `${d} 00:00:00` : undefined;
    }
    case 'time': {
      const m = /^(\d{1,2}):(\d{2})/.exec(text);
      return m && +m[1]! < 24 && +m[2]! < 60 ? `${pad(+m[1]!)}:${m[2]}` : undefined;
    }
    case 'lower':
      return text.toLowerCase();
    case 'bool':
      return text === '1' || text.toLowerCase() === 'true' ? 1 : 0;
  }
}

export interface ImportReport {
  tables: Record<string, { parsed: number; imported: number; skippedColumns: string[] }>;
  /** Raw (text) sum in cents versus what the database holds, per money column. */
  moneySums: { column: string; rawCents: number; dbCents: number; ok: boolean }[];
  issues: string[];
  ok: boolean;
}

export class ImportError extends Error {
  constructor(public issues: string[]) {
    super(`Import aborted, ${issues.length} problem(s):\n  ${issues.slice(0, 20).join('\n  ')}`);
  }
}

export async function importDump(db: Db, sql: string): Promise<ImportReport> {
  const parsed = parseDump(sql);
  const report: ImportReport = { tables: {}, moneySums: [], issues: [], ok: true };

  // Convert everything first, so a bad value aborts before anything is written.
  const prepared: Record<string, Record<string, Scalar>[]> = {};
  const rawCents: Record<string, number> = {};
  const issues: string[] = [];

  for (const [table, spec] of Object.entries(IMPORT_ORDER)) {
    const source = parsed[spec.source ?? table];
    if (!source) continue;
    const existing = Object.keys(await db(table).columnInfo());
    const rename = spec.rename ?? {};
    const mapped = source.columns.map((c) => rename[c] ?? c);
    const keep = mapped.map((c) => existing.includes(c) && !(spec.drop ?? []).includes(c));
    const skipped = source.columns.filter((_, idx) => !keep[idx]);
    const idIdx = mapped.indexOf('id');

    prepared[table] = source.rows.map((row) => {
      const out: Record<string, Scalar> = {};
      row.forEach((value, idx) => {
        if (!keep[idx]) return;
        const column = mapped[idx]!;
        const kind = spec.kinds?.[column];
        let next: Scalar = value;
        if (kind) {
          const converted = convert(kind, value);
          const allowNull = (spec.nullable ?? []).includes(column);
          if (converted === undefined || (converted === null && !allowNull && value !== null)) {
            issues.push(`${table}#${idIdx >= 0 ? row[idIdx] : '?'}.${column}: cannot parse ${JSON.stringify(value)} as ${kind}`);
            next = null;
          } else {
            next = converted;
          }
          if (kind === 'money') {
            const key = `${table}.${column}`;
            rawCents[key] = (rawCents[key] ?? 0) + (toCents(value) ?? 0);
          }
        }
        out[column] = next;
      });
      return out;
    });
    report.tables[table] = { parsed: source.rows.length, imported: 0, skippedColumns: skipped };
  }
  if (issues.length) throw new ImportError(issues);

  await db.transaction(async (trx) => {
    for (const table of IMPORT_TABLES) {
      const rows = prepared[table];
      if (!rows?.length) continue;
      try {
        await trx.batchInsert(table, rows, 40);
      } catch (err) {
        throw new Error(`Importing "${table}" failed: ${(err as Error).message}`, { cause: err });
      }
      report.tables[table]!.imported = rows.length;
    }
  });

  // Doctors' kinds, dental units and appointment units don't exist in the dump.
  await applyOwnershipDefaults(db);
  // Quotes become treatment offers with one item each.
  await applyOfferDefaults(db);

  for (const [key, raw] of Object.entries(rawCents)) {
    const [table, column] = key.split('.') as [string, string];
    const row = await db(table).sum({ total: db.raw('ROUND(?? * 100)', [column]) }).first();
    const dbCents = Math.round(Number((row as { total: number | string | null }).total ?? 0));
    report.moneySums.push({ column: key, rawCents: raw, dbCents, ok: raw === dbCents });
  }
  report.ok = report.moneySums.every((m) => m.ok) &&
    Object.values(report.tables).every((t) => t.parsed === t.imported);
  return report;
}
