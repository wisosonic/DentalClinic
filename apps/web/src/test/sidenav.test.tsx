import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import ar from '../i18n/ar';
import { setLanguage } from '../i18n';
import { json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };

const signIn = (role: string, extra: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
  api.routes['GET /doctors'] = () => json(200, { data: [] });
  api.routes['GET /units'] = () => json(200, { data: [] });
  api.routes['GET /medications'] = () => json(200, { data: [] });
};

const open = async (path = '/') => {
  renderApp(<App />, path);
  await screen.findByRole('heading', { name: /Welcome|Appointments|Medications/ });
  // jsdom has no media queries, so the drawer is closed (hidden) but mounted.
  return screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === 'Main')!;
};
// A hidden element has no computed accessible name, so find things by their text.
const group = (nav: HTMLElement, name: string) => within(nav).getAllByRole('button', { hidden: true }).find((b) => b.hasAttribute('aria-expanded') && b.textContent === name)!;
const link = (nav: HTMLElement, name: string) => within(nav).getAllByRole('link', { hidden: true }).find((l) => l.textContent === name)!;
const groupNames = (nav: HTMLElement) => within(nav).getAllByRole('button', { hidden: true }).filter((b) => b.hasAttribute('aria-expanded')).map((b) => b.textContent);

describe('side menu groups', () => {
  it('puts related pages under a header each, with the dashboard on its own at the top', async () => {
    signIn('admin');
    const nav = await open();
    expect(groupNames(nav)).toEqual(['Clinic', 'Finance', 'Catalog', 'Administration']);
    const lists = within(nav).getAllByRole('generic', { hidden: true }).filter((e) => e.id.startsWith('nav-'));
    const links = (id: string) => within(lists.find((l) => l.id === `nav-${id}`)!).getAllByRole('link', { hidden: true }).map((l) => l.textContent);
    expect(links('clinic')).toEqual(['Appointments', 'Patients', 'Treatment offers', 'Lab orders', 'Reports', 'Doctors', 'Clinics']);
    expect(links('finance')).toEqual(['Summary', 'Income tax', 'By doctor', 'Payments', 'Expenses', 'Commission']);
    expect(links('catalog')).toEqual(['Medications', 'Procedures', 'Labs', 'Suppliers']);
    expect(links('admin')).toEqual(['Deleted clinics’ data', 'Users', 'Roles', 'Trash', 'Activity log']);
    expect(within(nav).getAllByRole('link', { hidden: true })[0]).toHaveTextContent('Dashboard');
  });

  it('shows each person only the groups with something they can open', async () => {
    signIn('staff');
    expect(groupNames(await open())).toEqual(['Clinic', 'Finance', 'Catalog']); // no administration for staff; their catalog is the labs and suppliers
  });

  it('shows a doctor the finance pages they may use, and a specialist no doctors page', async () => {
    signIn('doctor', { doctor: { id: 9, kind: 'external' } });
    const nav = await open();
    expect(groupNames(nav)).toEqual(['Clinic', 'Finance', 'Catalog']); // no administration: a specialist does not manage doctors
    const finance = within(nav).getAllByRole('link', { hidden: true }).map((l) => l.textContent);
    expect(finance).toEqual(['Dashboard', 'Appointments', 'Patients', 'Treatment offers', 'Lab orders', 'Reports', 'By doctor', 'Payments', 'Commission', 'Medications']);
  });

  it('folds a group away and opens it again, telling assistive technology which', async () => {
    signIn('admin');
    const nav = await open();
    const finance = group(nav, 'Finance');
    expect(finance).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(finance);
    expect(finance).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(finance);
    expect(finance).toHaveAttribute('aria-expanded', 'true');
  });

  it('remembers which groups are folded in this browser', async () => {
    signIn('admin');
    const nav = await open();
    await userEvent.click(group(nav, 'Catalog'));
    expect(JSON.parse(localStorage.getItem('aya.nav.collapsed')!)).toEqual(['catalog']);
    await userEvent.click(group(nav, 'Catalog'));
    expect(JSON.parse(localStorage.getItem('aya.nav.collapsed')!)).toEqual([]);
  });

  it('starts with the remembered groups folded', async () => {
    localStorage.setItem('aya.nav.collapsed', JSON.stringify(['finance', 'admin']));
    signIn('admin');
    const nav = await open();
    expect(group(nav, 'Finance')).toHaveAttribute('aria-expanded', 'false');
    expect(group(nav, 'Administration')).toHaveAttribute('aria-expanded', 'false');
    expect(group(nav, 'Clinic')).toHaveAttribute('aria-expanded', 'true');
    localStorage.removeItem('aya.nav.collapsed');
  });

  it('opens the group of the page you are on, even if it was folded', async () => {
    localStorage.setItem('aya.nav.collapsed', JSON.stringify(['catalog', 'finance']));
    signIn('admin');
    const nav = await open('/medications');
    await waitFor(() => expect(group(nav, 'Catalog')).toHaveAttribute('aria-expanded', 'true'));
    expect(group(nav, 'Finance')).toHaveAttribute('aria-expanded', 'false'); // the others stay as they were
    localStorage.removeItem('aya.nav.collapsed');
  });

  it('marks the page you are on', async () => {
    signIn('admin');
    const nav = await open('/medications');
    expect(link(nav, 'Medications')).toHaveClass('Mui-selected');
    expect(link(nav, 'Patients')).not.toHaveClass('Mui-selected');
  });

  it('still works when the browser will not store anything', async () => {
    signIn('admin');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
    try {
      const nav = await open();
      await userEvent.click(group(nav, 'Finance'));
      expect(group(nav, 'Finance')).toHaveAttribute('aria-expanded', 'false');
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it('ignores a damaged saved state', async () => {
    localStorage.setItem('aya.nav.collapsed', '{not json');
    signIn('admin');
    expect(group(await open(), 'Finance')).toHaveAttribute('aria-expanded', 'true');
    localStorage.removeItem('aya.nav.collapsed');
  });

  it('names the groups in Arabic', async () => {
    await setLanguage('ar');
    signIn('admin');
    renderApp(<App />, '/');
    await screen.findByRole('heading', { name: /أهلاً/ });
    const nav = screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === ar.Main)!;
    expect(groupNames(nav)).toEqual([ar.Clinic, ar.Finance, ar.Catalog, ar.Administration]);
  });
});
