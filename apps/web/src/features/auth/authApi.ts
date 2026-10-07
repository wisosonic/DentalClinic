import { createApi } from '@reduxjs/toolkit/query/react';
import type { ChangePasswordInput, LoginInput, PublicUser } from '@aya/shared';
import { baseQueryWithReauth } from '../../lib/baseQuery';
import { sessionStarted } from './authSlice';

interface UserResponse {
  user: PublicUser;
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['Patient', 'Appointment', 'Doctor', 'Clinic', 'Unit', 'Report', 'Timeline', 'Medication', 'Category', 'User', 'Trash', 'Audit', 'Offer', 'Document', 'Payment', 'Expense', 'Commission', 'LabOrder', 'Directory', 'Tax', 'Settings', 'Notification', 'Roles', 'Waiting'],
  endpoints: (build) => ({
    getMe: build.query<PublicUser, void>({
      query: () => '/auth/me',
      transformResponse: (r: UserResponse) => r.user,
    }),

    login: build.mutation<PublicUser, LoginInput>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      transformResponse: (r: UserResponse) => r.user,
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(sessionStarted());
          dispatch(api.util.upsertQueryData('getMe', undefined, data));
        } catch {
          // the form shows the error
        }
      },
    }),

    logout: build.mutation<void, void>({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          await queryFulfilled;
        } finally {
          // Drop every cached response: nothing from this session may linger.
          dispatch(api.util.resetApiState());
        }
      },
    }),

    changePassword: build.mutation<PublicUser, ChangePasswordInput>({
      query: (body) => ({ url: '/auth/change-password', method: 'POST', body }),
      transformResponse: (r: UserResponse) => r.user,
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(api.util.upsertQueryData('getMe', undefined, data));
        } catch {
          // the form shows the error
        }
      },
    }),

    resetPassword: build.mutation<{ message: string }, { token: string; password: string }>({
      query: (body) => ({ url: '/auth/reset-password', method: 'POST', body }),
    }),
  }),
});

export const {
  useGetMeQuery,
  useLoginMutation,
  useLogoutMutation,
  useChangePasswordMutation,
  useResetPasswordMutation,
} = api;
