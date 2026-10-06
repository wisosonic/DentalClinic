import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { formatMoney } from '../lib/money';
import { json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-15' };
const SUMMARY = {
  from: '2026-10-01', to: '2026-10-15',
  payments: { total: 1240, count: 10, byType: [{ type: 'clinic', total: 1200, count: 8 }, { type: 'commission', total: 40, count: 2 }] },
  expenses: {
    total: 450.5, count: 5, byType: [{ type: 'lab', total: 300 }, { type: 'clinic', total: 150.5 }],
    byLab: [{ id: 1, name: 'Kadi Lab', total: 300 }], bySupplier: [{ id: 2, name: 'Safadi', total: 90 }],
  },
  net: 789.5,
  byMonth: [{ month: '2026-09', payments: 800, expenses: 300 }, { month: '2026-10', payments: 440, expenses: 150.5 }],
  debts: { total: 900, patients: 2, offers: 3, top: [{ patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, owed: 600 }, { patient: { id: 8, fname: 'Nour', lname: 'Haddad' }, owed: 300 }] },
};
const TOTAL = 1240;
const last = () => api.calls.filter((c) => c.path === '/finance/summary').at(-1)!;

const setup = (summary: object = SUMMARY, role = 'admin') => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /finance/summary'] = () => json(200, summary);
};

describe('summary page', () => {
  it('is for admins only', async () => {
    setup(SUMMARY, 'staff');
    renderApp(<App />, '/summary');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/finance/summary')).toBe(false);
  });

  it('starts on the current month and shows payments, expenses, net profit and debts', async () => {
    setup();
    renderApp(<App />, '/summary');
    expect(await screen.findByText(formatMoney(TOTAL))).toBeInTheDocument();
    expect(last().query.get('from')).toBe('2026-10-01');
    expect(last().query.get('to')).toBe('2026-10-15');
    expect(screen.getByText(formatMoney(450.5))).toBeInTheDocument();
    expect(screen.getByText(formatMoney(789.5))).toBeInTheDocument();
    expect(screen.getByText('Payments minus expenses.')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(900))).toBeInTheDocument();
    expect(screen.getByText('10 payments received')).toBeInTheDocument();
    // the payments are listed by type, as the expenses are
    expect(screen.getByText(`From patients ${formatMoney(1200)}`)).toBeInTheDocument();
    expect(screen.getByText(`Commission received ${formatMoney(40)}`)).toBeInTheDocument();
    expect(screen.getByText(`Lab ${formatMoney(300)}`)).toBeInTheDocument(); // what the expenses were made of
    const debtors = screen.getByRole('list', { name: 'Biggest debts' });
    expect(within(debtors).getByRole('link', { name: 'Hicham Cheaib' })).toHaveAttribute('href', '/patients/7');
  });

  it('has no commission button when there was no commission in the period', async () => {
    setup({ ...SUMMARY, payments: { total: 1200, count: 8, byType: [{ type: 'clinic', total: 1200, count: 8 }] } });
    renderApp(<App />, '/summary');
    await screen.findByText(formatMoney(1200));
    expect(screen.queryByRole('link', { name: 'Browse commission' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Commission received/)).not.toBeInTheDocument();
  });

  it('shows a loss in a different note when more went out than came in', async () => {
    setup({ ...SUMMARY, net: -100 });
    renderApp(<App />, '/summary');
    expect(await screen.findByText('More went out than came in.')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(-100))).toBeInTheDocument();
  });

  it('asks again when the dates or a shortcut change', async () => {
    setup();
    renderApp(<App />, '/summary');
    await screen.findByText(formatMoney(TOTAL));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(last().query.get('from')).toBe('2026-09-01'));
    await userEvent.click(screen.getByRole('button', { name: 'Last month' }));
    await waitFor(() => expect(last().query.get('from')).toBe('2026-09-01'));
    expect(last().query.get('to')).toBe('2026-09-30');
    await userEvent.click(screen.getByRole('button', { name: 'This year' }));
    await waitFor(() => expect(last().query.get('from')).toBe('2026-01-01'));
    await userEvent.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(last().query.has('from')).toBe(false));
    expect(last().query.has('to')).toBe(false);
  });

  it('breaks the expenses down by lab and by supplier', async () => {
    setup();
    renderApp(<App />, '/summary');
    const labs = await screen.findByRole('list', { name: 'By lab' });
    expect(within(labs).getByText('Kadi Lab')).toBeInTheDocument();
    expect(within(labs).getByText(formatMoney(300))).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'By supplier' })).getByText('Safadi')).toBeInTheDocument();
  });

  it('downloads the summary as a CSV file', async () => {
    setup();
    const blobs: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = () => {}; // jsdom cannot navigate to a download
    renderApp(<App />, '/summary');
    await userEvent.click(await screen.findByRole('button', { name: 'Download CSV' }));
    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blobs[0]!); });
    expect(text).toContain('"Expenses by lab","Kadi Lab","300"');
    expect(text).toContain('"Net profit","","789.5"');
  });

  it('has buttons that browse the records behind each total, for the same period', async () => {
    setup();
    renderApp(<App />, '/summary');
    await screen.findByText(formatMoney(TOTAL));
    expect(screen.getByRole('link', { name: 'Browse payments' })).toHaveAttribute('href', '/payments?from=2026-10-01&to=2026-10-15');
    expect(screen.getByRole('link', { name: 'Browse expenses' })).toHaveAttribute('href', '/expenses?from=2026-10-01&to=2026-10-15');
    expect(screen.getByRole('link', { name: 'Browse commission' })).toHaveAttribute('href', '/commission?from=2026-10-01&to=2026-10-15');
    expect(screen.getByRole('link', { name: 'Browse debts' })).toHaveAttribute('href', '/treatment-offers?debt=1');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Browse payments' })).toHaveAttribute('href', '/payments?from=2026-10-01'));
  });

  it('opens the commission page already limited to that period', async () => {
    setup();
    api.routes['GET /commission/statement'] = () => json(200, { lines: [], fees: [], missingPercentage: [] });
    api.routes['GET /commission/payments'] = () => json(200, { data: [] });
    renderApp(<App />, '/commission?from=2026-10-01&to=2026-10-15');
    expect(await screen.findByLabelText('From')).toHaveValue('2026-10-01');
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/commission/statement').at(-1)!.query.get('to')).toBe('2026-10-15'));
  });

  it('opens the payments, expenses and debts pages already limited to that period', async () => {
    setup();
    api.routes['GET /payments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    api.routes['GET /expenses'] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 }, sum: 0 });
    api.routes['GET /treatment-offers'] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    renderApp(<App />, '/payments?from=2026-10-01&to=2026-10-15');
    expect(await screen.findByLabelText('From')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-15');
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/payments').at(-1)!.query.get('from')).toBe('2026-10-01'));
  });
});

describe('debts filter on treatment offers', () => {
  it('shows only offers with a balance, and the filter can be removed', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /treatment-offers'] = () => json(200, { data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    renderApp(<App />, '/treatment-offers?debt=1');
    const chip = await screen.findByRole('checkbox', { name: 'Only with a balance owed' });
    expect(chip).toBeChecked();
    expect(api.calls.filter((c) => c.path === '/treatment-offers').at(-1)!.query.get('debt')).toBe('1');
    await userEvent.click(chip);
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/treatment-offers').at(-1)!.query.has('debt')).toBe(false));
  });
});
