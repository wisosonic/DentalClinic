import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { formatMoney } from '../lib/money';
import { errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((month, i) => ({ month, payments: i * 100, expenses: i * 40 }));

const MONEY = {
  role: 'admin', byMonth: MONTHS,
  topDebts: [{ patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, owed: 600 }, { patient: { id: 8, fname: 'Nour', lname: 'Haddad' }, owed: 300 }],
  appointmentsByStatus: [{ status: 'pending', count: 2 }, { status: 'confirmed', count: 5 }, { status: 'completed', count: 9 }, { status: 'cancelled', count: 0 }, { status: 'no_show', count: 1 }],
  topProcedures: [{ id: 1, name: 'Cleaning', count: 8 }, { id: 2, name: 'Root canal', count: 3 }],
};
const FRONT_DESK = {
  role: 'staff',
  appointmentsPerDay: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((date, i) => ({ date, count: i === 0 ? 4 : i === 3 ? 2 : 0 })),
  overdueLabOrders: { count: 2, oldest: [{ id: 3, item: 'Zirconia crown', lab: 'Kadi Lab', patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, dueAt: '2026-09-20' }] },
  offersAwaitingAcceptance: 3,
};

const signIn = (role: string, charts: object | null, extra: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 100, total: 0 } });
  if (charts) api.routes['GET /dashboard/charts'] = () => json(200, charts);
};

describe('dashboard insights: admin', () => {
  it('draws the month chart, the status and procedure bars, and the biggest debts', async () => {
    signIn('admin', MONEY);
    renderApp(<App />, '/');
    const insights = await screen.findByRole('region', { name: 'Insights' });
    expect(await within(insights).findByText('Payments and expenses, last 6 months')).toBeInTheDocument();
    expect(within(insights).getByRole('group', { name: 'Legend' })).toHaveTextContent('Expenses');

    const status = within(insights).getByRole('list', { name: 'Appointments by status' });
    expect(within(status).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Pending2', 'Confirmed5', 'Completed9', 'No-show1']); // the empty status is left out

    const procedures = within(insights).getByRole('list', { name: 'Most booked procedures' });
    expect(within(procedures).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Cleaning8', 'Root canal3']);

    const debts = within(insights).getByRole('list', { name: 'Biggest debts' });
    expect(within(debts).getByRole('link', { name: 'Hicham Cheaib' })).toHaveAttribute('href', '/patients/7');
    expect(within(debts).getByText(formatMoney(600))).toBeInTheDocument();
    expect(within(insights).getByRole('link', { name: 'Browse debts' })).toHaveAttribute('href', '/treatment-offers?debt=1');
  });

  it('lets the month chart be read as a table', async () => {
    signIn('admin', MONEY);
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table', { name: 'Payments and expenses, last 6 months' });
    expect(within(table).getAllByRole('row')).toHaveLength(7); // header and six months
    expect(within(table).getByText(formatMoney(500))).toBeInTheDocument();
  });

  it('says so in words when there is nothing to draw', async () => {
    signIn('admin', { role: 'admin', byMonth: MONTHS.map((m) => ({ ...m, payments: 0, expenses: 0 })), topDebts: [], appointmentsByStatus: [], topProcedures: [] });
    renderApp(<App />, '/');
    expect(await screen.findByText('Nothing came in or went out in the last 6 months.')).toBeInTheDocument();
    expect(screen.getByText('No appointments in the last 30 days.')).toBeInTheDocument();
    expect(screen.getByText('No procedures booked in the last 90 days.')).toBeInTheDocument();
    expect(screen.getByText('Nobody owes anything.')).toBeInTheDocument();
  });

  it('keeps the tiles and shows the error when the charts fail', async () => {
    signIn('admin', null);
    api.routes['GET /dashboard/charts'] = () => json(500, errorBody('INTERNAL', 'Something went wrong'));
    renderApp(<App />, '/');
    expect(await screen.findByText('Booked today')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Insights' })).getByRole('alert')).toBeInTheDocument());
  });
});

describe('dashboard insights: doctor', () => {
  it('shows collections only: no expenses in the legend or the table', async () => {
    signIn('doctor', { ...MONEY, role: 'doctor', byMonth: MONTHS.map((m) => ({ ...m, expenses: 0 })) }, { doctor: { id: 1, kind: 'owner' } });
    renderApp(<App />, '/');
    const insights = await screen.findByRole('region', { name: 'Insights' });
    expect(await within(insights).findByText('Collected, last 6 months')).toBeInTheDocument();
    const legend = within(insights).getByRole('group', { name: 'Legend' });
    expect(legend).toHaveTextContent('Payments');
    expect(legend).not.toHaveTextContent('Expenses');
    await userEvent.click(within(insights).getByRole('button', { name: 'Show as table' }));
    expect(within(insights).queryByRole('columnheader', { name: 'Expenses' })).not.toBeInTheDocument();
    expect(within(insights).queryByRole('columnheader', { name: 'Net profit' })).not.toBeInTheDocument();
  });

  it('shows no charts to a doctor login that is not linked to a profile', async () => {
    signIn('doctor', null, { doctor: null });
    renderApp(<App />, '/');
    await screen.findByText(/not linked to a doctor profile/);
    expect(screen.queryByRole('region', { name: 'Insights' })).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/dashboard/charts')).toBe(false);
  });
});

describe('dashboard insights: staff', () => {
  it('shows the week ahead, the overdue lab orders and the offers waiting, and no money', async () => {
    signIn('staff', FRONT_DESK);
    renderApp(<App />, '/');
    const insights = await screen.findByRole('region', { name: 'Insights' });
    const week = await within(insights).findByRole('list', { name: 'Appointments, next 7 days' });
    expect(within(week).getAllByRole('listitem')).toHaveLength(7);
    expect(within(week).getAllByRole('listitem')[0]).toHaveTextContent('4');
    expect(within(week).getAllByRole('listitem')[3]).toHaveTextContent('2');

    const overdue = within(insights).getByRole('region', { name: 'Overdue lab orders' });
    expect(within(overdue).getByText('2')).toBeInTheDocument();
    expect(within(overdue).getByText('Zirconia crown · Kadi Lab')).toBeInTheDocument();
    expect(within(overdue).getByRole('link', { name: 'Browse overdue orders' })).toHaveAttribute('href', '/lab-orders?overdue=1');
    expect(within(insights.querySelector('[aria-label="Offers awaiting acceptance"]') as HTMLElement).getByText('3')).toBeInTheDocument();

    expect(within(insights).queryByText('Biggest debts')).not.toBeInTheDocument();
    expect(within(insights).queryByRole('button', { name: 'Show as table' })).not.toBeInTheDocument();
  });

  it('says so when nothing is booked or overdue', async () => {
    signIn('staff', { role: 'staff', appointmentsPerDay: FRONT_DESK.appointmentsPerDay.map((d) => ({ ...d, count: 0 })), overdueLabOrders: { count: 0, oldest: [] }, offersAwaitingAcceptance: 0 });
    renderApp(<App />, '/');
    expect(await screen.findByText('Nothing booked in the next 7 days.')).toBeInTheDocument();
    expect(screen.getByText('No overdue orders.')).toBeInTheDocument();
  });
});
