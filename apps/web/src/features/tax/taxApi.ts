import type { IncomeTaxDto, TaxDeclarationDto, TaxRuleSetDto, TaxSettings } from '@aya/shared';
import { api } from '../auth/authApi';

export interface TaxRules {
  /** Every saved set, newest year first. */
  sets: TaxRuleSetDto[];
  /** The owner's starting values, to begin a new set from when none is saved. */
  defaults: TaxSettings;
}

export const taxApi = api.injectEndpoints({
  endpoints: (build) => ({
    incomeTax: build.query<IncomeTaxDto, { year: number; doctorId?: number }>({
      query: ({ year, doctorId }) => ({ url: '/finance/tax', params: { year, ...(doctorId ? { doctorId } : {}) } }),
      providesTags: ['Tax', 'Payment', 'Doctor'],
    }),
    declareTaxYear: build.mutation<{ declaration: TaxDeclarationDto; declaredYears: number[] }, Record<string, unknown>>({
      query: (body) => ({ url: '/finance/tax/declare', method: 'POST', body }),
      invalidatesTags: ['Tax'],
    }),
    reopenTaxYear: build.mutation<{ declaredYears: number[] }, Record<string, unknown>>({
      query: (body) => ({ url: '/finance/tax/reopen', method: 'POST', body }),
      invalidatesTags: ['Tax'],
    }),
    taxRules: build.query<TaxRules, void>({
      query: () => '/settings/tax',
      providesTags: ['Tax'],
    }),
    saveTaxRules: build.mutation<TaxRules, { year: number; body: Record<string, unknown> }>({
      query: ({ year, body }) => ({ url: `/settings/tax/${year}`, method: 'PUT', body }),
      invalidatesTags: ['Tax'],
    }),
    deleteTaxRules: build.mutation<TaxRules, number>({
      query: (year) => ({ url: `/settings/tax/${year}`, method: 'DELETE' }),
      invalidatesTags: ['Tax'],
    }),
  }),
});

export const { useIncomeTaxQuery, useDeclareTaxYearMutation, useReopenTaxYearMutation, useTaxRulesQuery, useSaveTaxRulesMutation, useDeleteTaxRulesMutation } = taxApi;
