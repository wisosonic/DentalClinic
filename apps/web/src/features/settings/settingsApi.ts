import type { AppearanceSettingsDto, GeneralSettingsDto, PublicSettingsDto } from '@aya/shared';
import { api } from '../auth/authApi';

export const settingsApi = api.injectEndpoints({
  endpoints: (build) => ({
    /** Open to everyone: the language to start in and how the app looks. */
    publicSettings: build.query<PublicSettingsDto, void>({
      query: () => '/public-settings',
      providesTags: ['Settings'],
    }),
    generalSettings: build.query<GeneralSettingsDto, void>({
      query: () => '/settings/general',
      providesTags: ['Settings'],
    }),
    saveGeneralSettings: build.mutation<GeneralSettingsDto, Record<string, unknown>>({
      query: (body) => ({ url: '/settings/general', method: 'PUT', body }),
      // the timezone changes what "today" is, so anything built on it asks again
      invalidatesTags: ['Settings', 'Appointment'],
    }),
    appearanceSettings: build.query<AppearanceSettingsDto, void>({
      query: () => '/settings/appearance',
      providesTags: ['Settings'],
    }),
    saveAppearanceSettings: build.mutation<AppearanceSettingsDto, Record<string, unknown>>({
      query: (body) => ({ url: '/settings/appearance', method: 'PUT', body }),
      invalidatesTags: ['Settings'],
    }),
  }),
});

export const {
  usePublicSettingsQuery, useGeneralSettingsQuery, useSaveGeneralSettingsMutation, useAppearanceSettingsQuery, useSaveAppearanceSettingsMutation,
} = settingsApi;
