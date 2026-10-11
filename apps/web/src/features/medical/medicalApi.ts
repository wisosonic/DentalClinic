import type { MedicalAlertsDto, MedicalHistoryDto, MedicalItemDto, MedicalItemInput, MedicalProfileDto, MedicalProfileInput } from '@aya/shared';
import { api } from '../auth/authApi';

export const medicalApi = api.injectEndpoints({
  endpoints: (build) => ({
    getMedicalHistory: build.query<MedicalHistoryDto, number>({
      query: (patientId) => `/patients/${patientId}/medical`,
      providesTags: ['Medical'],
    }),
    // The short version for the warning on other screens.
    getMedicalAlerts: build.query<MedicalAlertsDto, number>({
      query: (patientId) => `/patients/${patientId}/medical/alerts`,
      providesTags: ['Medical'],
    }),
    updateMedicalProfile: build.mutation<MedicalProfileDto, { patientId: number; body: MedicalProfileInput }>({
      query: ({ patientId, body }) => ({ url: `/patients/${patientId}/medical/profile`, method: 'PATCH', body }),
      transformResponse: (r: { profile: MedicalProfileDto }) => r.profile,
      invalidatesTags: ['Medical'],
    }),
    reviewMedicalHistory: build.mutation<MedicalProfileDto, number>({
      query: (patientId) => ({ url: `/patients/${patientId}/medical/review`, method: 'POST', body: {} }),
      transformResponse: (r: { profile: MedicalProfileDto }) => r.profile,
      invalidatesTags: ['Medical'],
    }),
    addMedicalItem: build.mutation<MedicalItemDto, { patientId: number; body: MedicalItemInput }>({
      query: ({ patientId, body }) => ({ url: `/patients/${patientId}/medical/items`, method: 'POST', body }),
      transformResponse: (r: { item: MedicalItemDto }) => r.item,
      invalidatesTags: ['Medical'],
    }),
    updateMedicalItem: build.mutation<MedicalItemDto, { patientId: number; itemId: number; body: Partial<Pick<MedicalItemInput, 'name' | 'severity' | 'note' | 'since' | 'active'>> }>({
      query: ({ patientId, itemId, body }) => ({ url: `/patients/${patientId}/medical/items/${itemId}`, method: 'PATCH', body }),
      transformResponse: (r: { item: MedicalItemDto }) => r.item,
      invalidatesTags: ['Medical'],
    }),
    deleteMedicalItem: build.mutation<void, { patientId: number; itemId: number }>({
      query: ({ patientId, itemId }) => ({ url: `/patients/${patientId}/medical/items/${itemId}`, method: 'DELETE' }),
      invalidatesTags: ['Medical'],
    }),
  }),
});

export const {
  useGetMedicalHistoryQuery, useGetMedicalAlertsQuery, useUpdateMedicalProfileMutation, useReviewMedicalHistoryMutation,
  useAddMedicalItemMutation, useUpdateMedicalItemMutation, useDeleteMedicalItemMutation,
} = medicalApi;
