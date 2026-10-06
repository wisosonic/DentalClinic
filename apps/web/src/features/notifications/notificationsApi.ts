import type { NotificationDto, Paginated } from '@aya/shared';
import { api } from '../auth/authApi';

export type NotificationList = Paginated<NotificationDto> & { unread: number };

export const notificationsApi = api.injectEndpoints({
  endpoints: (build) => ({
    notifications: build.query<NotificationList, { pageSize?: number } | void>({
      query: (p) => ({ url: '/notifications', params: { pageSize: p?.pageSize ?? 10 } }),
      providesTags: ['Notification'],
    }),
    markNotificationRead: build.mutation<NotificationDto, number>({
      query: (id) => ({ url: `/notifications/${id}/read`, method: 'PATCH', body: {} }),
      transformResponse: (r: { notification: NotificationDto }) => r.notification,
      invalidatesTags: ['Notification'],
    }),
    markAllNotificationsRead: build.mutation<void, void>({
      query: () => ({ url: '/notifications/read-all', method: 'POST', body: {} }),
      invalidatesTags: ['Notification'],
    }),
  }),
});

export const { useNotificationsQuery, useMarkNotificationReadMutation, useMarkAllNotificationsReadMutation } = notificationsApi;
