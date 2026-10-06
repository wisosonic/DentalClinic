import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MonthlyChart } from '../features/finance/MonthlyChart';
import { formatMoney } from '../lib/money';
import { json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-15' };
const MONTHS = [
  { month: '2026-08', payments: 1200, expenses: 400 },
  { month: '2026-09', payments: 0, expenses: 250.5 },
  { month: '2026-10', payments: 900, expenses: 1000 },
];

describe('monthly chart', () => {
  it('draws two columns for every month, with the months named under them', () => {
    const { container } = renderApp(<MonthlyChart months={MONTHS} />);
    expect(container.querySelectorAll('svg path')).toHaveLength(5); // the empty payments column of September is not drawn
    expect(screen.getByText(/^Aug/)).toBeInTheDocument();
    expect(screen.getByText(/^Oct/)).toBeInTheDocument();
    expect(screen.getByText('Month by month')).toBeInTheDocument();
  });

  it('says what the two colours are, in text', () => {
    renderApp(<MonthlyChart months={MONTHS} />);
    const legend = screen.getByRole('group', { name: 'Legend' });
    expect(within(legend).getByText('Payments')).toBeInTheDocument();
    expect(within(legend).getByText('Expenses')).toBeInTheDocument();
  });

  it('keeps the columns thin and the axis in clean steps', () => {
    const { container } = renderApp(<MonthlyChart months={[{ month: '2026-10', payments: 1137, expenses: 10 }]} />);
    const labels = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(['0', '500', '1k', '1.5k'])); // 0, 500, 1,000, 1,500 rather than 0, 1,137...
  });

  it('shows the figures of a month, with the net, when it is hovered or focused', async () => {
    renderApp(<MonthlyChart months={MONTHS} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const october = screen.getByRole('img', { name: /October 2026/ });
    fireEvent.mouseEnter(october);
    const tip = await screen.findByRole('status');
    expect(within(tip).getByText(formatMoney(900))).toBeInTheDocument();
    expect(within(tip).getByText(formatMoney(1000))).toBeInTheDocument();
    expect(within(tip).getByText(formatMoney(-100))).toBeInTheDocument(); // net
    fireEvent.mouseLeave(october.closest('div')!.parentElement!);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    screen.getByRole('img', { name: /August 2026/ }).focus();
    expect(await screen.findByRole('status')).toHaveTextContent(formatMoney(800)); // 1200 - 400
  });

  it('can be read as a table instead', async () => {
    renderApp(<MonthlyChart months={MONTHS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table', { name: 'Month by month' });
    const september = within(table).getByText('September 2026').closest('tr') as HTMLElement;
    expect(within(september).getByText(formatMoney(250.5))).toBeInTheDocument();
    expect(within(september).getByText(formatMoney(-250.5))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says so, instead of drawing an empty chart', () => {
    renderApp(<MonthlyChart months={[]} />);
    expect(screen.getByText('Nothing came in or went out in this period.')).toBeInTheDocument();
  });

  it('handles a period where nothing but zeros happened', () => {
    const { container } = renderApp(<MonthlyChart months={[{ month: '2026-10', payments: 0, expenses: 0 }]} />);
    expect(container.querySelectorAll('svg path')).toHaveLength(0);
    expect(screen.getByText(/^Oct/)).toBeInTheDocument();
  });
});

describe('the chart on the summary page', () => {
  it('shows the months of the chosen period', async () => {
    api.routes['GET /auth/me'] = () => json(200, { user: user('admin') });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /finance/summary'] = () => json(200, {
      from: null, to: null, payments: { total: 2100, count: 3, byType: [{ type: 'clinic', total: 2100, count: 3 }] },
      expenses: { total: 1650.5, count: 3, byType: [] }, byMonth: MONTHS, net: 449.5, debts: { total: 0, patients: 0, offers: 0, top: [] },
    });
    renderApp(<App />, '/summary');
    expect(await screen.findByText('Month by month')).toBeInTheDocument();
    expect(screen.getByText(/^Sep/)).toBeInTheDocument();
  });
});

describe('by doctor page', () => {
  const rows = [
    { doctor: { id: 1, fname: 'Aya', lname: 'Al Ghali', kind: 'owner' }, offers: { count: 4, value: 2400 }, collected: 1500, debts: 900, commissionBalance: 120, fees: 35 },
    { doctor: { id: 2, fname: 'Cidra', lname: 'Specialist', kind: 'external' }, offers: { count: 2, value: 700 }, collected: 200, debts: 500, commissionBalance: null, fees: 0 },
  ];
  const last = () => api.calls.filter((c) => c.path === '/finance/doctors').at(-1)!;
  const setup = (role: string, doctors: unknown[] = rows, extra: object = {}) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
    api.routes['GET /config'] = () => json(200, CONFIG);
    api.routes['GET /finance/doctors'] = () => json(200, { from: '2026-10-01', to: '2026-10-15', doctors });
  };

  it('is for admins and doctors, not staff', async () => {
    setup('staff');
    renderApp(<App />, '/by-doctor');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/finance/doctors')).toBe(false);
  });

  it('shows each doctor’s offers, collections, debts, commission and fees for the current month', async () => {
    setup('admin');
    renderApp(<App />, '/by-doctor');
    const aya = (await screen.findByText('Aya Al Ghali')).closest('tr') as HTMLElement;
    for (const v of [formatMoney(2400), formatMoney(1500), formatMoney(900), formatMoney(120), formatMoney(35)]) expect(within(aya).getByText(v), v).toBeInTheDocument();
    expect(within(aya).getByText('4')).toBeInTheDocument();
    expect(within(aya).getByText('Owner')).toBeInTheDocument();
    expect(last().query.get('from')).toBe('2026-10-01');
    expect(last().query.get('to')).toBe('2026-10-15');
  });

  it('says so, instead of a wrong figure, when a specialist’s commission percentage is not set', async () => {
    setup('admin');
    renderApp(<App />, '/by-doctor');
    const cidra = (await screen.findByText('Cidra Specialist')).closest('tr') as HTMLElement;
    expect(within(cidra).getByText('Not set')).toBeInTheDocument();
    expect(within(cidra).getByText('External')).toBeInTheDocument();
  });

  it('sorts by any column in the browser, and asks again when the period changes', async () => {
    setup('admin');
    renderApp(<App />, '/by-doctor');
    await screen.findByText('Aya Al Ghali');
    const names = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent?.slice(0, 5));
    expect(names()).toEqual(['Aya A', 'Cidra']);
    await userEvent.click(screen.getByRole('button', { name: 'Collected' }));
    await userEvent.click(screen.getByRole('button', { name: 'Collected' })); // descending
    await waitFor(() => expect(names()).toEqual(['Aya A', 'Cidra']));
    await userEvent.click(screen.getByRole('button', { name: 'Owed by patients' }));
    await waitFor(() => expect(names()).toEqual(['Cidra', 'Aya A'])); // 500 before 900
    await userEvent.click(screen.getByRole('button', { name: 'Last month' }));
    await waitFor(() => expect(last().query.get('from')).toBe('2026-09-01'));
    expect(last().query.get('to')).toBe('2026-09-30');
  });

  it('shows a doctor his own figures, with wording about his patients', async () => {
    setup('doctor', [rows[0]], { doctor: { id: 1, kind: 'owner' } });
    renderApp(<App />, '/by-doctor');
    expect(await screen.findByText('Aya Al Ghali')).toBeInTheDocument();
    expect(screen.getByText('Your patients: treatment offers made, money collected and what is still owed.')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('says there is nothing to show for a doctor login that is not linked', async () => {
    setup('doctor', [], { doctor: null });
    renderApp(<App />, '/by-doctor');
    expect(await screen.findByText('No doctor to show.')).toBeInTheDocument();
  });
});
