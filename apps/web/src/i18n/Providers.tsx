import { useEffect, useMemo, type ReactNode } from 'react';
import createCache from '@emotion/cache';
import { CacheProvider } from '@emotion/react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { prefixer } from 'stylis';
import rtlPlugin from 'stylis-plugin-rtl';
import { COLOR_MODES, TEXT_SIZES, type ColorMode, type TextSize } from '@aya/shared';
import { usePublicSettingsQuery } from '../features/settings/settingsApi';
import { makeTheme } from '../theme';
import { applyDefaultLanguage, useLanguage } from './index';

// Two style caches: the right-to-left one mirrors every margin, padding and alignment for Arabic.
const rtlCache = createCache({ key: 'muirtl', stylisPlugins: [prefixer, rtlPlugin] });
const ltrCache = createCache({ key: 'muiltr' });

const LOOK_KEY = 'aya.look';

/** The look last used on this device, so the page opens dark or large straight away instead of flashing light. */
function remembered(): { mode: ColorMode; textSize: TextSize } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LOOK_KEY) ?? '{}');
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      mode: COLOR_MODES.find((m) => m === o.mode) ?? 'light',
      textSize: TEXT_SIZES.find((s) => s === o.textSize) ?? 'medium',
    };
  } catch {
    return { mode: 'light', textSize: 'medium' }; // storage can be blocked or hold something else
  }
}

/** Theme, style direction and the clinic's look (light or dark, text size) follow the language and Settings > Appearance. */
export function LanguageProviders({ children }: { children: ReactNode }) {
  const { dir } = useLanguage();
  const { data } = usePublicSettingsQuery();
  const known = useMemo(remembered, []);
  const mode = data?.mode ?? known.mode;
  const textSize = data?.textSize ?? known.textSize;

  useEffect(() => {
    if (!data) return;
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify({ mode: data.mode, textSize: data.textSize }));
    } catch {
      // not remembering the look is fine
    }
    void applyDefaultLanguage(data.language);
  }, [data]);

  const theme = useMemo(() => makeTheme(dir, { mode, textSize }), [dir, mode, textSize]);
  return (
    <CacheProvider value={dir === 'rtl' ? rtlCache : ltrCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}
