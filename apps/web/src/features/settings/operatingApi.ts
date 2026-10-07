import type { OperatingGroup, OperatingSettings } from '@aya/shared';
import { api } from '../auth/authApi';

/** The operating settings pages (`/settings/<group>`): read one group, save it. */
export const operatingApi = api.injectEndpoints({
  endpoints: (build) => ({
    operatingSettings: build.query<OperatingSettings[OperatingGroup], OperatingGroup>({
      query: (group) => `/settings/${group}`,
      providesTags: ['Settings'],
    }),
    saveOperatingSettings: build.mutation<OperatingSettings[OperatingGroup], { group: OperatingGroup; body: unknown }>({
      query: ({ group, body }) => ({ url: `/settings/${group}`, method: 'PUT', body }),
      // the booking rules, the portal and the limits are read by many screens (`/config`) and by the sign-in page
      invalidatesTags: ['Settings', 'Appointment', 'Document'],
    }),
  }),
});

export const { useOperatingSettingsQuery, useSaveOperatingSettingsMutation } = operatingApi;
