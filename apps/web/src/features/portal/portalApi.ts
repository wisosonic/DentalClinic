import type { PortalAppointmentDto, PortalDocumentDto, PortalOfferDto, PortalOverviewDto, PortalPaymentDto } from '@aya/shared';
import { api } from '../auth/authApi';

/** The patient portal: a patient's own record, read only. Refreshes whenever an appointment, offer, payment or document changes. */
export const portalApi = api.injectEndpoints({
  endpoints: (build) => ({
    getPortalOverview: build.query<PortalOverviewDto, void>({
      query: () => '/portal/overview',
      providesTags: ['Appointment', 'Offer', 'Payment', 'Document'],
    }),
    getPortalUpcoming: build.query<PortalAppointmentDto[], void>({
      query: () => '/portal/upcoming',
      transformResponse: (r: { data: PortalAppointmentDto[] }) => r.data,
      providesTags: ['Appointment'],
    }),
    getPortalOffers: build.query<PortalOfferDto[], void>({
      query: () => '/portal/offers',
      transformResponse: (r: { data: PortalOfferDto[] }) => r.data,
      providesTags: ['Offer', 'Payment', 'Appointment'],
    }),
    getPortalPayments: build.query<PortalPaymentDto[], void>({
      query: () => '/portal/payments',
      transformResponse: (r: { data: PortalPaymentDto[] }) => r.data,
      providesTags: ['Payment'],
    }),
    getPortalDocuments: build.query<PortalDocumentDto[], void>({
      query: () => '/portal/documents',
      transformResponse: (r: { data: PortalDocumentDto[] }) => r.data,
      providesTags: ['Document'],
    }),
  }),
});

export const { useGetPortalOverviewQuery, useGetPortalUpcomingQuery, useGetPortalOffersQuery, useGetPortalPaymentsQuery, useGetPortalDocumentsQuery } = portalApi;
