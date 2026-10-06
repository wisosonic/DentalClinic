import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import ar from './ar';

export type Language = 'en' | 'ar';

const STORAGE_KEY = 'aya.language';

/**
 * Translation keys are the English text itself, so a missing Arabic string simply shows English
 * rather than a blank or a code. Only the interface is translated: medical terms, medication and
 * procedure names, tooth and surface names, report text and the PDFs stay in English.
 */
const hasStoredLanguage = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
};

function stored(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ar' ? 'ar' : 'en';
  } catch {
    return 'en'; // storage can be blocked; the page must still work
  }
}

export const directionOf = (lang: string): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr');

function applyToDocument(lang: Language) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = directionOf(lang);
}

void i18n.use(initReactI18next).init({
  resources: { ar: { translation: ar } },
  lng: stored(),
  fallbackLng: 'en',
  keySeparator: false, // the keys are English sentences
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React already escapes
  returnEmptyString: false,
});
applyToDocument(i18n.language === 'ar' ? 'ar' : 'en');

export async function setLanguage(lang: Language): Promise<void> {
  await i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // not remembering the choice is fine
  }
  applyToDocument(lang);
}

/**
 * The clinic's default language (Settings > General). It applies only to someone who has not picked a language
 * with the language button: their own choice always wins, and this never overwrites it.
 */
export async function applyDefaultLanguage(lang: Language): Promise<void> {
  if (hasStoredLanguage() || i18n.language === lang) return;
  await i18n.changeLanguage(lang);
  applyToDocument(lang);
}

/** The current language, its direction, and a way to change it. Re-renders when it changes. */
export function useLanguage() {
  const { i18n: instance } = useTranslation();
  const lang: Language = instance.language === 'ar' ? 'ar' : 'en';
  return { lang, dir: directionOf(lang), setLanguage };
}

/** For plain functions (formatting helpers) that can't use the hook. */
export const translate = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options) as string;

/** BCP 47 tag for dates and numbers. Arabic keeps Western digits, as is usual in Lebanon. */
export const dateLocale = (): string => (i18n.language === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB');

export default i18n;
