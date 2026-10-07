import type { WaitingAction, WaitingCandidateDto, WaitingCheckInInput, WaitingDisplayDto, WaitingListDto, WaitingScreenDto, WaitingTicketDto } from '@aya/shared';
import { api } from '../auth/authApi';

/** The waiting room: today's numbers, giving one, calling, and the address of the waiting-room screen. */
export const waitingApi = api.injectEndpoints({
  endpoints: (build) => ({
    getWaitingList: build.query<WaitingListDto, void>({
      query: () => '/waiting-room',
      providesTags: ['Waiting'],
    }),
    getWaitingCandidates: build.query<WaitingCandidateDto[], void>({
      query: () => '/waiting-room/candidates',
      transformResponse: (r: { data: WaitingCandidateDto[] }) => r.data,
      providesTags: ['Waiting', 'Appointment'],
    }),
    checkInWaiting: build.mutation<WaitingTicketDto, WaitingCheckInInput>({
      query: (body) => ({ url: '/waiting-room', method: 'POST', body }),
      transformResponse: (r: { ticket: WaitingTicketDto }) => r.ticket,
      invalidatesTags: ['Waiting'],
    }),
    waitingAction: build.mutation<WaitingTicketDto, { id: number; action: WaitingAction }>({
      query: ({ id, action }) => ({ url: `/waiting-room/${id}/${action}`, method: 'POST', body: {} }),
      transformResponse: (r: { ticket: WaitingTicketDto }) => r.ticket,
      invalidatesTags: ['Waiting'],
    }),
    getWaitingScreen: build.query<WaitingScreenDto, void>({
      query: () => '/waiting-room/screen',
      providesTags: ['Settings'],
    }),
    resetWaitingScreen: build.mutation<WaitingScreenDto, void>({
      query: () => ({ url: '/waiting-room/screen/reset', method: 'POST', body: {} }),
      invalidatesTags: ['Settings'],
    }),
    /** The screen on the wall: no sign-in, only the secret in its address. */
    getWaitingDisplay: build.query<WaitingDisplayDto, string>({
      query: (key) => ({ url: '/waiting-display', params: { key } }),
    }),
  }),
});

export const {
  useGetWaitingListQuery, useGetWaitingCandidatesQuery, useCheckInWaitingMutation, useWaitingActionMutation,
  useGetWaitingScreenQuery, useResetWaitingScreenMutation, useGetWaitingDisplayQuery,
} = waitingApi;
