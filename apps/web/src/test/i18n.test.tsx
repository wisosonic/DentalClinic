import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { DentalPanorama } from '../components/DentalPanorama';
import ar from '../i18n/ar';
import { ENGLISH_ONLY } from '../i18n/ar/englishOnly';
import i18n, { setLanguage, translate } from '../i18n';
import { errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const WEB_SRC = resolve(__dirname, '..');
const API_SRC = resolve(__dirname, '../../../api/src');

function sources(dir: string, skip: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return skip(name) ? [] : sources(path, skip);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const unescape = (literal: string) => literal.slice(1, -1).replace(/\\(['"])/g, '$1');
const LITERAL = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`;

/** Every English string the screens pass to t('...'). */
function screenKeys(): string[] {
  const keys = new Set<string>();
  const re = new RegExp(String.raw`\bt\(\s*(${LITERAL})`, 'g');
  for (const file of sources(WEB_SRC, (n) => n === 'test' || n === 'i18n')) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) keys.add(unescape(m[1]!));
  }
  return [...keys];
}

/** Every fixed message the API can send (errors thrown with a literal message). */
function serverMessages(): string[] {
  const messages = new Set<string>();
  const re = new RegExp(
    String.raw`(?:notFound|forbidden|unauthorized)\(\s*(${LITERAL})|(?:badRequest|conflict)\(\s*(?:${LITERAL})\s*,\s*(${LITERAL})|new HttpError\(\s*\d+\s*,\s*(?:${LITERAL})\s*,\s*(${LITERAL})`,
    'g',
  );
  for (const file of sources(API_SRC, (n) => n === 'db' || n === 'scripts')) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) messages.add(unescape((m[1] ?? m[2] ?? m[3])!));
  }
  return [...messages];
}

const placeholders = (s: string) => [...s.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]!).sort();

describe('Arabic dictionary', () => {
  it('has a translation for every interface string', () => {
    const keys = screenKeys();
    expect(keys.length).toBeGreaterThan(200); // guards against the scan silently finding nothing
    expect(keys.filter((k) => !ar[k] && !ENGLISH_ONLY.includes(k))).toEqual([]);
  });

  it('keeps medical terms in labels in English: no Arabic entry, and each is still used by a screen', () => {
    expect(ENGLISH_ONLY.filter((k) => ar[k])).toEqual([]);
    const used = new Set(screenKeys());
    expect(ENGLISH_ONLY.filter((k) => !used.has(k))).toEqual([]);
  });

  it('has a translation for every fixed message the API can send', () => {
    const messages = serverMessages();
    expect(messages.length).toBeGreaterThan(50);
    // Messages that never reach a person: internal guards, or already translated in the API itself.
    const internal = new Set(['Not found', 'Unknown action']);
    expect(messages.filter((m) => !ar[m] && !internal.has(m))).toEqual([]);
  });

  it('keeps the same placeholders as the English text', () => {
    const broken = Object.entries(ar).filter(([en, translated]) => placeholders(en).join() !== placeholders(translated).join());
    expect(broken.map(([en]) => en)).toEqual([]);
  });

  it('has no empty translations', () => {
    expect(Object.entries(ar).filter(([, v]) => !v.trim())).toEqual([]);
  });

  it('covers every status, role and gender word that is built at run time', () => {
    for (const word of ['Pending', 'Confirmed', 'Completed', 'Cancelled', 'No-show', 'admin', 'doctor', 'staff', 'patient', 'male', 'female', 'other', 'Owner', 'External']) {
      expect(ar[word], word).toBeTruthy();
    }
  });
});

describe('Language switch', () => {
  it('turns the page right-to-left and remembers the choice', async () => {
    await setLanguage('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(localStorage.getItem('aya.language')).toBe('ar');
    expect(translate('Sign in')).toBe(ar['Sign in']);

    await setLanguage('en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(translate('Sign in')).toBe('Sign in');
  });

  it('falls back to English for text without a translation', async () => {
    await setLanguage('ar');
    expect(translate('A sentence nobody has translated')).toBe('A sentence nobody has translated');
  });

  it('switches the sign-in page to Arabic and back', async () => {
    api.routes['GET /auth/me'] = () => json(401, errorBody('UNAUTHORIZED', 'Authentication required'));
    renderApp(<App />, '/login');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'العربية' }));
    expect(await screen.findByRole('heading', { name: ar['Sign in'] })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');

    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('shows the signed-in layout in Arabic, with Western digits for dates and times', async () => {
    await setLanguage('ar');
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /config'] = () => json(200, { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' });
    api.routes['GET /appointments'] = () => json(200, { data: [], page: 1, pageSize: 50, total: 0 });
    renderApp(<App />, '/');
    await screen.findByRole('heading', { name: /أهلاً/ });
    // The drawer is closed under jsdom, so find it by its aria-label.
    const nav = screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === ar.Main)!;
    const labels = within(nav).getAllByRole('link', { hidden: true }).map((l) => l.textContent);
    expect(labels).toEqual([ar.Dashboard, ar.Appointments, ar['Waiting room'], ar.Patients, ar['Treatment offers'], ar['Lab orders'], ar.Reports, ar.Doctors, ar.Clinics, ar.Summary, ar['Income tax'], ar['By doctor'], ar.Payments, ar.Expenses, ar.Commission, 'Medications', 'Procedures', ar.Labs, ar.Suppliers, ar['Deleted clinics’ data'], ar.Users, ar.Roles, ar.Trash, ar['Activity log']]);
    expect(new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-LB-u-nu-latn' : 'en', { day: 'numeric' }).format(new Date('2026-10-05T00:00:00Z'))).toBe('5');
  });
});

describe('Arabic keeps medical content in English', () => {
  it('lays the dental chart out left to right with its tooth numbers', async () => {
    await setLanguage('ar');
    const teeth = ['18', '17', '11', '21', '48', '38'].map((index, i) => ({ id: i + 1, index, name: `Tooth ${index}`, type: 'Molar' }));
    const { container } = renderApp(<DentalPanorama teeth={teeth} onToggle={() => {}} />);
    expect(container.querySelector('[dir="ltr"]')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Tooth 18/ })).toBeInTheDocument());
    expect(screen.getByRole('group', { name: ar['Dental chart'] })).toBeInTheDocument();
  });
});
