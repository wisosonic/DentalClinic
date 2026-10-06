import type { OfferAction, OfferDto, Paginated } from '@aya/shared';
import { api } from '../auth/authApi';

const qs = (params: object = {}) => ({
  params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== false)) as Record<string, string | number>,
});
type Body = Record<string, unknown>;

export interface OfferListParams {
  page?: number;
  pageSize?: number;
  patientId?: number;
  status?: string;
  paymentState?: string;
  workState?: string;
  debt?: string;
  q?: string;
  sort?: 'patient' | 'title' | 'price' | 'paid' | 'remaining' | 'status' | 'progress' | 'created';
  order?: 'asc' | 'desc';
}

export const offersApi = api.injectEndpoints({
  endpoints: (build) => ({
    listOffers: build.query<Paginated<OfferDto>, OfferListParams>({
      query: (p) => ({ url: '/treatment-offers', ...qs(p) }),
      providesTags: ['Offer'],
    }),
    getOffer: build.query<OfferDto, number>({
      query: (id) => `/treatment-offers/${id}`,
      transformResponse: (r: { offer: OfferDto }) => r.offer,
      providesTags: ['Offer'],
    }),
    createOffer: build.mutation<OfferDto, Body>({
      query: (body) => ({ url: '/treatment-offers', method: 'POST', body }),
      transformResponse: (r: { offer: OfferDto }) => r.offer,
      invalidatesTags: ['Offer'],
    }),
    updateOffer: build.mutation<OfferDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/treatment-offers/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { offer: OfferDto }) => r.offer,
      invalidatesTags: ['Offer'],
    }),
    setOfferItems: build.mutation<OfferDto, { id: number; items: Body[] }>({
      query: ({ id, items }) => ({ url: `/treatment-offers/${id}/items`, method: 'PUT', body: { items } }),
      transformResponse: (r: { offer: OfferDto }) => r.offer,
      invalidatesTags: ['Offer', 'Payment'], // the price follows the items, so the balances do too
    }),
    offerAction: build.mutation<OfferDto, { id: number; action: OfferAction }>({
      query: ({ id, action }) => ({ url: `/treatment-offers/${id}/${action}`, method: 'POST', body: {} }),
      transformResponse: (r: { offer: OfferDto }) => r.offer,
      invalidatesTags: ['Offer'],
    }),
    scheduleOfferItem: build.mutation<{ offer: OfferDto; appointmentId: number }, { id: number; itemId: number; body: Body }>({
      query: ({ id, itemId, body }) => ({ url: `/treatment-offers/${id}/items/${itemId}/schedule`, method: 'POST', body }),
      invalidatesTags: ['Offer', 'Appointment'],
    }),
    markOfferItemDone: build.mutation<OfferDto, { id: number; itemId: number }>({
      query: ({ id, itemId }) => ({ url: `/treatment-offers/${id}/items/${itemId}/done`, method: 'POST' }),
      transformResponse: (r: { offer: OfferDto }) => r.offer,
      invalidatesTags: ['Offer'],
    }),
    deleteOffer: build.mutation<void, number>({
      query: (id) => ({ url: `/treatment-offers/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Offer', 'Payment', 'Trash'],
    }),
  }),
});

export const {
  useListOffersQuery, useGetOfferQuery, useCreateOfferMutation, useUpdateOfferMutation, useSetOfferItemsMutation, useOfferActionMutation,
  useScheduleOfferItemMutation, useMarkOfferItemDoneMutation, useDeleteOfferMutation,
} = offersApi;
