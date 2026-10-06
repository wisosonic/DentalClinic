import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REPORT_LIMITS } from '../src/modules/reports/data';
import { cleanupReportJobs, runPendingReportJobs, runReportJob } from '../src/modules/reports/jobs';
import { NOW, PASSWORD, TODAY, TOMORROW, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/**
 * Reports (owner rules, 2026-10-05): the daily schedule (PDF), revenue and expenses and outstanding balances
 * (Excel and PDF), and appointments, procedures, new patients and lab orders (Excel). Admin runs all of them; a
 * doctor only within his own patients and never sees expenses or the cost of a lab order; staff run only the
 * daily schedule and the lab orders. Every export is logged, without its content.
 */
let t: TestApp;
let s: Seed;
let admin: Client, aya: Client, staff: Client, patient: Client, ext: Client;
let extPatient: number;
const stamp = { created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  s = await seedClinic(t);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const [uid] = await t.db('users').insert({ name: 'Ext Doc', email: 'ext@clinic.test', role: 'doctor', password: hash, ...stamp });
  await t.db('doctors').where({ id: s.externalDoctorId }).update({ user_id: uid });
  const [ayaUser] = await t.db('users').where({ email: 'doctor@clinic.test' }).pluck('id');
  await t.db('doctors').where({ id: s.doctorId }).update({ user_id: ayaUser });
  [admin, aya, staff, patient, ext] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test', 'ext@clinic.test'].map((e) => loggedIn(t, e)));
  extPatient = (await t.db('patients').insert({ patient_identifier: 'E1', fname: 'Ext', lname: 'Pat', phone: '70999999', doctor_id: s.externalDoctorId, created_at: '2026-10-02 10:00:00', updated_at: stamp.updated_at }))[0]!;
  await t.db('patients').where({ id: s.patientId }).update({ created_at: '2026-10-01 09:00:00' });
});
afterAll(() => t.destroy());
beforeEach(async () => {
  for (const table of ['lab_orders', 'payments', 'quotes', 'expenses', 'appointment_category', 'appointments', 'audit_log']) await t.db(table).del();
});

const fetchFile = (c: Client, url: string) => c.agent.get(`/api/v1${url}`).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (d: Buffer) => chunks.push(d));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
/** The cells of the first worksheet as arrays, header row first (the title and period rows are dropped). */
async function sheet(res: { body: unknown }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as unknown as ArrayBuffer); // exceljs types a Buffer as an ArrayBuffer
  const ws = wb.worksheets[0]!;
  const rows: unknown[][] = [];
  ws.eachRow((row, n) => { if (n >= 3) rows.push((row.values as unknown[]).slice(1).map((v) => (v && typeof v === 'object' && 'formula' in (v as object) ? `=${(v as { formula: string }).formula}` : v))); });
  return { ws, title: String(ws.getCell('A1').value), subtitle: String(ws.getCell('A2').value), header: rows[0] as string[], body: rows.slice(1) };
}
/** The words on a PDF page (test builds are not compressed). */
const words = (res: { body: unknown }) => {
  const raw = (res.body as Buffer).toString('latin1');
  return [raw.slice(0, 8), ...[...raw.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((arr) => [...arr[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join(''))].join('\n');
};
const quote = async (patient_id: number, price: number, status = 'accepted') => (await t.db('quotes').insert({ title: 'Crown', type: 'clinic', price, cost: 0, currency: '$', status, patient_id, ...stamp }))[0]!;
const pay = (quote_id: number, amount: number, date: string, extra: object = {}) =>
  t.db('payments').insert({ date, type: 'clinic', amount, currency: '$', quote_id, dr_part: 100, collected_by_doctor_id: s.doctorId, ...stamp, ...extra });
const visit = async (patient_id: number, doctor_id: number, date: string, time: string, status = 'confirmed') =>
  (await t.db('appointments').insert({ date, time, status, patient_id, doctor_id, clinic_id: s.clinicId, unit_id: s.unitId, duration_minutes: 30, ...stamp }))[0]!;

describe('who may run which report', () => {
  const P = 'from=2026-10-01&to=2026-10-31';
  const urls: Record<string, string> = {
    'daily-schedule': `/reports/daily-schedule?date=${TODAY}`, revenue: `/reports/revenue?${P}`, 'outstanding-balances': '/reports/outstanding-balances',
    appointments: `/reports/appointments?${P}`, procedures: `/reports/procedures?${P}`, patients: `/reports/patients?${P}`, 'lab-orders': `/reports/lab-orders?${P}`,
  };

  it('lets an admin run every one', async () => {
    for (const [name, url] of Object.entries(urls)) expect((await fetchFile(admin, url)).status, name).toBe(200);
  });

  it('lets a doctor run all of them, and staff only the schedule and the lab orders', async () => {
    for (const c of [aya, ext]) for (const [name, url] of Object.entries(urls)) expect((await fetchFile(c, url)).status, name).toBe(200);
    for (const [name, url] of Object.entries(urls)) expect((await fetchFile(staff, url)).status, name).toBe(['daily-schedule', 'lab-orders'].includes(name) ? 200 : 403);
  });

  it('is closed to patients and visitors, and lists only what a person may run', async () => {
    for (const url of Object.values(urls)) {
      expect((await fetchFile(patient, url)).status).toBe(403);
      expect((await fetchFile(t.client(), url)).status).toBe(401);
    }
    expect((await staff.get('/reports')).body.data).toEqual(['daily-schedule', 'lab-orders']);
    expect((await admin.get('/reports')).body.data).toHaveLength(7);
  });

  it('sends the right file type, never cached', async () => {
    const x = await fetchFile(admin, urls.revenue!);
    expect(x.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(x.headers['content-disposition']).toMatch(/^attachment; filename="revenue-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(x.headers['cache-control']).toContain('no-store');
    const p = await fetchFile(admin, `${urls.revenue}&format=pdf`);
    expect(p.headers['content-type']).toBe('application/pdf');
    expect(words(p).startsWith('%PDF')).toBe(true);
  });

  it('refuses a bad period', async () => {
    expect((await admin.get('/reports/appointments?from=2026-10-31&to=2026-10-01')).status).toBe(400);
    expect((await admin.get('/reports/appointments?from=yesterday&to=today')).status).toBe(400);
    expect((await admin.get('/reports/appointments?from=2010-01-01&to=2026-10-01')).status).toBe(400); // over five years
    expect((await admin.get('/reports/appointments')).status).toBe(400);
    expect((await admin.get('/reports/daily-schedule')).status).toBe(400);
  });
});

describe('daily schedule (PDF)', () => {
  it('lists the active appointments of the day in time order, with procedures, and no phone numbers or notes', async () => {
    const a = await visit(s.patientId, s.doctorId, TODAY, '14:00');
    await visit(s.patientId, s.doctorId, TODAY, '09:00', 'completed');
    await visit(s.patientId, s.doctorId, TODAY, '10:30', 'cancelled'); // not on the schedule
    await visit(s.patientId, s.doctorId, TOMORROW, '09:00'); // another day
    await t.db('appointment_category').insert({ appointment_id: a, category_id: s.categoryIds[0], ...stamp });
    const text = words(await fetchFile(staff, `/reports/daily-schedule?date=${TODAY}`));
    for (const part of ['Daily schedule', TODAY, '2 appointments', 'Pat Patient', 'Dr Aya', '09:00', '14:00']) expect(text, part).toContain(part);
    expect(text).not.toContain('10:30');
    expect(text.indexOf('09:00')).toBeLessThan(text.indexOf('14:00'));
    expect(text).not.toContain('70111111'); // the patient's phone
    expect(text).not.toContain('secret note'); // the patient's internal notes
    expect(text).toContain('Test Clinic');
  });

  it('shows a specialist only the visits he treats or of his own patients, and nothing to an unlinked doctor', async () => {
    await visit(s.patientId, s.doctorId, TODAY, '09:00'); // Aya's patient, Aya treats: not his
    await visit(extPatient, s.externalDoctorId, TODAY, '10:00'); // his
    await visit(s.patientId, s.externalDoctorId, TODAY, '11:00'); // he treats Aya's patient: involved
    const mine = words(await fetchFile(ext, `/reports/daily-schedule?date=${TODAY}`));
    expect(mine).toContain('2 appointments');
    expect(mine).toContain('10:00');
    expect(mine).toContain('11:00');
    expect(mine).not.toContain('09:00');
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await t.db('users').insert({ name: 'Loose', email: 'loose@clinic.test', role: 'doctor', password: hash, ...stamp });
    const loose = await loggedIn(t, 'loose@clinic.test');
    expect(words(await fetchFile(loose, `/reports/daily-schedule?date=${TODAY}`))).toContain('0 appointments');
    expect(words(await fetchFile(aya, `/reports/daily-schedule?date=${TODAY}`))).toContain('3 appointments'); // an owner sees the clinic's day
    await t.db('users').where({ email: 'loose@clinic.test' }).del();
  });
});

describe('revenue and expenses', () => {
  it('by month, for an admin: payments, expenses and net, with a total row of real formulas', async () => {
    const q = await quote(s.patientId, 5000);
    await pay(q, 100, '2026-08-10');
    await pay(q, 300, '2026-10-02');
    await t.db('expenses').insert({ date: '2026-08-11', type: 'clinic', amount: 40, currency: '$', ...stamp });
    const r = await sheet(await fetchFile(admin, '/reports/revenue?from=2026-08-01&to=2026-10-31'));
    expect(r.title).toBe('Revenue and expenses by month');
    expect(r.header).toEqual(['Month', 'Payments', 'Expenses', 'Net']);
    expect(r.body.slice(0, 3)).toEqual([['2026-08', 100, 40, 60], ['2026-09', 0, 0, 0], ['2026-10', 300, 0, 300]]);
    expect(r.body[3]).toEqual(['Total', '=SUM(B4:B6)', '=SUM(C4:C6)', '=SUM(D4:D6)']);
    expect(r.ws.getCell('B4').numFmt).toContain('$'); // money is a real number with a currency format
    expect(r.ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
  });

  it('shows a doctor only his own patients’ payments, with no expenses', async () => {
    await pay(await quote(s.patientId, 1000), 200, '2026-10-02');
    await pay(await quote(extPatient, 1000), 700, '2026-10-02', { collected_by_doctor_id: s.externalDoctorId });
    await t.db('expenses').insert({ date: '2026-10-03', type: 'clinic', amount: 50, currency: '$', ...stamp });
    const mine = await sheet(await fetchFile(aya, '/reports/revenue?from=2026-10-01&to=2026-10-31'));
    expect(mine.header).toEqual(['Month', 'Payments']);
    expect(mine.body[0]).toEqual(['2026-10', 200]);
    expect(mine.subtitle).toContain('your patients');
    expect((await sheet(await fetchFile(ext, '/reports/revenue?from=2026-10-01&to=2026-10-31'))).body[0]).toEqual(['2026-10', 700]);
    expect((await sheet(await fetchFile(admin, '/reports/revenue?from=2026-10-01&to=2026-10-31'))).body[0]).toEqual(['2026-10', 900, 50, 850]);
  });

  it('by type: payments from patients and commission, and expenses by type (admin)', async () => {
    await pay(await quote(s.patientId, 1000), 200, '2026-10-02');
    await t.db('payments').insert({ date: '2026-10-04', type: 'commission', amount: 30, currency: '$', model_id: s.externalDoctorId, collected_by_doctor_id: s.doctorId, ...stamp });
    await t.db('expenses').insert([{ date: '2026-10-03', type: 'lab', amount: 50, currency: '$', ...stamp }, { date: '2026-10-03', type: 'clinic', amount: 20, currency: '$', ...stamp }]);
    const r = await sheet(await fetchFile(admin, '/reports/revenue?from=2026-10-01&to=2026-10-31&groupBy=type'));
    expect(r.header).toEqual(['Kind', 'Type', 'Count', 'Amount']);
    expect(r.body).toEqual(expect.arrayContaining([['Payments', 'From patients', 1, 200], ['Payments', 'Commission received', 1, 30], ['Expenses', 'lab', 1, 50], ['Expenses', 'clinic', 1, 20]]));
    const mine = await sheet(await fetchFile(aya, '/reports/revenue?from=2026-10-01&to=2026-10-31&groupBy=type'));
    expect(mine.body).toEqual([['Payments', 'From patients', 1, 200]]); // no commission, no expenses
  });

  it('by doctor, for admins only: who collected what', async () => {
    const q = await quote(s.patientId, 5000);
    await pay(q, 100, '2026-10-02');
    await pay(q, 400, '2026-10-03', { collected_by_doctor_id: s.externalDoctorId });
    const r = await sheet(await fetchFile(admin, '/reports/revenue?from=2026-10-01&to=2026-10-31&groupBy=doctor'));
    expect(r.header).toEqual(['Doctor', 'Payments', 'From patients', 'Commission received', 'Total']);
    expect(r.body[0]![0]).toContain('Dr');
    expect(r.body.map((row) => row[4]).slice(0, 2)).toEqual([400, 100]); // biggest first
    expect((await fetchFile(aya, '/reports/revenue?from=2026-10-01&to=2026-10-31&groupBy=doctor')).status).toBe(403);
  });

  it('as a PDF with the clinic letterhead, the period and the figures', async () => {
    await pay(await quote(s.patientId, 1000), 250.5, '2026-10-02');
    const text = words(await fetchFile(admin, '/reports/revenue?from=2026-10-01&to=2026-10-31&format=pdf'));
    for (const part of ['Test Clinic', 'Revenue and expenses by month', '2026-10-01 to 2026-10-31', '2026-10', '$250.50']) expect(text, part).toContain(part);
  });
});

describe('outstanding balances', () => {
  it('lists open quotes with what is left, biggest first, and leaves out paid, draft and rejected ones', async () => {
    const big = await quote(s.patientId, 900);
    await pay(big, 100, '2026-10-02');
    await quote(extPatient, 300);
    await quote(s.patientId, 500, 'draft');
    await quote(s.patientId, 70, 'rejected');
    const full = await quote(s.patientId, 50);
    await pay(full, 50, '2026-10-02');
    const r = await sheet(await fetchFile(admin, '/reports/outstanding-balances'));
    expect(r.header).toEqual(['Patient', 'Quote', 'Status', 'Price', 'Paid', 'Remaining']);
    expect(r.body.slice(0, 2)).toEqual([['Pat Patient', 'Crown', 'accepted', 900, 100, 800], ['Ext Pat', 'Crown', 'accepted', 300, 0, 300]]);
    expect(r.body[2]![0]).toBe('Total');
    expect(r.body[2]!.slice(3)).toEqual(['=SUM(D4:D5)', '=SUM(E4:E5)', '=SUM(F4:F5)']);
  });

  it('shows a doctor only his own patients’ balances', async () => {
    await quote(s.patientId, 400);
    await quote(extPatient, 300);
    expect((await sheet(await fetchFile(aya, '/reports/outstanding-balances'))).body[0]![0]).toBe('Pat Patient');
    const theirs = await sheet(await fetchFile(ext, '/reports/outstanding-balances'));
    expect(theirs.body[0]![0]).toBe('Ext Pat');
    expect(theirs.body).toHaveLength(2); // one row and the total
  });

  it('as a PDF', async () => {
    await quote(s.patientId, 400);
    const text = words(await fetchFile(admin, '/reports/outstanding-balances?format=pdf'));
    for (const part of ['Outstanding balances', 'Pat Patient', '$400.00']) expect(text, part).toContain(part);
  });
});

describe('appointments, procedures and new patients (Excel)', () => {
  it('lists appointments of the period with their procedures, filtered by doctor and status', async () => {
    const a = await visit(s.patientId, s.doctorId, '2026-10-02', '09:00', 'completed');
    await visit(s.patientId, s.doctorId, '2026-10-03', '10:00', 'cancelled');
    await visit(extPatient, s.externalDoctorId, '2026-10-04', '11:00');
    await visit(s.patientId, s.doctorId, '2026-11-02', '09:00'); // outside the period
    await t.db('appointment_category').insert({ appointment_id: a, category_id: s.categoryIds[0], ...stamp });
    const all = await sheet(await fetchFile(admin, '/reports/appointments?from=2026-10-01&to=2026-10-31'));
    expect(all.header).toEqual(['Date', 'Time', 'Patient', 'Doctor', 'Clinic', 'Dental unit', 'Status', 'Minutes', 'Procedures']);
    expect(all.body.map((r) => [r[0], r[2]])).toEqual([['2026-10-02', 'Pat Patient'], ['2026-10-03', 'Pat Patient'], ['2026-10-04', 'Ext Pat']]);
    expect(all.body[0]![8]).toBeTruthy();
    expect((await sheet(await fetchFile(admin, `/reports/appointments?from=2026-10-01&to=2026-10-31&doctorId=${s.externalDoctorId}`))).body).toHaveLength(1);
    expect((await sheet(await fetchFile(admin, '/reports/appointments?from=2026-10-01&to=2026-10-31&status=completed'))).body).toHaveLength(1);
    expect((await sheet(await fetchFile(aya, '/reports/appointments?from=2026-10-01&to=2026-10-31'))).body.map((r) => r[2])).toEqual(['Pat Patient', 'Pat Patient']); // her own patients only
    expect((await sheet(await fetchFile(ext, '/reports/appointments?from=2026-10-01&to=2026-10-31'))).body.map((r) => r[2])).toEqual(['Ext Pat']);
  });

  it('counts procedures, apart from the visits that were cancelled or missed', async () => {
    const [c1, c2] = s.categoryIds;
    const link = (id: number, c: number) => t.db('appointment_category').insert({ appointment_id: id, category_id: c, ...stamp });
    await link(await visit(s.patientId, s.doctorId, '2026-10-02', '09:00', 'completed'), c1!);
    await link(await visit(s.patientId, s.doctorId, '2026-10-03', '09:00', 'confirmed'), c1!);
    await link(await visit(s.patientId, s.doctorId, '2026-10-04', '09:00', 'cancelled'), c1!);
    await link(await visit(s.patientId, s.doctorId, '2026-10-05', '09:00', 'no_show'), c2!);
    const r = await sheet(await fetchFile(admin, '/reports/procedures?from=2026-10-01&to=2026-10-31'));
    expect(r.header).toEqual(['Procedure', 'Booked or done', 'Completed', 'Cancelled or no-show']);
    expect(r.body[0]).toEqual([expect.any(String), 2, 1, 1]);
    expect(r.body[1]).toEqual([expect.any(String), 0, 0, 1]);
    expect((await sheet(await fetchFile(ext, '/reports/procedures?from=2026-10-01&to=2026-10-31'))).body).toEqual([]); // none of his patients
  });

  it('lists new patients of the period with their primary doctor, and no phone numbers', async () => {
    const r = await sheet(await fetchFile(admin, '/reports/patients?from=2026-10-01&to=2026-10-31'));
    expect(r.header).toEqual(['Patient no.', 'Name', 'Gender', 'Date of birth', 'Primary doctor', 'Added', 'Last visit']);
    expect(r.body.map((row) => [row[1], row[5]])).toEqual([['Pat Patient', '2026-10-01'], ['Ext Pat', '2026-10-02']]);
    expect(JSON.stringify(r.body)).not.toMatch(/70111111|70999999/);
    expect((await sheet(await fetchFile(admin, '/reports/patients?from=2026-10-02&to=2026-10-02'))).body.map((row) => row[1])).toEqual(['Ext Pat']);
    expect((await sheet(await fetchFile(ext, '/reports/patients?from=2026-10-01&to=2026-10-31'))).body.map((row) => row[1])).toEqual(['Ext Pat']);
  });
});

describe('lab orders (Excel)', () => {
  const setup = async () => {
    const [lab] = await t.db('labs').insert({ name: 'Kadi Lab', phone: '1', ...stamp });
    const order = (patient_id: number, item: string, due_at: string, status: string, cost: number) => t.db('lab_orders').insert({ lab_id: lab, patient_id, item, cost, currency: '$', due_at, status, ...stamp });
    await order(s.patientId, 'Zirconia crown', '2026-10-01', 'sent', 85);
    await order(extPatient, 'Night guard', '2026-10-20', 'draft', 40);
    await order(s.patientId, 'Back already', '2026-10-02', 'received', 10);
    return lab!;
  };

  it('shows staff and admins every order with its cost and whether it is overdue', async () => {
    const lab = await setup();
    const r = await sheet(await fetchFile(staff, '/reports/lab-orders?from=2026-10-01&to=2026-10-31'));
    expect(r.header).toEqual(['Lab', 'Patient', 'Item', 'Tooth', 'Status', 'Sent', 'Due', 'Received', 'Overdue', 'Cost']);
    expect(r.body.slice(0, 3).map((row) => [row[2], row[8], row[9]])).toEqual([['Zirconia crown', 'Yes', 85], ['Back already', 'No', 10], ['Night guard', 'No', 40]]);
    expect(r.body[3]![9]).toBe('=SUM(J4:J6)');
    expect((await sheet(await fetchFile(admin, '/reports/lab-orders?from=2026-10-01&to=2026-10-31&status=sent'))).body.slice(0, 1).map((row) => row[2])).toEqual(['Zirconia crown']);
    await t.db('lab_orders').del();
    await t.db('labs').where({ id: lab }).del();
  });

  it('shows a doctor only his own patients’ orders, without the cost', async () => {
    const lab = await setup();
    const mine = await sheet(await fetchFile(aya, '/reports/lab-orders?from=2026-10-01&to=2026-10-31'));
    expect(mine.header).not.toContain('Cost');
    expect(mine.body.map((row) => row[2])).toEqual(['Zirconia crown', 'Back already']);
    expect(JSON.stringify([mine.header, mine.body])).not.toContain('85');
    expect((await sheet(await fetchFile(ext, '/reports/lab-orders?from=2026-10-01&to=2026-10-31'))).body.map((row) => row[2])).toEqual(['Night guard']);
    await t.db('lab_orders').del();
    await t.db('labs').where({ id: lab }).del();
  });
});

describe('every export is logged, without its content', () => {
  it('records who exported which report, in what format, for which period, and how many rows', async () => {
    await pay(await quote(s.patientId, 1000), 4321, '2026-10-02');
    await fetchFile(admin, '/reports/revenue?from=2026-10-01&to=2026-10-31&format=pdf');
    await fetchFile(aya, `/reports/daily-schedule?date=${TODAY}`);
    const rows = await t.db('audit_log').where({ action: 'report.export' }).orderBy('id');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entity: 'report', entity_id: 'revenue' });
    expect(JSON.parse(rows[0]!.diff)).toMatchObject({ format: 'pdf', from: '2026-10-01', to: '2026-10-31', groupBy: 'month', rows: 1 });
    expect(rows[1]).toMatchObject({ entity_id: 'daily-schedule' });
    expect(JSON.stringify(rows)).not.toMatch(/4321|Pat Patient/);
  });

  it('does not log a report that was refused', async () => {
    await fetchFile(staff, '/reports/revenue?from=2026-10-01&to=2026-10-31');
    await fetchFile(admin, '/reports/appointments?from=bad&to=worse');
    expect(await t.db('audit_log').where({ action: 'report.export' }).count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });
});

describe('big reports are made in the background', () => {
  const ctx = () => ({ db: t.db, env: t.env, logger: pino({ level: 'silent' }), clock: () => NOW });
  const url = '/reports/appointments?from=2026-10-01&to=2026-10-31';
  const ask = (c: Client, u = url) => c.agent.get(`/api/v1${u}`).redirects(0);
  const original = { ...REPORT_LIMITS };
  let uploads = '';
  const three = async () => { for (const time of ['09:00', '10:00', '11:00']) await visit(s.patientId, s.doctorId, '2026-10-02', time); };

  beforeEach(async () => {
    REPORT_LIMITS.sync = 2; // so three rows are "too many to wait for"
    REPORT_LIMITS.background = 50;
    await t.db('report_jobs').del();
    await t.db('notifications').del();
    if (uploads) await rm(uploads, { recursive: true, force: true });
    uploads = await mkdtemp(path.join(tmpdir(), 'aya-reports-')); // never the real uploads folder
    t.env.UPLOAD_DIR = uploads;
  });
  afterAll(async () => {
    Object.assign(REPORT_LIMITS, original);
    if (uploads) await rm(uploads, { recursive: true, force: true });
  });

  it('sends the person to the Reports page and makes the Excel file, which only they can download', async () => {
    await three();
    const res = await ask(aya);
    expect(res.status).toBe(303);
    const id = Number(/queued=(\d+)/.exec(res.headers.location!)![1]);
    expect(res.headers.location).toBe(`/reports?queued=${id}`);
    expect((await aya.get('/reports/jobs')).body.data[0]).toMatchObject({ id, report: 'appointments', status: 'queued', downloadUrl: null });

    expect(await runPendingReportJobs(ctx())).toBe(1);
    const job = (await aya.get('/reports/jobs')).body.data[0];
    expect(job).toMatchObject({ status: 'done', rows: 3, downloadUrl: `/api/v1/reports/jobs/${id}/file` });
    const file = await fetchFile(aya, `/reports/jobs/${id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['cache-control']).toContain('no-store');
    const sh = await sheet(file);
    expect(sh.body).toHaveLength(3);
    expect(sh.title).toMatch(/Appointments/);

    expect((await fetchFile(admin, `/reports/jobs/${id}/file`)).status).toBe(404); // not their report
    expect((await admin.get('/reports/jobs')).body.data).toEqual([]);
    expect((await staff.get('/reports/jobs')).body.data).toEqual([]);
    expect((await t.client().get(`/reports/jobs/${id}/file`)).status).toBe(401);
  });

  it('tells the person when it is ready, and logs the request, the export and the download without content', async () => {
    await three();
    const id = Number(/queued=(\d+)/.exec((await ask(aya)).headers.location!)![1]);
    await runPendingReportJobs(ctx());
    const ayaUser = (await t.db('users').where({ email: 'doctor@clinic.test' }).first('id')).id;
    const n = await t.db('notifications').where({ user_id: ayaUser }).first();
    expect(n).toMatchObject({ type: 'report.ready', title: 'Report ready', link: '/reports' });
    expect(n.content).toContain('3 rows');
    await fetchFile(aya, `/reports/jobs/${id}/file`);
    const actions = (await t.db('audit_log').whereIn('action', ['report.queue', 'report.export', 'report.download']).orderBy('id')).map((r) => r.action);
    expect(actions).toEqual(['report.queue', 'report.export', 'report.download']);
    expect(JSON.stringify(await t.db('audit_log'))).not.toMatch(/Pat Patient/);
  });

  it('refuses a PDF that is too big, and anything past the background limit', async () => {
    await three();
    expect((await ask(admin, '/reports/revenue?from=2026-10-01&to=2026-10-31&format=pdf')).status).toBe(200); // small: still made on the spot
    REPORT_LIMITS.background = 2;
    const res = await fetchFile(aya, url);
    expect(res.status).toBe(413);
    expect(res.body.toString()).toContain('TOO_MANY_ROWS');
  });

  it('allows three waiting reports per person', async () => {
    await three();
    for (let i = 0; i < 3; i++) expect((await ask(aya)).status).toBe(303);
    const fourth = await fetchFile(aya, url);
    expect(fourth.status).toBe(429);
    expect(await runPendingReportJobs(ctx())).toBe(3);
    expect((await ask(aya)).status).toBe(303); // room again
  });

  it('fails politely for someone who lost access, and deletes expired files', async () => {
    await three();
    const id = Number(/queued=(\d+)/.exec((await ask(aya)).headers.location!)![1]);
    await t.db('users').where({ email: 'doctor@clinic.test' }).update({ is_active: false });
    await runPendingReportJobs(ctx());
    await t.db('users').where({ email: 'doctor@clinic.test' }).update({ is_active: true });
    expect(await t.db('report_jobs').where({ id }).first()).toMatchObject({ status: 'failed', error: 'You no longer have access to this report.' });

    const again = Number(/queued=(\d+)/.exec((await ask(aya)).headers.location!)![1]);
    await runPendingReportJobs(ctx());
    const done = await t.db('report_jobs').where({ id: again }).first();
    const file = path.resolve(t.env.UPLOAD_DIR, 'reports', done.file_name);
    expect(existsSync(file)).toBe(true);
    await t.db('report_jobs').where({ id: again }).update({ expires_at: '2026-10-01 00:00:00' });
    expect(await cleanupReportJobs(ctx())).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect((await aya.get('/reports/jobs')).body.data.find((j: { id: number }) => j.id === again)).toBeUndefined();
    expect((await fetchFile(aya, `/reports/jobs/${again}/file`)).status).toBe(409);
  });

  it('does not run twice for the same job', async () => {
    await three();
    const id = Number(/queued=(\d+)/.exec((await ask(aya)).headers.location!)![1]);
    await Promise.all([runReportJob(ctx(), id), runReportJob(ctx(), id)]);
    expect(await t.db('report_jobs').where({ id }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
    expect((await t.db('report_jobs').where({ id }).first()).status).toBe('done');
    expect(readdirSync(path.resolve(t.env.UPLOAD_DIR, 'reports'))).toHaveLength(1);
  });
});
