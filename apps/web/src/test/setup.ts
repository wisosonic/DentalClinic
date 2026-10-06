import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import i18n, { setLanguage } from '../i18n';

// MUI renders slowly under jsdom; the default 1 s is too tight when the whole suite runs at once.
configure({ asyncUtilTimeout: 5000 });

afterEach(async () => {
  cleanup();
  document.cookie = 'csrf_token=; Max-Age=0; path=/';
  // Every test starts in English, whatever a previous one chose.
  if (i18n.language !== 'en') await setLanguage('en');
  try {
    localStorage.removeItem('aya.language');
  } catch {
    // ignore
  }
});
