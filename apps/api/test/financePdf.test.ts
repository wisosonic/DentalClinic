import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, TODAY, buildTestApp, loggedIn, seedClinic, type Client, type Seed, type TestApp } from './helpers';

/** Offer and receipt PDFs (English only). Test builds are not compressed, so the text can be read from the bytes. */
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
  for (const table of ['payments', 'offer_items', 'treatment_offers', 'audit_log']) await t.db(table).del();
});

const pdf = (c: Client, url: string) => c.agent.get(`/api/v1${url}`).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (d: Buffer) => chunks.push(d));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
/** The words on the page. pdfkit stores text as hex pieces inside TJ arrays (kerning splits words), so join the pieces back. */
const text = (res: { body: unknown }) => {
  const raw = (res.body as Buffer).toString('latin1');
  const lines: string[] = [raw.slice(0, 8)]; // keeps the %PDF marker
  for (const arr of raw.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    lines.push([...arr[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1')).join(''));
  }
  return lines.join('\n');
};

async function make(patientId = s.patientId, extra: object = {}) {
  const quote = (await t.db('treatment_offers').insert({ title: 'Zirconia crown', description: 'Upper left molar', type: 'clinic', price: 480, cost: 123.45, currency: '$', status: 'accepted', patient_id: patientId, ...stamp, ...extra }))[0]!;
  await t.db('offer_items').insert({ offer_id: quote, description: 'Zirconia crown', price: 480, cost: 123.45, sequence: 1, status: 'pending', ...stamp });
  return quote;
}
const payment = async (quote: number, extra: object = {}) =>
  (await t.db('payments').insert({ date: TODAY, type: 'clinic', amount: 100, remaining: 380, currency: '$', method: 'card', description: 'First instalment', offer_id: quote, collected_by_doctor_id: s.doctorId, dr_part: 100, created_by: 1, ...stamp, ...extra }))[0]!;

describe('offer PDF', () => {
  it('is a PDF with the clinic, patient, items and total, and never the clinic’s cost', async () => {
    const q = await make();
    const res = await pdf(admin, `/treatment-offers/${q}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="offer-\d+-Patient\.pdf"$/);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = text(res);
    expect(body.startsWith('%PDF')).toBe(true);
    for (const part of ['Test Clinic', 'Treatment offer', `T-${q}`, 'Pat Patient', 'Zirconia crown', 'Upper left molar', '$480.00', 'Total']) expect(body, part).toContain(part);
    expect(body).not.toContain('123.45'); // the cost is internal
    expect(body).not.toContain('Paid so far'); // nothing paid yet
  });

  it('shows what has been paid and the balance once there are payments', async () => {
    const q = await make();
    await payment(q, { amount: 150.5 });
    const body = text(await pdf(aya, `/treatment-offers/${q}/pdf`));
    for (const part of ['Paid so far', '$150.50', 'Balance', '$329.50']) expect(body, part).toContain(part);
  });

  it('lists every item with its price and tooth', async () => {
    const q = await make();
    await t.db('offer_items').insert({ offer_id: q, description: 'Whitening', price: 80, sequence: 2, status: 'pending', ...stamp });
    await t.db('treatment_offers').where({ id: q }).update({ price: 560 });
    const body = text(await pdf(admin, `/treatment-offers/${q}/pdf`));
    for (const part of ['1. Zirconia crown', '2. Whitening', '$80.00', '$560.00']) expect(body, part).toContain(part);
  });

  it('is for the patient’s own doctor, admins and staff: another doctor gets 404, patients are refused', async () => {
    const others = await make(s.otherPatientId); // the patient has no primary doctor, so Aya is not theirs
    expect((await pdf(aya, `/treatment-offers/${others}/pdf`)).status).toBe(404);
    expect((await pdf(admin, `/treatment-offers/${others}/pdf`)).status).toBe(200);
    const mine = await make();
    expect((await pdf(aya, `/treatment-offers/${mine}/pdf`)).status).toBe(200);
    expect((await pdf(staff, `/treatment-offers/${mine}/pdf`)).status).toBe(200);
    expect((await pdf(patient, `/treatment-offers/${mine}/pdf`)).status).toBe(403);
    expect((await pdf(t.client(), `/treatment-offers/${mine}/pdf`)).status).toBe(401);
    expect((await pdf(admin, '/treatment-offers/99999/pdf')).status).toBe(404);
  });

  it('is not available for a deleted offer, and the download is logged without content', async () => {
    const q = await make();
    await pdf(admin, `/treatment-offers/${q}/pdf`);
    const entry = await t.db('audit_log').where({ action: 'offer.pdf' }).first();
    expect(entry).toMatchObject({ entity: 'offer', entity_id: String(q) });
    expect(JSON.stringify(entry)).not.toContain('Zirconia');
    await t.db('treatment_offers').where({ id: q }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await pdf(admin, `/treatment-offers/${q}/pdf`)).status).toBe(404);
  });
});

describe('receipt PDF', () => {
  it('is a PDF with the amount, method, quote, who received it and the balance after', async () => {
    const q = await make();
    const p = await payment(q);
    const res = await pdf(admin, `/payments/${p}/receipt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="receipt-${p}.pdf"`);
    const body = text(res);
    expect(body.startsWith('%PDF')).toBe(true);
    for (const part of ['Test Clinic', 'Payment receipt', `R-${p}`, 'Pat Patient', 'Zirconia crown', 'Card', 'Dr Aya', '$100.00', '$380.00', 'First instalment', 'Amount received', 'Balance after']) {
      expect(body, part).toContain(part);
    }
    expect(body).not.toContain('123.45'); // no clinic cost
  });

  it('shows a balance of zero, not a negative one, for an old overpaid quote', async () => {
    const q = await make();
    const p = await payment(q, { remaining: -10 });
    expect(text(await pdf(admin, `/payments/${p}/receipt`))).toContain('$0.00');
  });

  it('lets staff print only the receipts of payments they entered, and a doctor only his own patients’', async () => {
    const q = await make();
    const staffId = (await t.db('users').where({ email: 'staff@clinic.test' }).first('id')).id;
    const mine = await payment(q, { created_by: staffId });
    const notMine = await payment(q, { created_by: 999 });
    expect((await pdf(staff, `/payments/${mine}/receipt`)).status).toBe(200);
    expect((await pdf(staff, `/payments/${notMine}/receipt`)).status).toBe(404);
    expect((await pdf(aya, `/payments/${mine}/receipt`)).status).toBe(200);
    const others = await make(s.otherPatientId);
    const theirs = await payment(others);
    expect((await pdf(aya, `/payments/${theirs}/receipt`)).status).toBe(404);
  });

  it('is refused for patients and signed-out visitors, 404 for something that is not there, and is logged', async () => {
    const q = await make();
    const p = await payment(q);
    expect((await pdf(patient, `/payments/${p}/receipt`)).status).toBe(403);
    expect((await pdf(t.client(), `/payments/${p}/receipt`)).status).toBe(401);
    expect((await pdf(admin, '/payments/99999/receipt')).status).toBe(404);
    await pdf(admin, `/payments/${p}/receipt`);
    expect(await t.db('audit_log').where({ action: 'payment.receipt', entity_id: String(p) }).first()).toBeTruthy();
  });

  it('has no receipt for a deleted payment or a commission payment', async () => {
    const q = await make();
    const p = await payment(q);
    await t.db('payments').where({ id: p }).update({ deleted_at: '2026-10-01 00:00:00' });
    expect((await pdf(admin, `/payments/${p}/receipt`)).status).toBe(404);
    const commission = (await t.db('payments').insert({ date: TODAY, type: 'commission', amount: 20, currency: '$', offer_id: null, dr_part: 100, ...stamp }))[0]!;
    expect((await pdf(admin, `/payments/${commission}/receipt`)).status).toBe(404);
  });
});

describe('the activity log', () => {
  it('counts a downloaded document as a view, not a change', async () => {
    const q = await make();
    const p = await payment(q);
    await pdf(admin, `/treatment-offers/${q}/pdf`);
    await pdf(admin, `/payments/${p}/receipt`);
    const views = (await admin.get('/audit-log?kind=views')).body.data.map((r: { action: string }) => r.action);
    expect(views).toEqual(expect.arrayContaining(['offer.pdf', 'payment.receipt']));
    const changes = (await admin.get('/audit-log?kind=changes')).body.data.map((r: { action: string }) => r.action);
    expect(changes).not.toContain('offer.pdf');
    expect(changes).not.toContain('payment.receipt');
  });
});
