import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { createDb, type Db } from '../src/db/connection';
import { migrationConfig } from '../src/db/migrate';

let db: Db | undefined;
afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

/** A database as it was before migration 004: three migrations applied, with real-looking rows. */
async function legacyDb(): Promise<Db> {
  const conn = createDb(parseEnv({ DB_FILENAME: ':memory:', JWT_SECRET: 'x'.repeat(32) }));
  for (let i = 0; i < 3; i++) await conn.migrate.up(migrationConfig);

  const stamp = { created_at: '2025-11-01 10:00:00', updated_at: '2025-11-01 10:00:00' };
  const [clinic] = await conn('clinics').insert({ name: 'Aya Ghali Clinic', ...stamp });
  const [aya] = await conn('doctors').insert({ fname: 'Aya', lname: 'Ghali', ...stamp });
  const [visitor] = await conn('doctors').insert({ fname: 'Cidra', lname: 'Specialist', ...stamp });
  await conn('clinic_doctor').insert({ clinic_id: clinic, doctor_id: aya, dr_part: 100, schedule: '09 AM - 07 PM', ...stamp });
  const [patient] = await conn('patients').insert({ patient_identifier: '1', fname: 'P', lname: 'One', phone: '1', doctor_id: aya, ...stamp });
  for (const [date, time] of [['2025-11-13', '10:00'], ['2025-11-13', '21:50']]) {
    await conn('appointments').insert({ date, time, status: 'confirmed', patient_id: patient, doctor_id: aya, clinic_id: clinic, ...stamp });
  }
  const [category] = await conn('categories').insert({ name: 'Scaling', price_min: 1, price_max: 2, ...stamp });
  const [appointment] = await conn('appointments').select('id');
  await conn('appointment_category').insert({ appointment_id: appointment.id ?? appointment, category_id: category, ...stamp });
  void visitor;
  return conn;
}

/** Applies every migration up to, but not including, 020 (treatment offers), which cannot be rolled back. */
async function upToBeforeOffers(conn: Db): Promise<void> {
  const [, pending] = await conn.migrate.list(migrationConfig);
  const names = (pending as ({ file?: string; name?: string } | string)[]).map((p) => (typeof p === 'string' ? p : (p.file ?? p.name ?? '')));
  const stop = names.findIndex((n) => n.startsWith('020_treatment_offers'));
  for (let i = 0; i < stop; i++) await conn.migrate.up(migrationConfig);
}

describe('migration 004 on existing data', () => {
  it('keeps every row, including rows that depend on appointments', async () => {
    db = await legacyDb();
    const tables = ['appointments', 'appointment_category', 'patients', 'doctors', 'clinics', 'clinic_doctor', 'categories'];
    const before: Record<string, number> = {};
    for (const table of tables) before[table] = Number((await db(table).count({ n: '*' }).first())!.n);

    await db.migrate.latest(migrationConfig);

    for (const table of tables) {
      expect(Number((await db(table).count({ n: '*' }).first())!.n), table).toBe(before[table]);
    }
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('makes assigned doctors owners with a unit, and everyone else external', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);

    const doctors = await db('doctors').orderBy('id').select('fname', 'kind', 'commission_percent');
    expect(doctors).toEqual([
      { fname: 'Aya', kind: 'owner', commission_percent: null },
      { fname: 'Cidra', kind: 'external', commission_percent: null },
    ]);
    const units = await db('dental_units').select('name', 'owner_doctor_id', 'clinic_id');
    expect(units).toEqual([{ name: "Dr Aya's unit", owner_doctor_id: 1, clinic_id: 1 }]);
  });

  it('puts every existing appointment on its doctor’s unit with a 30-minute length', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);
    const rows = await db('appointments').select('unit_id', 'duration_minutes');
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { unit_id: number; duration_minutes: number }) => r.unit_id === 1 && r.duration_minutes === 30)).toBe(true);
  });

  it('drops the obsolete schedule column', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);
    expect(Object.keys(await db('clinic_doctor').columnInfo())).not.toContain('schedule');
  });

  it('protects dental units from silent cascading deletes, and lets a clinic go without taking its appointments (017)', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);
    await expect(db('dental_units').where({ id: 1 }).del()).rejects.toThrow(/FOREIGN KEY/); // appointments are on it
    await db('clinics').where({ id: 1 }).del(); // deleting a clinic keeps everything done at it
    expect(Number((await db('appointments').count({ n: '*' }).first())!.n)).toBe(2);
    expect(Number((await db('appointments').whereNull('clinic_id').count({ n: '*' }).first())!.n)).toBe(2);
    expect(Number((await db('dental_units').whereNull('clinic_id').count({ n: '*' }).first())!.n)).toBeGreaterThan(0);
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps every appointment and unit through the rebuild of migration 017, with their indexes', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);
    expect(Number((await db('appointments').count({ n: '*' }).first())!.n)).toBe(2);
    const indexes = (await db.raw("select name from sqlite_master where type = 'index' and tbl_name = 'appointments'")) as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(expect.arrayContaining(['appointments_patient_id_index', 'appointments_unit_id_date_time_index', 'appointments_deleted_at_index']));
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('lets an owner have several units after migration 005, without losing any', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);
    await db('dental_units').insert({ clinic_id: 1, owner_doctor_id: 1, name: 'Second unit' });
    expect(Number((await db('dental_units').where({ owner_doctor_id: 1 }).count({ n: '*' }).first())!.n)).toBe(2);
    expect(Number((await db('appointments').count({ n: '*' }).first())!.n)).toBe(2);
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('allows one report per appointment and one note per tooth, and links doctors to logins (006)', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);
    const [appointment] = await db('appointments').select('id');
    const appointmentId = appointment.id ?? appointment;
    const [report] = await db('reports').insert({ appointment_id: appointmentId });
    await expect(db('reports').insert({ appointment_id: appointmentId })).rejects.toThrow(/UNIQUE/);

    const [tooth] = await db('teeth').insert({ index: '18', name: 'Molar 18', type: 'Molar' });
    await db('report_tooth').insert({ report_id: report, tooth_id: tooth, date: '2025-11-13' });
    await expect(db('report_tooth').insert({ report_id: report, tooth_id: tooth, date: '2025-11-14' })).rejects.toThrow(/UNIQUE/);

    expect(Object.keys(await db('doctors').columnInfo())).toContain('user_id');
    const [user] = await db('users').insert({ name: 'D', email: 'd@x.test', password: 'x', role: 'doctor' });
    await db('doctors').where({ id: 1 }).update({ user_id: user });
    await expect(db('doctors').where({ id: 2 }).update({ user_id: user })).rejects.toThrow(/UNIQUE/); // one login, one doctor
    await db('users').where({ id: user }).del(); // deleting a login keeps the doctor
    expect((await db('doctors').where({ id: 1 }).first()).user_id).toBeNull();
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps all existing data through 006', async () => {
    db = await legacyDb();
    await db.migrate.latest(migrationConfig);
    expect(Number((await db('appointments').count({ n: '*' }).first())!.n)).toBe(2);
    expect(Number((await db('appointment_category').count({ n: '*' }).first())!.n)).toBe(1);
    expect(Number((await db('doctors').count({ n: '*' }).first())!.n)).toBe(2);
  });

  it('refuses to roll back on SQLite instead of risking the data', async () => {
    db = await legacyDb();
    await upToBeforeOffers(db); // 020 (treatment offers) cannot be rolled back, so the chain starts below it
    // 020 (treatment offers) is refused on purpose, tested below; 019 (report jobs), 018 (role permissions), 017 (clinic delete keeps data), 016 (tax reopen), 014 (tax declarations), 013 (tax rule sets), 012 (tax settings), 011 (plans and lab orders), 010 (expenses), 009 (money), 008 (soft delete) and 007 (clinic logo) roll back cleanly; the next ones (006, then 004) refuse on SQLite.
    // 019: reports made in the background
    expect(await db.schema.hasTable('report_jobs')).toBe(true);
    await db.migrate.down(migrationConfig);
    expect(await db.schema.hasTable('report_jobs')).toBe(false);
    // 018: the admin's role changes
    expect(await db.schema.hasTable('role_permissions')).toBe(true);
    await db.migrate.down(migrationConfig);
    expect(await db.schema.hasTable('role_permissions')).toBe(false);
    // 017: an appointment may have no clinic; rolling back makes the clinic required again
    expect((await db('appointments').columnInfo()).clinic_id!.nullable).toBe(true);
    expect((await db('dental_units').columnInfo()).clinic_id!.nullable).toBe(true);
    await db.migrate.down(migrationConfig);
    expect((await db('appointments').columnInfo()).clinic_id!.nullable).toBe(false);
    expect((await db('dental_units').columnInfo()).clinic_id!.nullable).toBe(false);
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
    expect(Object.keys(await db('tax_declarations').columnInfo())).toContain('active_scope');
    await db.migrate.down(migrationConfig);
    expect(Object.keys(await db('tax_declarations').columnInfo())).not.toContain('active_scope');
    expect(await db.schema.hasTable('app_settings')).toBe(true);
    await db.migrate.down(migrationConfig);
    expect(await db.schema.hasTable('app_settings')).toBe(false);
    expect(await db.schema.hasTable('tax_declarations')).toBe(true);
    await db.migrate.down(migrationConfig);
    expect(await db.schema.hasTable('tax_declarations')).toBe(false);
    expect(await db.schema.hasTable('tax_rule_sets')).toBe(true);
    expect(Object.keys(await db('doctors').columnInfo())).toContain('tax_children');
    await db.migrate.down(migrationConfig);
    expect(await db.schema.hasTable('tax_rule_sets')).toBe(false);
    expect(Object.keys(await db('doctors').columnInfo())).not.toContain('tax_children');
    expect(await db.schema.hasTable('tax_settings')).toBe(true);
    await db.migrate.down(migrationConfig);
    expect(await db.schema.hasTable('tax_settings')).toBe(false);
    expect(Object.keys(await db('treatment_plans').columnInfo())).toContain('deleted_at');
    expect(Object.keys(await db('lab_orders').columnInfo())).toContain('deleted_by');
    await db.migrate.down(migrationConfig);
    expect(Object.keys(await db('treatment_plans').columnInfo())).not.toContain('deleted_at');
    expect(Object.keys(await db('lab_orders').columnInfo())).not.toContain('deleted_by');
    await db.migrate.down(migrationConfig);
    expect(Object.keys(await db('expenses').columnInfo())).not.toContain('appointment_id');
    await db.migrate.down(migrationConfig);
    expect(Object.keys(await db('payments').columnInfo())).not.toContain('collected_by_doctor_id');
    await db.migrate.down(migrationConfig);
    expect(Object.keys(await db('appointments').columnInfo())).not.toContain('deleted_at');
    await db.migrate.down(migrationConfig);
    expect(Object.keys(await db('clinics').columnInfo())).not.toContain('logo_file');
    await expect(db.migrate.down(migrationConfig)).rejects.toThrow(/not supported on SQLite/);
    expect(Number((await db('appointments').count({ n: '*' }).first())!.n)).toBe(2);
    expect(Object.keys(await db('appointments').columnInfo())).toContain('unit_id');
  });
});

describe('migration 020: treatment plans and quotes become treatment offers', () => {
  const stamp = { created_at: '2025-11-01 10:00:00', updated_at: '2025-11-01 10:00:00' };

  /** A database just before 020, with old quotes, payments, and plans (one with a quote, one without). */
  async function beforeOffers(): Promise<Db> {
    const conn = await legacyDb();
    const patient = (await conn('patients').first('id'))!.id as number;
    const doctor = (await conn('doctors').first('id'))!.id as number;
    const quote = async (title: string, price: number, status: string, extra: object = {}) =>
      (await conn('quotes').insert({ title, type: 'clinic', price, cost: 0, currency: '$', status, patient_id: patient, ...stamp, ...extra }))[0]!;
    const pay = (quote_id: number, amount: number) => conn('payments').insert({ date: '2025-11-02', type: 'clinic', amount, remaining: 0, currency: '$', quote_id, dr_part: 100, ...stamp });
    const a = await quote('Crown', 100, 'paid');
    await pay(a, 100);
    const b = await quote('Bridge', 200, 'pending');
    await pay(b, 50);
    await quote('Whitening', 80, 'pending');
    const d = await quote('Rehabilitation', 300, 'draft');
    const p1 = (await conn('treatment_plans').insert({ patient_id: patient, doctor_id: doctor, quote_id: d, title: 'Rehabilitation', status: 'accepted', start_date: '2025-12-01', notes: 'Slowly', ...stamp }))[0]!;
    await conn('treatment_plan_items').insert([
      { plan_id: p1, description: 'Root canal', est_price: 100, sequence: 1, status: 'done', completed_at: '2025-11-10 09:00:00', ...stamp },
      { plan_id: p1, description: 'Post', est_price: 150, sequence: 2, status: 'pending', ...stamp },
    ]);
    const p2 = (await conn('treatment_plans').insert({ patient_id: patient, doctor_id: doctor, title: 'Orthodontics', status: 'proposed', ...stamp }))[0]!;
    await conn('treatment_plan_items').insert([
      { plan_id: p2, description: 'Braces', est_price: 40, sequence: 1, status: 'pending', ...stamp },
      { plan_id: p2, description: 'Retainer', est_price: 60, sequence: 2, status: 'pending', ...stamp },
    ]);
    await upToBeforeOffers(conn);
    await conn('role_permissions').insert([
      { role: 'doctor', permission: 'quotes:delete', allowed: false, ...stamp },
      { role: 'staff', permission: 'plans:update', allowed: true, ...stamp },
    ]);
    return conn;
  }

  it('turns every quote into an offer with one finished item, and keeps every payment and total', async () => {
    db = await beforeOffers();
    const before = (await db('payments').sum({ s: 'amount' }).first()) as { s: number };
    await db.migrate.up(migrationConfig);
    const offers = await db('quotes').orderBy('id');
    expect(offers).toHaveLength(5); // four quotes and the plan that had none
    const crown = offers.find((o: { title: string }) => o.title === 'Crown');
    expect(crown).toMatchObject({ price: 100, status: 'accepted' }); // paid was derived: it is accepted now
    const items = await db('offer_items').where({ offer_id: crown.id });
    expect(items).toMatchObject([{ description: 'Crown', price: 100, status: 'done', sequence: 1 }]);
    expect(await db('quotes').where({ title: 'Bridge' }).first()).toMatchObject({ status: 'accepted' }); // pending with a payment
    expect(await db('quotes').where({ title: 'Whitening' }).first()).toMatchObject({ status: 'sent' }); // pending, nothing paid
    expect(((await db('payments').sum({ s: 'amount' }).first()) as { s: number }).s).toBe(before.s);
    expect(Number((await db('payments').count({ n: '*' }).first())!.n)).toBe(2);
    expect(await db.raw('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('merges a plan into its quote, keeps the quote’s price exactly (with an adjustment item for the difference), and copies the plan’s details', async () => {
    db = await beforeOffers();
    await db.migrate.up(migrationConfig);
    const offer = await db('quotes').where({ title: 'Rehabilitation' }).first();
    expect(offer).toMatchObject({ price: 300, status: 'accepted', start_date: '2025-12-01', notes: 'Slowly' });
    expect(offer.doctor_id).toBeTruthy();
    const items = await db('offer_items').where({ offer_id: offer.id }).orderBy('sequence');
    expect(items.map((i: { description: string; price: number; status: string }) => [i.description, i.price, i.status])).toEqual([['Root canal', 100, 'done'], ['Post', 150, 'pending'], ['Price adjustment', 50, 'done']]);
  });

  it('turns a plan with no quote into a new offer priced at its items, with plan statuses mapped', async () => {
    db = await beforeOffers();
    await db.migrate.up(migrationConfig);
    const offer = await db('quotes').where({ title: 'Orthodontics' }).first();
    expect(offer).toMatchObject({ price: 100, status: 'sent', cost: 0 }); // proposed became sent
    expect(await db('offer_items').where({ offer_id: offer.id })).toHaveLength(2);
  });

  it('leaves every offer’s items adding up to its price, and drops the plan tables', async () => {
    db = await beforeOffers();
    await db.migrate.up(migrationConfig);
    for (const o of await db('quotes')) {
      const sum = ((await db('offer_items').where({ offer_id: o.id }).sum({ s: 'price' }).first()) as { s: number }).s;
      expect(Math.round(sum * 100), o.title).toBe(Math.round(o.price * 100));
    }
    expect(await db.schema.hasTable('treatment_plans')).toBe(false);
    expect(await db.schema.hasTable('treatment_plan_items')).toBe(false);
  });

  it('renames the saved role permissions of the old modules', async () => {
    db = await beforeOffers();
    await db.migrate.up(migrationConfig);
    expect(await db('role_permissions').select('role', 'permission', 'allowed')).toEqual([{ role: 'doctor', permission: 'offers:delete', allowed: 0 }]); // the plans row is gone
  });

  it('migration 022 turns sent offers into accepted ones and rejected or expired ones into cancelled', async () => {
    db = await beforeOffers();
    await db.migrate.up(migrationConfig); // 020
    const patient = (await db('patients').first('id'))!.id as number;
    for (const status of ['sent', 'rejected', 'expired', 'draft', 'accepted', 'cancelled']) {
      await db('quotes').insert({ title: status, type: 'clinic', price: 10, cost: 0, currency: '$', status, patient_id: patient, ...stamp });
    }
    await db.migrate.latest(migrationConfig); // 021 and 022
    const byTitle = async (title: string) => (await db!('quotes').where({ title }).first())!.status;
    expect([await byTitle('sent'), await byTitle('rejected'), await byTitle('expired'), await byTitle('draft'), await byTitle('accepted'), await byTitle('cancelled')])
      .toEqual(['accepted', 'cancelled', 'cancelled', 'draft', 'accepted', 'cancelled']);
    expect(await db('quotes').where({ title: 'Bridge' }).first()).toMatchObject({ status: 'accepted' }); // the migrated pending one
    await expect(db.migrate.down(migrationConfig)).rejects.toThrow(/Rolling back migration 022 is not supported/);
  });

  it('cannot be rolled back', async () => {
    db = await beforeOffers();
    await db.migrate.up(migrationConfig);
    await expect(db.migrate.down(migrationConfig)).rejects.toThrow(/Rolling back migration 020 is not supported/);
  });
});
