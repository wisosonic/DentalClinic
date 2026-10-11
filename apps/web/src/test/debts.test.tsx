import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const ROWS = [
  { patient: { id: 7, fname: 'Hicham', lname: 'Cheaib', phone: '03039198' }, doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, offers: 2, price: 400, paid: 150, owed: 250, since: '2026-03-01', lastPayment: '2026-05-20' },
  { patient: { id: 9, fname: 'Mona', lname: 'Haddad', phone: '70123456' }, doctor: null, offers: 1, price: 80, paid: 0, owed: 80, since: '2026-06-01', lastPayment: null },
  { patient: { id: 11, fname: 'Zeina', lname: 'Aoun', phone: '71000000' }, doctor: { id: 2, fname: 'Sara', lname: 'Doughan' }, offers: 1, price: 120, paid: 100, owed: 20, since: '2026-02-01', lastPayment: '2026-09-30' },
];
const TOTALS = { owed: 350, patients: 3, offers: 4 };

const open = async (role = 'admin', debts: { data: unknown[]; totals: object } = { data: ROWS, totals: TOTALS }) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, role === 'doctor' ? { doctor: { id: 1, kind: 'owner' } } : {}) });
  api.routes['GET /config'] = () => json(200, { defaultDuration: 30, timezone: 'Asia/Beirut', today: '2026-10-11' });
  api.routes['GET /finance/debts'] = () => json(200, debts);
  renderApp(<App />, '/debts');
  await screen.findByRole('heading', { name: 'Debts' });
};
const names = () => within(screen.getByRole('table', { name: 'Debts' })).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent?.replace(/\d{8}$/, ''));

describe('the debts page', () => {
  it('is in the Finance group of the menu, and its trail says Debts', async () => {
    await open();
    // jsdom has no media queries, so the drawer is closed (hidden) but mounted
    const nav = screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === 'Main')!;
    const link = within(nav).getAllByRole('link', { hidden: true }).find((l) => l.textContent === 'Debts')!;
    expect(link).toHaveAttribute('href', '/debts');
    expect(within(nav).getAllByRole('generic', { hidden: true }).find((e) => e.id === 'nav-finance')).toContainElement(link);
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Debts')).toBeInTheDocument();
  });

  it('shows the totals and one row for each patient who owes, the biggest first', async () => {
    await open();
    expect(await screen.findByText('US$350.00')).toBeInTheDocument();
    expect(screen.getByText('Total owed')).toBeInTheDocument();
    expect(screen.getByText('Patients owing').nextElementSibling).toHaveTextContent('3');
    expect(screen.getByText('Open treatment offers').nextElementSibling).toHaveTextContent('4');
    expect(names()).toEqual(['Hicham Cheaib', 'Mona Haddad', 'Zeina Aoun']);
    const first = screen.getByText('Hicham Cheaib').closest('tr') as HTMLElement;
    expect(within(first).getByText('Aya Ghali')).toBeInTheDocument();
    expect(within(first).getByText('US$250.00')).toBeInTheDocument();
    expect(within(first).getByText('US$150.00')).toBeInTheDocument();
    expect(within(first).getByText('03039198')).toBeInTheDocument();
    expect(within(screen.getByText('Mona Haddad').closest('tr') as HTMLElement).getByText('No payment yet')).toBeInTheDocument();
  });

  it('links each patient to their page and each row to the treatment offers that are owed', async () => {
    await open();
    expect(await screen.findByRole('link', { name: 'Hicham Cheaib' })).toHaveAttribute('href', '/patients/7');
    expect(screen.getByRole('link', { name: 'Open the treatment offers of Hicham Cheaib that are owed' })).toHaveAttribute('href', '/treatment-offers?patientId=7&debt=1');
  });

  it('sorts by any column and searches by name or phone', async () => {
    await open();
    await screen.findByText('Hicham Cheaib');
    const table = within(screen.getByRole('table', { name: 'Debts' }));
    await userEvent.click(table.getByRole('button', { name: 'Patient' }));
    expect(names()).toEqual(['Hicham Cheaib', 'Mona Haddad', 'Zeina Aoun']); // by name, ascending
    await userEvent.click(table.getByRole('button', { name: 'Patient' }));
    expect(names()).toEqual(['Zeina Aoun', 'Mona Haddad', 'Hicham Cheaib']);
    await userEvent.click(table.getByRole('button', { name: 'Owing since' }));
    expect(names()).toEqual(['Zeina Aoun', 'Hicham Cheaib', 'Mona Haddad']);
    await userEvent.type(screen.getByLabelText('Search patients'), '7012');
    expect(names()).toEqual(['Mona Haddad']);
    await userEvent.clear(screen.getByLabelText('Search patients'));
    await userEvent.type(screen.getByLabelText('Search patients'), 'nobody');
    expect(await screen.findByText('No patient matches.')).toBeInTheDocument();
  });

  it('says so when nobody owes anything', async () => {
    await open('admin', { data: [], totals: { owed: 0, patients: 0, offers: 0 } });
    expect(await screen.findByText('Nobody owes anything.')).toBeInTheDocument();
  });

  it('shows a doctor their own patients, without the doctor column', async () => {
    await open('doctor', { data: [ROWS[0]!], totals: { owed: 250, patients: 1, offers: 2 } });
    await screen.findByText('Hicham Cheaib');
    expect(screen.getByText('What your patients still owe on their accepted treatment offers, as things stand today.')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Debts' })).queryByRole('button', { name: 'Doctor' })).not.toBeInTheDocument();
  });

  it('shows the server’s refusal', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /config'] = () => json(200, { defaultDuration: 30, timezone: 'Asia/Beirut', today: '2026-10-11' });
    api.routes['GET /finance/debts'] = () => json(403, errorBody('FORBIDDEN', 'You do not have permission to do that'));
    renderApp(<App />, '/debts');
    expect(await screen.findByText('You do not have permission to do that')).toBeInTheDocument();
  });
});
