import type { RolesResponse } from '@aya/shared';
import { api } from '../auth/authApi';

export const rolesApi = api.injectEndpoints({
  endpoints: (build) => ({
    getRoles: build.query<RolesResponse, void>({
      query: () => '/roles',
      providesTags: ['Roles'],
    }),
    saveRole: build.mutation<RolesResponse, { role: string; permissions: string[] }>({
      query: ({ role, permissions }) => ({ url: `/roles/${role}`, method: 'PUT', body: { permissions } }),
      invalidatesTags: ['Roles'],
    }),
    resetRole: build.mutation<RolesResponse, string>({
      query: (role) => ({ url: `/roles/${role}/reset`, method: 'POST' }),
      invalidatesTags: ['Roles'],
    }),
  }),
});

export const { useGetRolesQuery, useSaveRoleMutation, useResetRoleMutation } = rolesApi;
