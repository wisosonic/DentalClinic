import type { DashboardChartsDto } from '@aya/shared';
import { api } from '../auth/authApi';

export const dashboardApi = api.injectEndpoints({
  endpoints: (build) => ({
    dashboardCharts: build.query<DashboardChartsDto, void>({
      query: () => '/dashboard/charts',
      // anything the figures are made of refreshes them
      providesTags: ['Appointment', 'Payment', 'Offer', 'Expense', 'LabOrder'],
    }),
  }),
});

export const { useDashboardChartsQuery } = dashboardApi;
