import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TAX_SETTINGS } from '@aya/shared';
import { App } from '../App';
import { TEXT_SIZE_PX } from '@aya/shared';
import i18n, { applyDefaultLanguage, setLanguage } from '../i18n';
import { makeTheme } from '../theme';
import { errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };

const signIn = (role = 'admin') => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 100, total: 0 } });
  api.routes['GET /settings/tax'] = () => json(200, { sets: [], defaults: DEFAULT_TAX_SETTINGS });
  api.routes['GET /settings/general'] = () => json(200, GENERAL);
  api.routes['GET /settings/appearance'] = () => json(200, { mode: 'light', textSize: 'medium' });
};

const GENERAL = { language: 'en', timezone: 'Asia/Beirut', clinic: { address: 'Karakol, Beirut', phone: '01 234 567', email: null }, notifications: { reminders: true, events: true } };

describe('the gear in the header', () => {
  it('is next to the language button for an admin, and opens the settings page', async () => {
    signIn();
    renderApp(<App />, '/');
    const gear = await screen.findByRole('link', { name: 'Settings' });
    expect(gear).toHaveAttribute('href', '/settings');
    const header = gear.closest('header') as HTMLElement;
    const language = within(header).getByRole('button', { name: 'العربية' });
    expect(language.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // right after the language button
    await userEvent.click(gear);
    expect(await screen.findByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
  });

  it('is not there for doctors or staff, and Settings is not in the side menu', async () => {
    for (const role of ['doctor', 'staff']) {
      signIn(role);
      const { unmount } = renderApp(<App />, '/');
      await screen.findByRole('heading', { name: /Welcome/ });
      expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
      unmount();
    }
    signIn('admin');
    renderApp(<App />, '/');
    await screen.findByRole('link', { name: 'Settings' });
    const side = screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === 'Main')!;
    expect(within(side).queryByText('Settings')).not.toBeInTheDocument();
  });
});

describe('the settings page', () => {
  it('lists its sections down the side, and starts on General', async () => {
    signIn();
    renderApp(<App />, '/settings');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['General', 'Appearance', 'Taxes']);
    expect(await screen.findByRole('region', { name: 'General' })).toBeInTheDocument(); // after the redirect
    expect(within(nav).getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows the section that was chosen, and the tax settings under Taxes', async () => {
    signIn();
    renderApp(<App />, '/settings/general');
    await userEvent.click(await screen.findByRole('link', { name: 'Appearance' }));
    expect(await within(await screen.findByRole('region', { name: 'Appearance' })).findByText('Text size')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('link', { name: 'Taxes' }));
    expect(await screen.findByLabelText('LBP per 1 US dollar')).toHaveValue(89500);
    expect(screen.queryByRole('region', { name: 'Appearance' })).not.toBeInTheDocument();
  });

  it('shows Settings and the section in the breadcrumbs', async () => {
    signIn();
    renderApp(<App />, '/settings/taxes');
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(within(crumbs).getByText('Taxes')).toHaveAttribute('aria-current', 'page');
  });

  it('is for admins only', async () => {
    signIn('staff');
    renderApp(<App />, '/settings/taxes');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/settings/tax')).toBe(false);
  });
});

describe('General settings', () => {
  it('shows the language, the timezone and the clinic’s contact details', async () => {
    signIn();
    renderApp(<App />, '/settings/general');
    expect(await screen.findByLabelText('Address')).toHaveValue('Karakol, Beirut');
    expect(screen.getByLabelText('Phone')).toHaveValue('01 234 567');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Timezone')).toHaveValue('Asia/Beirut');
    expect(screen.getByLabelText('Default language')).toHaveTextContent('English');
  });

  it('saves what was changed, with an empty detail sent empty', async () => {
    signIn();
    api.routes['PUT /settings/general'] = (c) => json(200, { ...c.body, clinic: { address: c.body.clinic.address, phone: c.body.clinic.phone || null, email: c.body.clinic.email || null } });
    renderApp(<App />, '/settings/general');
    fireEvent.change(await screen.findByLabelText('Address'), { target: { value: 'New Street 5' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'hello@clinic.test' } });
    await userEvent.click(screen.getByLabelText('Default language'));
    await userEvent.click(await screen.findByRole('option', { name: 'العربية' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/settings/general')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ language: 'ar', timezone: 'Asia/Beirut', clinic: { address: 'New Street 5', phone: '01 234 567', email: 'hello@clinic.test' }, notifications: { reminders: true, events: true } });
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
  });

  it('refuses a bad email before sending anything', async () => {
    signIn();
    renderApp(<App />, '/settings/general');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'nonsense' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Invalid email')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows the server’s refusal', async () => {
    signIn();
    api.routes['PUT /settings/general'] = () => json(400, errorBody('VALIDATION', 'Choose a valid timezone'));
    renderApp(<App />, '/settings/general');
    await screen.findByLabelText('Address');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a valid timezone');
  });
});

describe('Appearance settings', () => {
  it('shows the saved theme and text size, and saves a change', async () => {
    signIn();
    api.routes['PUT /settings/appearance'] = (c) => json(200, c.body);
    renderApp(<App />, '/settings/appearance');
    expect(await screen.findByRole('radio', { name: 'Light' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Large' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/settings/appearance')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ mode: 'dark', textSize: 'large' });
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
  });
});

describe('the look of the app', () => {
  it('is light and medium by default, dark when asked, and the text size scales every rem', () => {
    const light = makeTheme('ltr');
    expect(light.palette.mode).toBe('light');
    const dark = makeTheme('ltr', { mode: 'dark', textSize: 'large' });
    expect(dark.palette.mode).toBe('dark');
    expect(dark.palette.background.default).not.toBe(light.palette.background.default);
    expect(dark.palette.text.primary).not.toBe(light.palette.text.primary);
    const rootSize = (t: ReturnType<typeof makeTheme>) => ((t.components?.MuiCssBaseline?.styleOverrides as { html: { fontSize: string } }).html.fontSize);
    expect(rootSize(light)).toBe('87.5%'); // 14px, as before
    expect(rootSize(dark)).toBe(`${(TEXT_SIZE_PX.large / 16) * 100}%`);
    expect(rootSize(makeTheme('ltr', { textSize: 'small' }))).toBe(`${(TEXT_SIZE_PX.small / 16) * 100}%`);
  });

  it('gives dark mode inputs, tables and the top bar colours of their own, not the light ones', () => {
    const dark = makeTheme('rtl', { mode: 'dark' });
    expect(dark.direction).toBe('rtl');
    const input = dark.components?.MuiOutlinedInput?.styleOverrides?.root as { backgroundColor: string };
    expect(input.backgroundColor).toBe(dark.palette.background.paper);
    expect(input.backgroundColor).not.toBe('#fff');
    const bar = dark.components?.MuiAppBar?.styleOverrides?.root as { color: string; backgroundColor: string };
    expect(bar.color).toBe(dark.palette.text.primary);
    expect(bar.backgroundColor).not.toContain('255,255,255');
  });
});

describe('the clinic’s default language', () => {
  afterEach(async () => {
    localStorage.clear();
    await setLanguage('en');
    localStorage.clear();
  });

  it('applies to someone who has not chosen a language, without storing it as their choice', async () => {
    localStorage.clear();
    await applyDefaultLanguage('ar');
    expect(i18n.language).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(localStorage.getItem('aya.language')).toBeNull();
  });

  it('never overrides a language the person picked with the language button', async () => {
    await setLanguage('en'); // an explicit choice, stored
    await applyDefaultLanguage('ar');
    expect(i18n.language).toBe('en');
  });
});

describe('the notification switches', () => {
  it('are on by default and saved with the rest of the general settings when changed', async () => {
    signIn();
    api.routes['PUT /settings/general'] = (c) => json(200, c.body);
    renderApp(<App />, '/settings/general');
    const reminders = await screen.findByLabelText(/Appointment reminders/);
    const events = screen.getByLabelText(/Other events/);
    expect(reminders).toBeChecked();
    expect(events).toBeChecked();
    await userEvent.click(reminders);
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.path === '/settings/general')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body.notifications).toEqual({ reminders: false, events: true });
  });
});
