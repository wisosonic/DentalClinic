import { Router } from 'express';
import { z } from 'zod';
import { calculateIncomeTax, taxDeclareSchema, taxReopenSchema, type IncomeTaxDto, type TaxDeclarationDto } from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, notFound } from '../../lib/errors';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { audit } from '../audit/audit';
import { contactOverride } from '../settings/app';
import { loadTaxSettings } from '../settings/tax';
import { renderTaxPdf } from './taxPdf';
import { round2 } from './service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row
/** The figures of a year as they are now; the declaration fields are filled in separately. */
type Live = Omit<IncomeTaxDto, 'declaration' | 'drift' | 'declaredYears'>;

/** Payments are only ever stored in US dollars, converted at the admin's rate. A row in any other currency (there should be none) has no rate: it is listed and left out. */
const USD = ['$', 'USD'];

const query = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  doctorId: z.coerce.number().int().positive().optional(),
  /** Overrides the doctor's saved family details, for trying another situation. */
  spouse: z.enum(['0', '1', 'true', 'false']).optional(),
  children: z.coerce.number().int().min(0).max(30).optional(),
});

const scopeOf = (doctorId: number | null | undefined) => (doctorId ? `doctor:${doctorId}` : 'clinic');

/** The year's payments for a taxpayer, the rules that apply and the result, from the books as they are now. */
async function computeTax(db: Db, year: number, doctorId: number | null, family: { spouse?: boolean; children?: number }): Promise<Live> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const doctor: Row | null = doctorId ? ((await db('doctors').where({ id: doctorId }).first('id', 'fname', 'lname', 'tax_spouse', 'tax_children')) ?? null) : null;
  if (doctorId && !doctor) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');

  const base = () => db('payments as pay').whereNull('pay.deleted_at').whereBetween('pay.date', [from, to]);
  const own = (qb: any) => { if (doctor) qb.where('pay.collected_by_doctor_id', doctor.id); }; // eslint-disable-line @typescript-eslint/no-explicit-any -- Knex builder
  const clinic: Row[] = await base().join('treatment_offers as q', 'q.id', 'pay.offer_id').join('patients as p', 'p.id', 'q.patient_id')
    .where('pay.type', 'clinic').whereNull('q.deleted_at').whereNull('p.deleted_at').modify(own)
    .select('pay.currency').sum({ total: 'pay.amount' }).count({ n: '*' }).groupBy('pay.currency');
  const commission: Row[] = await base().where('pay.type', 'commission').modify(own)
    .select('pay.currency').sum({ total: 'pay.amount' }).count({ n: '*' }).groupBy('pay.currency');

  const split = (rows: Row[]) => {
    const usd = rows.filter((r) => USD.includes(r.currency));
    return {
      total: round2(usd.reduce((s, r) => s + Number(r.total), 0)),
      count: usd.reduce((s, r) => s + Number(r.n), 0),
      other: rows.filter((r) => !USD.includes(r.currency)),
    };
  };
  const c = split(clinic);
  const m = split(commission);
  const excludedBy = new Map<string, { currency: string; total: number; count: number }>();
  for (const r of [...c.other, ...m.other]) {
    const cur = excludedBy.get(r.currency) ?? { currency: r.currency, total: 0, count: 0 };
    cur.total = round2(cur.total + Number(r.total));
    cur.count += Number(r.n);
    excludedBy.set(r.currency, cur);
  }

  const { settings, rulesFrom, usingDefaults } = await loadTaxSettings(db, year);
  const paymentsUsd = round2(c.total + m.total);
  // The doctor's saved family details are the starting point; the page may try others.
  const saved = { spouse: Boolean(doctor?.tax_spouse), children: Number(doctor?.tax_children ?? 0) };
  const input = { paymentsUsd, spouse: family.spouse ?? saved.spouse, children: family.children ?? saved.children };
  return {
    year, doctor: doctor ? { id: doctor.id, fname: doctor.fname, lname: doctor.lname } : null, family: saved,
    payments: { clinic: { total: c.total, count: c.count }, commission: { total: m.total, count: m.count }, totalUsd: paymentsUsd },
    excluded: [...excludedBy.values()], input, settings, rulesFrom, usingDefaults,
    result: calculateIncomeTax(input, settings),
  };
}

/**
 * Lebanese income tax estimate (admin only). The base is the year's payments, counted the way the Summary
 * counts them: clinic payments from patients plus commission received. Expenses are not deducted. For a
 * doctor it is what that doctor collected (and, for an owner, the commission paid over to him).
 *
 * Once a year is declared and paid for a taxpayer, the figures stored on that day are shown and the year is
 * never recalculated: laws change, and a past year keeps the numbers it was filed with.
 */
export function taxRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole('admin'));

  const currentYear = () => Number(clinicNow(env, ctx.clock()).date.slice(0, 4));
  const toDeclaration = async (row: Row): Promise<TaxDeclarationDto> => {
    const by = row.declared_by ? await db('users').where({ id: row.declared_by }).first('name') : null;
    return { id: row.id, declaredAt: row.created_at ?? null, paidDate: row.paid_date, note: row.note ?? null, declaredBy: by?.name ?? null, canReopen: row.year === currentYear() };
  };
  const declaredYears = async (scope: string): Promise<number[]> =>
    (await db('tax_declarations').where({ active_scope: scope }).orderBy('year', 'desc').select('year')).map((r: Row) => r.year as number);

  /** What the page and the PDF show: the stored copy of a declared year, otherwise the figures as they are now. */
  async function bodyFor(q: z.infer<typeof query>): Promise<{ body: IncomeTaxDto; declared: boolean }> {
    const scope = scopeOf(q.doctorId);
    const row: Row | undefined = await db('tax_declarations').where({ year: q.year, active_scope: scope }).first();
    let body: IncomeTaxDto;
    if (row) {
      // The stored copy, exactly as it was. Only whether the books have moved since is worked out now.
      const stored = JSON.parse(row.snapshot) as Live;
      const now = await computeTax(db, q.year, q.doctorId ?? null, {});
      const moved = now.input.paymentsUsd !== stored.input.paymentsUsd;
      body = {
        ...stored, declaration: await toDeclaration(row), declaredYears: await declaredYears(scope),
        drift: moved ? { paymentsUsd: now.input.paymentsUsd } : null,
      };
    } else {
      const live = await computeTax(db, q.year, q.doctorId ?? null, { spouse: q.spouse === undefined ? undefined : q.spouse === '1' || q.spouse === 'true', children: q.children });
      body = { ...live, declaration: null, drift: null, declaredYears: await declaredYears(scope) };
    }
    return { body, declared: Boolean(row) };
  }

  router.get('/tax', requirePermission('payments:read'), async (req, res) => {
    const user = requireUser(req);
    const q = query.parse(req.query);
    const { body, declared } = await bodyFor(q);
    // Who looked at the tax figures; never the figures themselves.
    await audit(ctx, req, { userId: user.id, action: 'tax.view', entity: 'tax', entityId: q.year, diff: { doctorId: q.doctorId ?? null, declared } });
    res.json(body);
  });

  /** The worksheet as a PDF. A declared year prints its stored copy; otherwise the figures the page was showing. */
  router.get('/tax/pdf', requirePermission('payments:read'), async (req, res) => {
    const user = requireUser(req);
    const q = query.parse(req.query);
    const { body, declared } = await bodyFor(q);
    const clinic = await db('clinics').orderBy('id').first('name', 'address', 'phone');
    const contact = await contactOverride(db);
    const pdf = await renderTaxPdf(body, { name: clinic?.name ?? 'Clinic', address: contact.address ?? clinic?.address ?? null, phone: contact.phone ?? clinic?.phone ?? null, email: contact.email ?? null }, { compress: env.NODE_ENV !== 'test' });
    await audit(ctx, req, { userId: user.id, action: 'tax.pdf', entity: 'tax', entityId: q.year, diff: { doctorId: q.doctorId ?? null, declared } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="income-tax-${q.year}${q.doctorId ? `-doctor-${q.doctorId}` : ''}.pdf"`);
    res.setHeader('Cache-Control', 'no-store'); // private figures: never kept by a cache
    res.send(pdf);
  });

  /** Marks the year as declared and paid, storing today's figures. There is no way back from here. */
  router.post('/tax/declare', requirePermission('settings:update'), async (req, res) => {
    const user = requireUser(req);
    const input = taxDeclareSchema.parse(req.body);
    const doctorId = input.doctorId ?? null;
    const scope = scopeOf(doctorId);
    const thisYear = Number(clinicNow(env, ctx.clock()).date.slice(0, 4));
    if (input.year > thisYear) throw badRequest('FUTURE_YEAR', 'A year that has not started cannot be declared');

    const live = await computeTax(db, input.year, doctorId, { spouse: input.spouse, children: input.children });
    const now = sqlNow();
    try {
      const [id] = await db('tax_declarations').insert({
        year: input.year, doctor_id: doctorId, scope, active_scope: scope, snapshot: JSON.stringify(live), tax_payable: live.result.taxPayable,
        paid_date: input.paidDate, note: input.note ?? null, declared_by: user.id, created_at: now, updated_at: now,
      });
      // Who and when, by year and taxpayer: the amount is in the stored copy, not in the log.
      await audit(ctx, req, { userId: user.id, action: 'tax.declare', entity: 'tax', entityId: input.year, diff: { doctorId, declarationId: id } });
    } catch (err) {
      if (/unique/i.test(String((err as Error).message))) throw new HttpError(409, 'ALREADY_DECLARED', 'This year is already declared and paid');
      throw err;
    }
    const row: Row = await db('tax_declarations').where({ year: input.year, active_scope: scope }).first();
    res.status(201).json({ declaration: await toDeclaration(row), declaredYears: await declaredYears(scope) });
  });

  /**
   * Reopens a declared year, so it is calculated live again. Only the current year: once a year is over, what
   * was filed stays as it was. The old declaration is kept, marked as voided, with who did it and when.
   */
  router.post('/tax/reopen', requirePermission('settings:update'), async (req, res) => {
    const user = requireUser(req);
    const input = taxReopenSchema.parse(req.body);
    const scope = scopeOf(input.doctorId ?? null);
    const row: Row | undefined = await db('tax_declarations').where({ year: input.year, active_scope: scope }).first();
    if (!row) throw notFound('This year is not declared');
    if (input.year !== currentYear()) throw new HttpError(409, 'YEAR_LOCKED', 'A past year cannot be reopened after it was declared');
    const now = sqlNow();
    await db('tax_declarations').where({ id: row.id }).update({ active_scope: null, voided_at: now, voided_by: user.id, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'tax.reopen', entity: 'tax', entityId: input.year, diff: { doctorId: input.doctorId ?? null, declarationId: row.id } });
    res.json({ declaredYears: await declaredYears(scope) });
  });

  return router;
}
