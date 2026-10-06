import type {
  CommissionPaymentDto, CommissionStatementDto, DirectoryEntryDto, ExpenseDto, DoctorFiguresResponse, FinanceSummaryDto, OpenOfferDto, Paginated, PaymentDto,
} from '@aya/shared';
import { api } from '../auth/authApi';

const qs = (params: object = {}) => ({
  params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string | number>,
});
type Body = Record<string, unknown>;

export interface PaymentListParams {
  page?: number;
  pageSize?: number;
  offerId?: number;
  patientId?: number;
  method?: string;
  from?: string;
  to?: string;
  q?: string;
  sort?: 'date' | 'patient' | 'amount' | 'method' | 'offer';
  order?: 'asc' | 'desc';
}

export interface ExpenseListParams {
  page?: number;
  pageSize?: number;
  type?: string;
  from?: string;
  to?: string;
  q?: string;
  sort?: 'date' | 'type' | 'amount' | 'description';
  order?: 'asc' | 'desc';
}

export const financeApi = api.injectEndpoints({
  endpoints: (build) => ({
    financeSummary: build.query<FinanceSummaryDto, { from?: string; to?: string }>({
      query: (p) => ({ url: '/finance/summary', ...qs(p) }),
      providesTags: ['Payment', 'Expense', 'Offer'],
    }),
    doctorFigures: build.query<DoctorFiguresResponse, { from?: string; to?: string }>({
      query: (p) => ({ url: '/finance/doctors', ...qs(p) }),
      providesTags: ['Payment', 'Offer', 'Expense', 'Commission'],
    }),
    listPayments: build.query<Paginated<PaymentDto>, PaymentListParams>({
      query: (p) => ({ url: '/payments', ...qs(p) }),
      providesTags: ['Payment'],
    }),
    myPayments: build.query<PaymentDto[], void>({
      query: () => '/payments/mine',
      transformResponse: (r: { data: PaymentDto[] }) => r.data,
      providesTags: ['Payment'],
    }),
    openOffers: build.query<OpenOfferDto[], number>({
      query: (patientId) => ({ url: '/payments/open-offers', ...qs({ patientId }) }),
      transformResponse: (r: { data: OpenOfferDto[] }) => r.data,
      providesTags: ['Offer', 'Payment'],
    }),
    createPayment: build.mutation<PaymentDto, Body>({
      query: (body) => ({ url: '/payments', method: 'POST', body }),
      transformResponse: (r: { payment: PaymentDto }) => r.payment,
      invalidatesTags: ['Payment', 'Offer'],
    }),
    updatePayment: build.mutation<PaymentDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/payments/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { payment: PaymentDto }) => r.payment,
      invalidatesTags: ['Payment', 'Offer'],
    }),
    deletePayment: build.mutation<void, number>({
      query: (id) => ({ url: `/payments/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Payment', 'Offer', 'Trash', 'Commission'],
    }),

    listExpenses: build.query<Paginated<ExpenseDto> & { sum: number }, ExpenseListParams>({
      query: (p) => ({ url: '/expenses', ...qs(p) }),
      providesTags: ['Expense'],
    }),
    createExpense: build.mutation<ExpenseDto, Body>({
      query: (body) => ({ url: '/expenses', method: 'POST', body }),
      transformResponse: (r: { expense: ExpenseDto }) => r.expense,
      invalidatesTags: ['Expense', 'Commission'],
    }),
    updateExpense: build.mutation<ExpenseDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/expenses/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { expense: ExpenseDto }) => r.expense,
      invalidatesTags: ['Expense', 'Commission'],
    }),
    deleteExpense: build.mutation<void, number>({
      query: (id) => ({ url: `/expenses/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Expense', 'Commission', 'Trash'],
    }),
    commissionAppointments: build.query<{ id: number; date: string; time: string; patient: { fname: string; lname: string } }[], number>({
      query: (doctorId) => ({ url: '/expenses/commission-appointments', ...qs({ doctorId }) }),
      transformResponse: (r: { data: { id: number; date: string; time: string; patient: { fname: string; lname: string } }[] }) => r.data,
    }),
    labs: build.query<DirectoryEntryDto[], void>({ query: () => '/labs', transformResponse: (r: { data: DirectoryEntryDto[] }) => r.data, providesTags: ['Directory'] }),
    suppliers: build.query<DirectoryEntryDto[], void>({ query: () => '/suppliers', transformResponse: (r: { data: DirectoryEntryDto[] }) => r.data, providesTags: ['Directory'] }),

    commissionStatement: build.query<CommissionStatementDto, { from?: string; to?: string }>({
      query: (p) => ({ url: '/commission/statement', ...qs(p) }),
      providesTags: ['Commission', 'Payment', 'Expense'],
    }),
    commissionPayments: build.query<CommissionPaymentDto[], { from?: string; to?: string }>({
      query: (p) => ({ url: '/commission/payments', ...qs(p) }),
      transformResponse: (r: { data: CommissionPaymentDto[] }) => r.data,
      providesTags: ['Commission'],
    }),
    createCommissionPayment: build.mutation<CommissionPaymentDto, Body>({
      query: (body) => ({ url: '/commission/payments', method: 'POST', body }),
      transformResponse: (r: { payment: CommissionPaymentDto }) => r.payment,
      invalidatesTags: ['Commission'],
    }),
    updateCommissionPayment: build.mutation<CommissionPaymentDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/commission/payments/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { payment: CommissionPaymentDto }) => r.payment,
      invalidatesTags: ['Commission'],
    }),
    deleteCommissionPayment: build.mutation<void, number>({
      query: (id) => ({ url: `/commission/payments/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Commission', 'Trash'],
    }),
  }),
});

export const {
  useDoctorFiguresQuery,
  useFinanceSummaryQuery,
  useListPaymentsQuery,
  useMyPaymentsQuery,
  useOpenOffersQuery,
  useCreatePaymentMutation,
  useUpdatePaymentMutation,
  useDeletePaymentMutation,
  useListExpensesQuery,
  useCreateExpenseMutation,
  useUpdateExpenseMutation,
  useDeleteExpenseMutation,
  useCommissionAppointmentsQuery,
  useLabsQuery,
  useSuppliersQuery,
  useCommissionStatementQuery,
  useCommissionPaymentsQuery,
  useCreateCommissionPaymentMutation,
  useUpdateCommissionPaymentMutation,
  useDeleteCommissionPaymentMutation,
} = financeApi;
