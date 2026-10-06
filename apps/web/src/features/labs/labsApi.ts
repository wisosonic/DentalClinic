import type { DirectoryDto, LabAction, LabOrderDto, Paginated } from '@aya/shared';
import { api } from '../auth/authApi';

const qs = (params: object = {}) => ({
  params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== false)) as Record<string, string | number>,
});
type Body = Record<string, unknown>;

export interface LabOrderListParams { page?: number; pageSize?: number; labId?: number; patientId?: number; status?: string; overdue?: boolean; q?: string }
export type DirectoryKind = 'labs' | 'suppliers';

export const labsApi = api.injectEndpoints({
  endpoints: (build) => ({
    // ----- lab orders -----
    listLabOrders: build.query<Paginated<LabOrderDto>, LabOrderListParams>({
      query: (p) => ({ url: '/lab-orders', ...qs(p) }),
      providesTags: ['LabOrder'],
    }),
    createLabOrder: build.mutation<LabOrderDto, Body>({
      query: (body) => ({ url: '/lab-orders', method: 'POST', body }),
      transformResponse: (r: { order: LabOrderDto }) => r.order,
      invalidatesTags: ['LabOrder'],
    }),
    updateLabOrder: build.mutation<LabOrderDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/lab-orders/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { order: LabOrderDto }) => r.order,
      invalidatesTags: ['LabOrder'],
    }),
    labOrderAction: build.mutation<LabOrderDto, { id: number; action: LabAction }>({
      query: ({ id, action }) => ({ url: `/lab-orders/${id}/${action}`, method: 'POST' }),
      transformResponse: (r: { order: LabOrderDto }) => r.order,
      invalidatesTags: ['LabOrder'],
    }),
    deleteLabOrder: build.mutation<void, number>({
      query: (id) => ({ url: `/lab-orders/${id}`, method: 'DELETE' }),
      invalidatesTags: ['LabOrder', 'Trash'],
    }),

    // ----- labs and suppliers -----
    listDirectory: build.query<DirectoryDto[], DirectoryKind>({
      query: (kind) => ({ url: `/${kind}`, params: { full: 1 } }),
      transformResponse: (r: { data: DirectoryDto[] }) => r.data,
      providesTags: ['Directory'],
    }),
    createDirectoryEntry: build.mutation<DirectoryDto, { kind: DirectoryKind; body: Body }>({
      query: ({ kind, body }) => ({ url: `/${kind}`, method: 'POST', body }),
      transformResponse: (r: { entry: DirectoryDto }) => r.entry,
      invalidatesTags: ['Directory'],
    }),
    updateDirectoryEntry: build.mutation<DirectoryDto, { kind: DirectoryKind; id: number; body: Body }>({
      query: ({ kind, id, body }) => ({ url: `/${kind}/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { entry: DirectoryDto }) => r.entry,
      invalidatesTags: ['Directory'],
    }),
    deleteDirectoryEntry: build.mutation<void, { kind: DirectoryKind; id: number }>({
      query: ({ kind, id }) => ({ url: `/${kind}/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Directory'],
    }),
  }),
});

export const {
  useListLabOrdersQuery, useCreateLabOrderMutation, useUpdateLabOrderMutation, useLabOrderActionMutation, useDeleteLabOrderMutation,
  useListDirectoryQuery, useCreateDirectoryEntryMutation, useUpdateDirectoryEntryMutation, useDeleteDirectoryEntryMutation,
} = labsApi;
