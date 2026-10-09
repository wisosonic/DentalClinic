import type { FamilyLinkInput, FamilyMemberDto } from '@aya/shared';
import { api } from '../auth/authApi';

export const familyApi = api.injectEndpoints({
  endpoints: (build) => ({
    listFamily: build.query<FamilyMemberDto[], number>({
      query: (patientId) => `/patients/${patientId}/family`,
      transformResponse: (r: { data: FamilyMemberDto[] }) => r.data,
      providesTags: ['Family'],
    }),
    // "relativeId is the patient's <relation>"
    linkFamilyMember: build.mutation<FamilyMemberDto, { patientId: number; body: FamilyLinkInput }>({
      query: ({ patientId, body }) => ({ url: `/patients/${patientId}/family`, method: 'POST', body }),
      transformResponse: (r: { member: FamilyMemberDto }) => r.member,
      invalidatesTags: ['Family'],
    }),
    unlinkFamilyMember: build.mutation<void, { patientId: number; linkId: number }>({
      query: ({ patientId, linkId }) => ({ url: `/patients/${patientId}/family/${linkId}`, method: 'DELETE' }),
      invalidatesTags: ['Family'],
    }),
  }),
});

export const { useListFamilyQuery, useLinkFamilyMemberMutation, useUnlinkFamilyMemberMutation } = familyApi;
