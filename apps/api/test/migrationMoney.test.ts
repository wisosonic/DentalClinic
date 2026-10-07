import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { createDb, type Db } from '../src/db/connection';
import { migrationConfig } from '../src/db/migrate';

let db: Db | undefined;
afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

/** Money as the old app left it: the right amounts, but a stored balance that cannot be trusted. */
async function beforeMoney(): Promise<Db> {
  const conn = createDb(parseEnv({ DB_FILENAME: ':memory:', JWT_SECRET: 'x'.repeat(32) }));
  for (let i = 0; i < 8; i++) await conn.migrate.up(migrationConfig);
  const stamp = { created_at: '2025-11-01 10:00:00', updated_at: '2025-11-01 10:00:00' };
  const [aya] = await conn('doctors').insert({ fname: 'Aya', lname: 'Ghali', kind: 'owner', ...stamp });
  const [patient] = await conn('patients').insert({ patient_identifier: '1', fname: 'P', lname: 'One', phone: '1', doctor_id: aya, ...stamp });
  const [orphan] = await conn('patients').insert({ patient_identifier: '2', fname: 'P', lname: 'Two', phone: '2', ...stamp });
  const quote = async (patient_id: number, price: number, status: string) =>
    (await conn('quotes').insert({ title: 'Q', type: 'clinic', price, cost: 0, currency: '$', status, patient_id, ...stamp }))[0]!;
  const q1 = await quote(patient!, 300.1, 'pending');
  const q2 = await quote(orphan!, 100, 'paid');
  const pay = (offer_id: number | null, amount: number, date: string, remaining: number | null, type = 'clinic') =>
    conn('payments').insert({ quote_id: offer_id, amount, date, remaining, type, currency: '$', dr_part: 100, ...stamp });
  await pay(q1, 100.05, '2025-11-02', 999); // wrong balance
  await pay(q1, 50.05, '2025-11-05', null);
  await pay(q2, 100, '2025-11-03', 0);
  await pay(null, 25, '2025-11-04', null, 'commission'); // from a specialist: no quote
  return conn;
}

describe('migration 009 (money) on existing data', () => {
  it('recomputes every balance from the amounts, oldest first, to the cent', async () => {
    db = await beforeMoney();
    await db.migrate.up(migrationConfig);
    const rows = await db('payments').orderBy('id').select('amount', 'remaining', 'quote_id');
    expect(rows.map((r) => r.remaining)).toEqual([200.05, 150, 0, null]);
  });

  it('snapshots the patient’s primary doctor as the collector, and leaves the rest empty', async () => {
    db = await beforeMoney();
    await db.migrate.up(migrationConfig);
    const rows = await db('payments').orderBy('id').select('collected_by_doctor_id', 'method', 'created_by', 'type');
    expect(rows.map((r) => r.collected_by_doctor_id)).toEqual([1, 1, null, null]); // the second patient has no doctor; a commission has no quote
    expect(rows.every((r) => r.method === null && r.created_by === null)).toBe(true);
    expect(rows.map((r) => r.type)).toEqual(['clinic', 'clinic', 'clinic', 'commission']); // nothing is lost
  });

  it('loses no rows and keeps every foreign key valid', async () => {
    db = await beforeMoney();
    await db.migrate.up(migrationConfig);
    expect(Number((await db('payments').count({ n: '*' }).first())!.n)).toBe(4);
    expect(Number((await db('quotes').count({ n: '*' }).first())!.n)).toBe(2);
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('rolls back cleanly', async () => {
    db = await beforeMoney();
    await db.migrate.up(migrationConfig);
    await db.migrate.down(migrationConfig);
    const columns = Object.keys(await db('payments').columnInfo());
    for (const c of ['method', 'created_by', 'deleted_by', 'collected_by_doctor_id']) expect(columns).not.toContain(c);
    expect(Number((await db('payments').count({ n: '*' }).first())!.n)).toBe(4);
  });
});

describe('migration 010 (expenses and commission) on existing data', () => {
  async function beforeExpenses(): Promise<Db> {
    const conn = createDb(parseEnv({ DB_FILENAME: ':memory:', JWT_SECRET: 'x'.repeat(32) }));
    for (let i = 0; i < 9; i++) await conn.migrate.up(migrationConfig);
    const stamp = { created_at: '2025-11-01 10:00:00', updated_at: '2025-11-01 10:00:00' };
    for (const [type, model_id] of [['general', null], ['clinic', null], ['supplier', 2], ['commission', 5], ['personal', null]] as const) {
      await conn('expenses').insert({ date: '2025-11-26', type, amount: 18, currency: '$', model_id, ...stamp });
    }
    return conn;
  }

  it('turns the old "general" expenses into "clinic" and keeps every row and reference', async () => {
    db = await beforeExpenses();
    await db.migrate.up(migrationConfig);
    const rows = await db('expenses').orderBy('id').select('type', 'model_id', 'appointment_id', 'deleted_at');
    expect(rows.map((r) => r.type)).toEqual(['clinic', 'clinic', 'supplier', 'commission', 'personal']);
    expect(rows.map((r) => r.model_id)).toEqual([null, null, 2, 5, null]);
    expect(rows.every((r) => r.appointment_id === null && r.deleted_at === null)).toBe(true);
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('rolls back cleanly', async () => {
    db = await beforeExpenses();
    await db.migrate.up(migrationConfig);
    await db.migrate.down(migrationConfig);
    const columns = Object.keys(await db('expenses').columnInfo());
    for (const c of ['appointment_id', 'deleted_at', 'deleted_by']) expect(columns).not.toContain(c);
    expect(Number((await db('expenses').count({ n: '*' }).first())!.n)).toBe(5);
  });
});
