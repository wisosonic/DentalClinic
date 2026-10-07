import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TAX_SETTINGS, calculateIncomeTax, taxSettingsSchema } from '@aya/shared';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Lebanese income tax estimate. The owner's rules: 35% of the year's payments (in LBP at the admin's
 * rate), less the family allowances, never below zero, then the progressive brackets.
 */
const S = DEFAULT_TAX_SETTINGS;

describe('the calculation (the owner’s steps, worked by hand)', () => {
  it('converts, takes 35%, deducts the single allowance, and applies the brackets', () => {
    // 100,000 USD x 89,500 = 8,950,000,000 LBP; 35% = 3,132,500,000; less 450,000,000 = 2,682,500,000
    const r = calculateIncomeTax({ paymentsUsd: 100_000, spouse: false, children: 0 }, S);
    expect(r.paymentsLbp).toBe(8_950_000_000);
    expect(r.taxablePart).toBe(3_132_500_000);
    expect(r.allowances.total).toBe(450_000_000);
    expect(r.amountAfterAllowances).toBe(2_682_500_000);
    // 540M x 4% + 900M x 7% + 1,242.5M x 12% = 21.6M + 63M + 149.1M
    expect(r.steps.map((s) => [s.amount, s.tax])).toEqual([[540_000_000, 21_600_000], [900_000_000, 63_000_000], [1_242_500_000, 149_100_000], [0, 0], [0, 0], [0, 0]]);
    expect(r.taxPayable).toBe(233_700_000);
    expect(r.effectiveRate).toBe(2.6);
  });

  it('adds the spouse and each child to the allowances', () => {
    const r = calculateIncomeTax({ paymentsUsd: 100_000, spouse: true, children: 2 }, S);
    expect(r.allowances).toMatchObject({ total: 725_000_000, single: 450_000_000, spouse: 225_000_000, children: 50_000_000, childCount: 2 });
    expect(r.amountAfterAllowances).toBe(2_407_500_000);
    expect(r.taxPayable).toBe(200_700_000); // 21.6M + 63M + 967.5M x 12%
  });

  it('is zero when the allowances cover everything, and never negative', () => {
    const r = calculateIncomeTax({ paymentsUsd: 1_000, spouse: false, children: 0 }, S); // 35% of 89.5M is far below 450M
    expect(r.amountAfterAllowances).toBe(0);
    expect(r.taxPayable).toBe(0);
    expect(calculateIncomeTax({ paymentsUsd: 0, spouse: false, children: 0 }, S)).toMatchObject({ taxPayable: 0, effectiveRate: 0 });
    expect(calculateIncomeTax({ paymentsUsd: -50, spouse: false, children: 0 }, S).taxPayable).toBe(0);
  });

  it('reaches the top bracket', () => {
    // amount after allowances of exactly 20,000,000,000: needs payments of (20B + 450M) / 0.35 LBP
    const usd = (20_000_000_000 + 450_000_000) / 0.35 / S.usdToLbp;
    const r = calculateIncomeTax({ paymentsUsd: usd, spouse: false, children: 0 }, S);
    expect(Math.abs(r.amountAfterAllowances - 20_000_000_000)).toBeLessThan(1_000);
    // 21.6M + 63M + 216M + 480M + 1,524.6M + 6.5B x 25% = 3,930.2M (to within the rounding of the input)
    expect(Math.abs(r.taxPayable - 3_930_200_000)).toBeLessThan(1_000);
    expect(r.steps.at(-1)!.rate).toBe(25);
  });

  it('puts an amount exactly on a bracket edge in the lower bracket only', () => {
    const edge = { ...S, allowances: { single: 0, spouse: 0, child: 0 }, usdToLbp: 1 };
    // payments of 540,000,000 / 0.35 give exactly 189M after 35%
    const r = calculateIncomeTax({ paymentsUsd: 540_000_000 / 0.35, spouse: false, children: 0 }, edge);
    expect(r.amountAfterAllowances).toBe(540_000_000);
    expect(r.taxPayable).toBe(21_600_000);
    expect(r.steps[1]!.amount).toBe(0);
  });

  it('uses the tax percentage of the settings, which can follow a change of law', () => {
    const r = calculateIncomeTax({ paymentsUsd: 100_000, spouse: false, children: 0 }, { ...S, taxPercentage: 30 });
    expect(r.taxablePart).toBe(2_685_000_000);
    expect(r.amountAfterAllowances).toBe(2_235_000_000);
  });

  it('follows the rate and the brackets it is given', () => {
    const r = calculateIncomeTax({ paymentsUsd: 100_000, spouse: false, children: 0 }, { ...S, usdToLbp: 100_000, brackets: [{ from: 0, to: null, rate: 10 }] });
    expect(r.paymentsLbp).toBe(10_000_000_000);
    expect(r.taxPayable).toBe(Math.round((3_500_000_000 - 450_000_000) * 0.1));
  });
});

describe('the settings must make sense', () => {
  const ok = { usdToLbp: 89500, taxPercentage: 35, allowances: S.allowances, brackets: S.brackets };
  const issues = (v: unknown) => { const r = taxSettingsSchema.safeParse(v); return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`); };

  it('accepts the owner’s starting values', () => expect(issues(ok)).toEqual([]));

  it('refuses gaps, overlaps, a first bracket not at 0, and a closed last bracket', () => {
    expect(issues({ ...ok, brackets: [{ from: 10, to: null, rate: 4 }] })).toContain('brackets.0.from: The first bracket must start at 0');
    expect(issues({ ...ok, brackets: [{ from: 0, to: 100, rate: 4 }, { from: 200, to: null, rate: 7 }] })).toContain('brackets.1.from: Each bracket must start where the one before it ends');
    expect(issues({ ...ok, brackets: [{ from: 0, to: 100, rate: 4 }, { from: 50, to: null, rate: 7 }] })).toContain('brackets.1.from: Each bracket must start where the one before it ends');
    expect(issues({ ...ok, brackets: [{ from: 0, to: 100, rate: 4 }] })).toContain('brackets.0.to: The last bracket must have no upper limit');
    expect(issues({ ...ok, brackets: [{ from: 0, to: null, rate: 4 }, { from: 0, to: null, rate: 4 }] })).toContain('brackets.0.to: Only the last bracket can have no upper limit');
  });

  it('refuses bad rates, rates of exchange and amounts', () => {
    expect(issues({ ...ok, usdToLbp: 0 })).toContain('usdToLbp: The exchange rate must be above zero');
    expect(issues({ ...ok, taxPercentage: 0 })).toContain('taxPercentage: The percentage must be above zero');
    expect(issues({ ...ok, taxPercentage: 120 })).toContain('taxPercentage: The percentage cannot be above 100');
    expect(issues({ ...ok, brackets: [{ from: 0, to: null, rate: 101 }] })).toContain('brackets.0.rate: The rate cannot be above 100');
    expect(issues({ ...ok, allowances: { ...S.allowances, child: -1 } })).toContain('allowances.child: Cannot be negative');
    expect(issues({ ...ok, brackets: [] })).toContain('brackets: Add at least one bracket');
  });
});

let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  [admin, aya, staff, patient] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['tax_declarations', 'payments', 'treatment_offers', 'expenses', 'tax_rule_sets', 'audit_log']) await t.db(table).del();
  await t.db('doctors').update({ tax_spouse: false, tax_children: 0 });
});

const quote = async (patient_id: number) => (await t.db('treatment_offers').insert({ title: 'Q', type: 'clinic', price: 1e7, cost: 0, currency: '$', status: 'accepted', patient_id, ...stamp }))[0]!;
const pay = (offer_id: number, amount: number, date: string, extra: object = {}) =>
  t.db('payments').insert({ date, type: 'clinic', amount, currency: '$', offer_id, dr_part: 100, collected_by_doctor_id: s.doctorId, ...stamp, ...extra });
const tax = async (qs: string, c: Client = admin) => (await c.get(`/finance/tax?${qs}`)).body;
const rules = (extra: object = {}) => ({ ...S, ...extra });

describe('the settings API: rules by year', () => {
  it('starts empty, offering the owner’s values to begin from', async () => {
    const r = (await admin.get('/settings/tax')).body;
    expect(r.sets).toEqual([]);
    expect(r.defaults).toEqual(S);
  });

  it('saves a set for a year, replaces it, validates it, and is for admins only', async () => {
    const next = rules({ usdToLbp: 90_000, taxPercentage: 30, allowances: { single: 500_000_000, spouse: 250_000_000, child: 50_000_000 }, brackets: [{ from: 0, to: 1_000_000_000, rate: 5 }, { from: 1_000_000_000, to: null, rate: 10 }] });
    const saved = await admin.put('/settings/tax/2026', next);
    expect(saved.status).toBe(200);
    expect(saved.body.sets).toMatchObject([{ effectiveYear: 2026, settings: next }]);
    expect((await admin.put('/settings/tax/2026', { ...next, usdToLbp: 95_000 })).body.sets).toHaveLength(1); // replaced, not added
    expect((await admin.get('/settings/tax')).body.sets[0].settings.usdToLbp).toBe(95_000);
    expect((await admin.put('/settings/tax/2026', { ...next, brackets: [{ from: 5, to: null, rate: 5 }] })).status).toBe(400);
    expect((await admin.put('/settings/tax/1990', next)).status).toBe(400);
    expect((await admin.put('/settings/tax/abc', next)).status).toBe(400);
    for (const c of [aya, staff, patient]) {
      expect((await c.get('/settings/tax')).status).toBe(403);
      expect((await c.put('/settings/tax/2026', next)).status).toBe(403);
      expect((await c.send('delete', '/settings/tax/2026')).status).toBe(403);
    }
    expect((await t.client().get('/settings/tax')).status).toBe(401);
  });

  it('lists the sets newest first, and deletes one', async () => {
    await admin.put('/settings/tax/2024', rules());
    await admin.put('/settings/tax/2027', rules({ usdToLbp: 100_000 }));
    expect((await admin.get('/settings/tax')).body.sets.map((x: { effectiveYear: number }) => x.effectiveYear)).toEqual([2027, 2024]);
    expect((await admin.send('delete', '/settings/tax/2027')).body.sets.map((x: { effectiveYear: number }) => x.effectiveYear)).toEqual([2024]);
    expect((await admin.send('delete', '/settings/tax/2027')).status).toBe(404);
  });

  it('logs that rules changed without logging the figures', async () => {
    await admin.put('/settings/tax/2026', rules({ usdToLbp: 91_234 }));
    const entry = await t.db('audit_log').where({ action: 'settings.tax.update' }).first();
    expect(entry).toMatchObject({ entity: 'settings', entity_id: 'tax:2026' });
    expect(entry.diff).not.toContain('91234');
  });
});

describe('the tax of the year', () => {
  it('counts the year’s clinic payments and commission received, and nothing else', async () => {
    const q = await quote(s.patientId);
    await pay(q, 60_000, '2026-02-01');
    await pay(q, 20_000, '2026-12-31'); // last day of the year counts
    await pay(q, 7_000, '2025-12-31'); // other years do not
    await pay(q, 9_000, '2027-01-01');
    await t.db('payments').insert({ date: '2026-06-01', type: 'commission', amount: 20_000, currency: '$', model_id: s.externalDoctorId, collected_by_doctor_id: s.doctorId, ...stamp });
    await t.db('expenses').insert({ date: '2026-03-01', type: 'clinic', amount: 50_000, currency: '$', ...stamp }); // expenses are not deducted
    const r = await tax('year=2026');
    expect(r.payments).toEqual({ clinic: { total: 80_000, count: 2 }, commission: { total: 20_000, count: 1 }, totalUsd: 100_000 });
    expect(r.result.taxPayable).toBe(233_700_000); // the hand-worked 100,000 USD example
    expect(r.usingDefaults).toBe(true);
    expect(r.rulesFrom).toBeNull();
  });

  it('agrees with the Summary’s total payments for the same year (dollars)', async () => {
    const q = await quote(s.patientId);
    await pay(q, 1234.5, '2026-05-05');
    await t.db('payments').insert({ date: '2026-06-01', type: 'commission', amount: 100, currency: '$', model_id: s.externalDoctorId, collected_by_doctor_id: s.doctorId, ...stamp });
    const summary = (await admin.get('/finance/summary?from=2026-01-01&to=2026-12-31')).body;
    expect((await tax('year=2026')).payments.totalUsd).toBe(summary.payments.total);
  });

  it('uses the rules that apply to the year: the latest set starting in that year or before', async () => {
    await pay(await quote(s.patientId), 100_000, '2026-04-01');
    await pay(await quote(s.patientId), 100_000, '2024-04-01');
    await pay(await quote(s.patientId), 100_000, '2030-04-01');
    await admin.put('/settings/tax/2025', rules({ usdToLbp: 100_000, brackets: [{ from: 0, to: null, rate: 10 }] }));
    await admin.put('/settings/tax/2028', rules({ usdToLbp: 200_000, taxPercentage: 30, brackets: [{ from: 0, to: null, rate: 20 }] }));
    const y2026 = await tax('year=2026');
    expect(y2026).toMatchObject({ rulesFrom: 2025, usingDefaults: false });
    expect(y2026.result.paymentsLbp).toBe(10_000_000_000);
    expect(y2026.result.taxPayable).toBe(305_000_000);
    const y2030 = await tax('year=2030');
    expect(y2030.rulesFrom).toBe(2028);
    expect(y2030.result.taxablePart).toBe(6_000_000_000); // 100,000 x 200,000 x 30%
    expect(y2030.result.taxPayable).toBe(1_110_000_000); // (6,000M - 450M) x 20%
    const y2024 = await tax('year=2024'); // before every saved set: the starting values
    expect(y2024).toMatchObject({ rulesFrom: null, usingDefaults: true });
    expect(y2024.result.taxPayable).toBe(233_700_000);
  });

  it('starts from the doctor’s saved family details, and lets another situation be tried', async () => {
    await pay(await quote(s.patientId), 100_000, '2026-04-01');
    await t.db('doctors').where({ id: s.doctorId }).update({ tax_spouse: true, tax_children: 2 });
    const mine = await tax(`year=2026&doctorId=${s.doctorId}`);
    expect(mine.family).toEqual({ spouse: true, children: 2 });
    expect(mine.result.allowances).toMatchObject({ total: 725_000_000, childCount: 2 });
    expect(mine.result.taxPayable).toBe(200_700_000);
    const single = await tax(`year=2026&doctorId=${s.doctorId}&spouse=0&children=0`); // the page trying another situation
    expect(single.result.taxPayable).toBe(233_700_000);
    const clinic = await tax('year=2026'); // the whole clinic has no family details
    expect(clinic.family).toEqual({ spouse: false, children: 0 });
    expect(clinic.result.taxPayable).toBe(233_700_000);
  });

  it('can be limited to one doctor, by who collected the money', async () => {
    const q = await quote(s.patientId);
    await pay(q, 300, '2026-04-01');
    await pay(q, 700, '2026-04-02', { collected_by_doctor_id: s.externalDoctorId });
    expect((await tax(`year=2026&doctorId=${s.doctorId}`)).payments.totalUsd).toBe(300);
    expect((await tax(`year=2026&doctorId=${s.externalDoctorId}`)).doctor).toMatchObject({ id: s.externalDoctorId });
    expect((await tax(`year=2026&doctorId=${s.externalDoctorId}`)).payments.totalUsd).toBe(700);
    expect((await tax('year=2026')).payments.totalUsd).toBe(1000);
    expect((await admin.get('/finance/tax?year=2026&doctorId=9999')).body.error.code).toBe('UNKNOWN_DOCTOR');
  });

  it('leaves out deleted payments and those of deleted quotes and patients, and lists currencies it cannot convert', async () => {
    const q = await quote(s.patientId);
    const gone = await quote(s.otherPatientId);
    await pay(q, 100, '2026-04-01');
    await pay(q, 900, '2026-04-02', { deleted_at: '2026-04-03 00:00:00' });
    await pay(gone, 800, '2026-04-02');
    await t.db('treatment_offers').where({ id: gone }).update({ deleted_at: '2026-04-03 00:00:00' });
    await pay(q, 50, '2026-04-04', { currency: 'EUR' });
    const r = await tax('year=2026');
    expect(r.payments.totalUsd).toBe(100);
    expect(r.excluded).toEqual([{ currency: 'EUR', total: 50, count: 1 }]);
  });

  it('is zero with no payments, and rejects a bad year', async () => {
    expect((await tax('year=2026')).result).toMatchObject({ taxPayable: 0, paymentsLbp: 0 });
    expect((await admin.get('/finance/tax?year=1999')).status).toBe(400);
    expect((await admin.get('/finance/tax')).status).toBe(400);
  });

  it('is for admins only, and records who looked, never the figures', async () => {
    await pay(await quote(s.patientId), 12_345, '2026-04-01');
    for (const c of [aya, staff, patient]) expect((await c.get('/finance/tax?year=2026')).status).toBe(403);
    expect((await t.client().get('/finance/tax?year=2026')).status).toBe(401);
    await admin.get('/finance/tax?year=2026');
    const entry = await t.db('audit_log').where({ action: 'tax.view' }).first();
    expect(entry).toMatchObject({ entity: 'tax', entity_id: '2026' });
    expect(JSON.stringify(entry)).not.toContain('12345');
  });
});

describe('the family details on the doctor’s profile', () => {
  it('are set by an admin and shown to admins only', async () => {
    const saved = await admin.patch(`/doctors/${s.doctorId}`, { taxSpouse: true, taxChildren: 3 });
    expect(saved.status).toBe(200);
    expect(saved.body.doctor).toMatchObject({ taxSpouse: true, taxChildren: 3 });
    expect((await admin.get(`/doctors/${s.doctorId}`)).body.doctor).toMatchObject({ taxSpouse: true, taxChildren: 3 });
    for (const c of [aya, staff, patient]) {
      const doctor = (await c.get(`/doctors/${s.doctorId}`)).body.doctor;
      expect(doctor?.taxSpouse).toBeUndefined();
      expect(doctor?.taxChildren).toBeUndefined();
    }
  });

  it('cannot be changed by an owner doctor or anyone but an admin, and must make sense', async () => {
    const res = await aya.patch(`/doctors/${s.externalDoctorId}`, { taxChildren: 2 });
    expect(res.status).toBe(403);
    expect((await staff.patch(`/doctors/${s.doctorId}`, { taxSpouse: true })).status).toBe(403);
    expect((await admin.patch(`/doctors/${s.doctorId}`, { taxChildren: -1 })).status).toBe(400);
    expect((await admin.patch(`/doctors/${s.doctorId}`, { taxChildren: 99 })).status).toBe(400);
    expect((await admin.patch(`/doctors/${s.doctorId}`, { taxChildren: 1.5 })).status).toBe(400);
  });
});

describe('payments are only stored in dollars', () => {
  it('records every payment in USD, whatever the request says, so there is nothing in LBP to add', async () => {
    const q = await quote(s.patientId);
    await t.db('treatment_offers').where({ id: q }).update({ price: 1000, status: 'accepted' });
    const res = await admin.post('/payments', { offerId: q, amount: 100, method: 'cash', date: '2026-10-01', currency: 'LBP' });
    expect(res.status).toBe(201);
    const rows = await t.db('payments').where({ offer_id: q });
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBe('$');
    expect((await tax('year=2026')).excluded).toEqual([]);
  });
});

describe('declaring a year as paid', () => {
  const declare = (c: Client, body: object = {}) => c.post('/finance/tax/declare', { year: 2026, paidDate: '2026-10-05', spouse: false, children: 0, ...body });

  it('stores the figures of that day and then serves them, never recalculating', async () => {
    const q = await quote(s.patientId);
    await pay(q, 100_000, '2026-04-01');
    const res = await declare(admin, { note: 'Filed at the ministry', spouse: true, children: 2 });
    expect(res.status).toBe(201);
    expect(res.body.declaration).toMatchObject({ paidDate: '2026-10-05', note: 'Filed at the ministry', declaredBy: 'Admin One' });
    expect(res.body.declaredYears).toEqual([2026]);
    const row = await t.db('tax_declarations').where({ year: 2026 }).first();
    expect(row).toMatchObject({ scope: 'clinic', doctor_id: null, tax_payable: 200_700_000 });
    expect(JSON.parse(row.snapshot).input).toEqual({ paymentsUsd: 100_000, spouse: true, children: 2 });

    // the laws change and more money is recorded: the declared year does not move
    await admin.put('/settings/tax/2026', rules({ usdToLbp: 200_000, taxPercentage: 50, brackets: [{ from: 0, to: null, rate: 30 }] }));
    await pay(q, 5_000, '2026-05-01');
    const r = await tax('year=2026&spouse=0&children=9'); // what the page tries is ignored for a declared year
    expect(r.declaration).toMatchObject({ paidDate: '2026-10-05' });
    expect(r.result.taxPayable).toBe(200_700_000);
    expect(r.settings.usdToLbp).toBe(89_500);
    expect(r.input).toMatchObject({ paymentsUsd: 100_000, spouse: true, children: 2 });
    expect(r.usingDefaults).toBe(true); // as it was that day
    expect(r.drift).toEqual({ paymentsUsd: 105_000 }); // the books moved: said, not applied
  });

  it('says nothing about drift while the books still match, and other years are still live', async () => {
    await pay(await quote(s.patientId), 1_000, '2026-04-01');
    await pay(await quote(s.patientId), 2_000, '2025-04-01');
    await declare(admin);
    expect((await tax('year=2026')).drift).toBeNull();
    const other = await tax('year=2025');
    expect(other.declaration).toBeNull();
    expect(other.payments.totalUsd).toBe(2_000);
    expect(other.declaredYears).toEqual([2026]);
  });

  it('is per taxpayer: the clinic and each doctor are declared on their own', async () => {
    await pay(await quote(s.patientId), 1_000, '2026-04-01');
    await declare(admin, { doctorId: s.doctorId });
    expect((await tax(`year=2026&doctorId=${s.doctorId}`)).declaration).not.toBeNull();
    expect((await tax('year=2026')).declaration).toBeNull();
    expect((await tax(`year=2026&doctorId=${s.externalDoctorId}`)).declaration).toBeNull();
    expect((await declare(admin)).status).toBe(201);
    expect(await t.db('tax_declarations').count({ n: '*' }).first()).toMatchObject({ n: 2 });
  });

  it('cannot be done twice, for a future year, or with nonsense', async () => {
    expect((await declare(admin)).status).toBe(201);
    const again = await declare(admin);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_DECLARED');
    expect((await declare(admin, { year: 2027 })).body.error.code).toBe('FUTURE_YEAR');
    expect((await declare(admin, { year: 2025, paidDate: 'yesterday' })).status).toBe(400);
    expect((await declare(admin, { year: 2025, children: -1 })).status).toBe(400);
    expect((await declare(admin, { year: 2025, doctorId: 9999 })).body.error.code).toBe('UNKNOWN_DOCTOR');
    expect(await t.db('tax_declarations').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('never trusts figures from the page: they are always the server’s', async () => {
    await pay(await quote(s.patientId), 1_000, '2026-04-01');
    await declare(admin, { paymentsUsd: 1, taxPayable: 0, result: { taxPayable: 0 } });
    expect((await tax('year=2026')).input.paymentsUsd).toBe(1_000);
  });

  it('is for admins only, and logs who did it without the amount', async () => {
    await pay(await quote(s.patientId), 12_345, '2026-04-01');
    for (const c of [aya, staff, patient]) expect((await declare(c)).status).toBe(403);
    expect([401, 403]).toContain((await declare(t.client())).status); // no session, and no CSRF token either
    await declare(admin);
    const entry = await t.db('audit_log').where({ action: 'tax.declare' }).first();
    expect(entry).toMatchObject({ entity: 'tax', entity_id: '2026' });
    expect(JSON.stringify(entry)).not.toContain('12345');
  });
});

describe('reopening a declared year', () => {
  const declare = (year: number, body: object = {}) => admin.post('/finance/tax/declare', { year, paidDate: '2026-10-05', spouse: false, children: 0, ...body });
  const reopen = (c: Client, year: number, body: object = {}) => c.post('/finance/tax/reopen', { year, ...body });

  it('lets the current year be reopened: it is calculated live again, and the old declaration is kept as voided', async () => {
    const q = await quote(s.patientId);
    await pay(q, 100_000, '2026-04-01');
    await declare(2026);
    expect((await tax('year=2026')).declaration).toMatchObject({ canReopen: true });
    await admin.put('/settings/tax/2026', rules({ usdToLbp: 100_000, brackets: [{ from: 0, to: null, rate: 10 }] })); // the law changed after filing
    const res = await reopen(admin, 2026);
    expect(res.status).toBe(200);
    expect(res.body.declaredYears).toEqual([]);
    const live = await tax('year=2026');
    expect(live.declaration).toBeNull();
    expect(live.settings.usdToLbp).toBe(100_000); // live: the rules in force now
    expect(live.result.taxPayable).toBe(305_000_000);
    const rows = await t.db('tax_declarations').where({ year: 2026 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active_scope: null, scope: 'clinic' });
    expect(rows[0].voided_at).not.toBeNull();
    expect(rows[0].voided_by).not.toBeNull();
    expect(JSON.parse(rows[0].snapshot).result.taxPayable).toBe(233_700_000); // what was filed is not lost
  });

  it('allows declaring the year again afterwards, keeping both records', async () => {
    await pay(await quote(s.patientId), 1_000, '2026-04-01');
    await declare(2026);
    await reopen(admin, 2026);
    expect((await declare(2026)).status).toBe(201);
    expect(await t.db('tax_declarations').where({ year: 2026 }).count({ n: '*' }).first()).toMatchObject({ n: 2 });
    expect((await tax('year=2026')).declaration).not.toBeNull();
    await reopen(admin, 2026);
    expect((await declare(2026)).status).toBe(201); // and again
    expect(await t.db('tax_declarations').where({ year: 2026 }).count({ n: '*' }).first()).toMatchObject({ n: 3 });
  });

  it('refuses a past year: once the year is over, what was filed stays', async () => {
    await pay(await quote(s.patientId), 1_000, '2025-04-01');
    await declare(2025);
    expect((await tax('year=2025')).declaration).toMatchObject({ canReopen: false });
    const res = await reopen(admin, 2025);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('YEAR_LOCKED');
    expect((await tax('year=2025')).declaration).not.toBeNull();
    expect(await t.db('tax_declarations').where({ year: 2025 }).whereNull('voided_at').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('is per taxpayer, and says so when the year is not declared', async () => {
    await declare(2026, { doctorId: s.doctorId });
    expect((await reopen(admin, 2026)).status).toBe(404); // the clinic was never declared
    expect((await reopen(admin, 2026, { doctorId: s.doctorId })).status).toBe(200);
    expect((await reopen(admin, 2026, { doctorId: s.doctorId })).status).toBe(404); // already reopened
  });

  it('is for admins only, and logs who did it without the figures', async () => {
    await pay(await quote(s.patientId), 12_345, '2026-04-01');
    await declare(2026);
    for (const c of [aya, staff, patient]) expect((await reopen(c, 2026)).status).toBe(403);
    expect((await tax('year=2026')).declaration).not.toBeNull();
    await reopen(admin, 2026);
    const entry = await t.db('audit_log').where({ action: 'tax.reopen' }).first();
    expect(entry).toMatchObject({ entity: 'tax', entity_id: '2026' });
    expect(JSON.stringify(entry)).not.toContain('12345');
    expect((await reopen(admin, 1999)).status).toBe(400);
  });
});

describe('the PDF worksheet', () => {
  const pdf = (c: Client, url: string) => c.agent.get(`/api/v1${url}`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  /** The words on the page (test builds are not compressed). */
  const words = (res: { body: unknown }) => {
    const raw = (res.body as Buffer).toString('latin1');
    return [raw.slice(0, 8), ...[...raw.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((arr) => [...arr[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join(''))].join('\n');
  };

  it('prints the estimate: who, the payments, each step, the brackets and the notice', async () => {
    await pay(await quote(s.patientId), 100_000, '2026-04-01');
    const res = await pdf(admin, '/finance/tax/pdf?year=2026');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="income-tax-2026.pdf"');
    expect(res.headers['cache-control']).toContain('no-store');
    const text = words(res);
    for (const part of ['%PDF', 'Test Clinic', 'Income tax estimate 2026', 'Not declared yet', 'The whole clinic', '$100000.00', '8,950,000,000 LBP', '3,132,500,000 LBP', '233,700,000 LBP', 'Brackets', 'No limit', 'not a tax return']) expect(text, part).toContain(part);
  });

  it('follows the family details given, and a doctor’s name for his own', async () => {
    await pay(await quote(s.patientId), 100_000, '2026-04-01');
    const text = words(await pdf(admin, `/finance/tax/pdf?year=2026&doctorId=${s.doctorId}&spouse=1&children=2`));
    expect(text).toContain('Dr ');
    expect(text).toContain('single, spouse, 2 child(ren)');
    expect(text).toContain('200,700,000 LBP');
  });

  it('prints a declared year from its stored copy, however the rules and payments have changed since', async () => {
    const q = await quote(s.patientId);
    await pay(q, 100_000, '2026-04-01');
    await admin.post('/finance/tax/declare', { year: 2026, paidDate: '2026-10-04', spouse: false, children: 0 });
    await admin.put('/settings/tax/2026', rules({ usdToLbp: 200_000 }));
    await pay(q, 50_000, '2026-05-01');
    const text = words(await pdf(admin, '/finance/tax/pdf?year=2026&spouse=1&children=9'));
    expect(text).toContain('Declared and paid on 2026-10-04');
    expect(text).toContain('233,700,000 LBP');
    expect(text).not.toContain('150000');
  });

  it('is for admins only, and logs that it was printed, never the figures', async () => {
    await pay(await quote(s.patientId), 12_345, '2026-04-01');
    for (const c of [aya, staff, patient]) expect((await pdf(c, '/finance/tax/pdf?year=2026')).status).toBe(403);
    expect((await pdf(t.client(), '/finance/tax/pdf?year=2026')).status).toBe(401);
    expect((await pdf(admin, '/finance/tax/pdf?year=1999')).status).toBe(400);
    await pdf(admin, '/finance/tax/pdf?year=2026');
    const entry = await t.db('audit_log').where({ action: 'tax.pdf' }).first();
    expect(entry).toMatchObject({ entity: 'tax', entity_id: '2026' });
    expect(JSON.stringify(entry)).not.toContain('12345');
  });
});
