import { z } from 'zod';

/** A tax year. */
export const taxYearSchema = z.coerce.number().int('Enter a year').min(2000, 'Enter a year from 2000').max(2100, 'Enter a year up to 2100');

/**
 * Lebanese income tax estimate (owner rules, 2026-10-03). Everything is in Lebanese pounds (LBP), whole
 * pounds. The steps are exactly the owner's:
 *   a. payments received in the year (all in USD), converted to LBP
 *   b. 35% of that (the rate for dental services; a setting, because the law can change it)
 *   c. minus the family allowances
 *   d. never below zero
 *   e. the progressive brackets applied to that amount
 *   f. never below zero
 *   g. reported in LBP only
 * Expenses are not deducted. This is an estimate for the owners and their accountant, not a filing.
 */

/** The rate for dental services today. It is kept in the settings so a change of law is an edit, not a release. */
export const DEFAULT_TAX_PERCENTAGE = 35;

export interface TaxBracket {
  /** Lower edge in LBP, inclusive. The first bracket starts at 0. */
  from: number;
  /** Upper edge in LBP; null for the last bracket, which has no limit. */
  to: number | null;
  /** Percent, for example 4 for 4%. */
  rate: number;
}

export interface TaxAllowances {
  /** Everyone gets this one. */
  single: number;
  /** Added when the spouse is eligible. */
  spouse: number;
  /** Added for each eligible child. */
  child: number;
}

export interface TaxSettings {
  /** How many LBP one US dollar is worth. */
  usdToLbp: number;
  /** Percent of the payments that is taxed, before the allowances: 35 for dental services. */
  taxPercentage: number;
  allowances: TaxAllowances;
  brackets: TaxBracket[];
}

/** What the owner asked to start with, used until an admin saves their own in Settings. */
export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  usdToLbp: 89_500,
  taxPercentage: DEFAULT_TAX_PERCENTAGE,
  allowances: { single: 450_000_000, spouse: 225_000_000, child: 25_000_000 },
  brackets: [
    { from: 0, to: 540_000_000, rate: 4 },
    { from: 540_000_000, to: 1_440_000_000, rate: 7 },
    { from: 1_440_000_000, to: 3_240_000_000, rate: 12 },
    { from: 3_240_000_000, to: 6_240_000_000, rate: 16 },
    { from: 6_240_000_000, to: 13_500_000_000, rate: 21 },
    { from: 13_500_000_000, to: null, rate: 25 },
  ],
};

const lbp = z.coerce.number({ invalid_type_error: 'Enter an amount' }).finite('Enter an amount').min(0, 'Cannot be negative').max(1e15, 'That amount is too large');

export const taxSettingsSchema = z
  .object({
    usdToLbp: z.coerce.number({ invalid_type_error: 'Enter an exchange rate' }).finite('Enter an exchange rate').gt(0, 'The exchange rate must be above zero').max(1e7, 'That rate is too large'),
    taxPercentage: z.coerce.number({ invalid_type_error: 'Enter a percentage' }).finite('Enter a percentage').gt(0, 'The percentage must be above zero').max(100, 'The percentage cannot be above 100'),
    allowances: z.object({ single: lbp, spouse: lbp, child: lbp }),
    brackets: z
      .array(
        z.object({
          from: lbp,
          to: z.preprocess((v) => (v === '' || v === undefined ? null : v), lbp.nullable()),
          rate: z.coerce.number({ invalid_type_error: 'Enter a rate' }).finite('Enter a rate').min(0, 'The rate cannot be negative').max(100, 'The rate cannot be above 100'),
        }),
      )
      .min(1, 'Add at least one bracket')
      .max(20, 'Too many brackets'),
  })
  .superRefine((value, ctx) => {
    const { brackets } = value;
    brackets.forEach((b, i) => {
      const path = ['brackets', i];
      if (i === 0 && b.from !== 0) ctx.addIssue({ code: 'custom', path: [...path, 'from'], message: 'The first bracket must start at 0' });
      if (i > 0 && b.from !== brackets[i - 1]!.to) ctx.addIssue({ code: 'custom', path: [...path, 'from'], message: 'Each bracket must start where the one before it ends' });
      const last = i === brackets.length - 1;
      if (last && b.to !== null) ctx.addIssue({ code: 'custom', path: [...path, 'to'], message: 'The last bracket must have no upper limit' });
      if (!last && b.to === null) ctx.addIssue({ code: 'custom', path: [...path, 'to'], message: 'Only the last bracket can have no upper limit' });
      if (b.to !== null && b.to <= b.from) ctx.addIssue({ code: 'custom', path: [...path, 'to'], message: 'The upper limit must be above the lower limit' });
    });
  });
export type TaxSettingsInput = z.input<typeof taxSettingsSchema>;

export interface TaxInput {
  /** Payments received in the year in US dollars (converted at the rate). Payments are only ever stored in USD. */
  paymentsUsd: number;
  /** Is the spouse eligible for the spouse allowance? */
  spouse: boolean;
  /** Eligible children. */
  children: number;
}

export interface TaxBracketStep {
  from: number;
  to: number | null;
  rate: number;
  /** How much of the amount falls in this bracket. */
  amount: number;
  tax: number;
}

export interface TaxResult {
  /** a. total payments in LBP: the dollars converted at the rate */
  paymentsLbp: number;
  /** b. the tax percentage of it */
  taxablePart: number;
  /** c. the allowances, in total, and how each was reached */
  allowances: { total: number; single: number; spouse: number; children: number; childCount: number };
  /** d. what is left after the allowances, never below zero */
  amountAfterAllowances: number;
  /** e. the bracket steps */
  steps: TaxBracketStep[];
  /** f, g. the tax payable, in LBP, never below zero */
  taxPayable: number;
  /** Tax as a share of everything received, in percent, one decimal; 0 when nothing was received. */
  effectiveRate: number;
}

/** Whole pounds: LBP has no useful fraction at these amounts. */
const whole = (n: number) => Math.round(n);

/** The owner's calculation, step by step. Pure: the page shows it live and the server uses the very same function. */
export function calculateIncomeTax(input: TaxInput, settings: TaxSettings): TaxResult {
  const children = Math.max(0, Math.floor(input.children));
  const paymentsLbp = whole(Math.max(0, input.paymentsUsd) * settings.usdToLbp);
  const taxablePart = whole((paymentsLbp * settings.taxPercentage) / 100);
  const spouse = input.spouse ? settings.allowances.spouse : 0;
  const childrenTotal = children * settings.allowances.child;
  const allowanceTotal = settings.allowances.single + spouse + childrenTotal;
  const amountAfterAllowances = Math.max(0, taxablePart - allowanceTotal);

  const steps: TaxBracketStep[] = settings.brackets.map((b) => {
    const upper = b.to ?? Number.POSITIVE_INFINITY;
    const amount = Math.max(0, Math.min(amountAfterAllowances, upper) - b.from);
    return { from: b.from, to: b.to, rate: b.rate, amount, tax: whole((amount * b.rate) / 100) };
  });
  const taxPayable = Math.max(0, steps.reduce((sum, s) => sum + s.tax, 0));

  return {
    paymentsLbp,
    taxablePart,
    allowances: { total: allowanceTotal, single: settings.allowances.single, spouse, children: childrenTotal, childCount: children },
    amountAfterAllowances,
    steps,
    taxPayable,
    effectiveRate: paymentsLbp > 0 ? Math.round((taxPayable / paymentsLbp) * 1000) / 10 : 0,
  };
}

/** What `GET /finance/tax` answers. */
export interface IncomeTaxDto {
  year: number;
  /** The taxpayer: one doctor, or null for the whole clinic. */
  doctor: { id: number; fname: string; lname: string } | null;
  /** The doctor's saved family details (from his profile), the starting point on the page; none for the whole clinic. */
  family: { spouse: boolean; children: number };
  /**
   * Payments received in the year, as the Summary counts them (clinic payments and commission received):
   * the dollar ones in US dollars and the ones made in LBP in pounds, which are not converted.
   */
  payments: { clinic: { total: number; count: number }; commission: { total: number; count: number }; totalUsd: number };
  /** Payments in a currency that is neither USD nor LBP have no exchange rate: left out, listed so nothing is hidden. */
  excluded: { currency: string; total: number; count: number }[];
  /** What was calculated from: the payments and the family details chosen. */
  input: TaxInput;
  settings: TaxSettings;
  /** The year the rules in use apply from (the latest set saved for this year or before); null while the starting values are in use. */
  rulesFrom: number | null;
  /** True while no saved rules apply to this year: the owner's starting values are in use. */
  usingDefaults: boolean;
  result: TaxResult;
  /**
   * Set once the year was declared and paid for this taxpayer: everything above is then the stored copy, as it
   * was on that day, and is never recalculated.
   */
  declaration: TaxDeclarationDto | null;
  /** For a declared year: the payments recorded for the year now, when they differ from the stored ones. */
  drift: { paymentsUsd: number } | null;
  /** The years already declared for this taxpayer. */
  declaredYears: number[];
}

export interface TaxDeclarationDto {
  id: number;
  /** When it was marked as declared and paid, and the day the tax was paid. */
  declaredAt: string | null;
  paidDate: string;
  note: string | null;
  declaredBy: string | null;
  /** Only the current year can be reopened: once the year is over, its declaration stays as it was filed. */
  canReopen: boolean;
}

/** Marks a year as declared and paid. The figures are the server's, never sent by the page. */
export const taxDeclareSchema = z.object({
  year: taxYearSchema,
  doctorId: z.preprocess((v) => (v === '' || v === 0 ? null : v), z.coerce.number().int().positive().nullable().optional()),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the day it was paid'),
  note: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(1000).nullable().optional()),
  /** The family details the page was showing, which the stored copy keeps. */
  spouse: z.boolean(),
  children: z.coerce.number().int('Enter a whole number').min(0, 'Cannot be negative').max(30, 'That is too many'),
});
export type TaxDeclareInput = z.input<typeof taxDeclareSchema>;

/** Reopens a declared year (the current year only). */
export const taxReopenSchema = z.object({
  year: taxYearSchema,
  doctorId: z.preprocess((v) => (v === '' || v === 0 ? null : v), z.coerce.number().int().positive().nullable().optional()),
});



/** One saved set of rules: it applies from its year until a later set takes over. */
export interface TaxRuleSetDto {
  effectiveYear: number;
  settings: TaxSettings;
  updatedAt: string | null;
}


