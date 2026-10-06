import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { formatMoney } from '../lib/money';
import { json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const DOCTORS = [
  { id: 1, fname: 'Aya', lname: 'Al Ghali', speciality: null, gender: null, kind: 'owner' },
  { id: 2, fname: 'Cidra', lname: 'Specialist', speciality: null, gender: null, kind: 'external', commissionPercent: 30 },
];
const expense = (extra: object = {}) => ({
  id: 4, type: 'clinic', date: '2026-10-04', amount: 25, currency: '$', description: 'Water bill', lab: null, supplier: null, doctor: null, appointment: null, createdBy: 'Sam Staff', ...extra,
});
const list = (data: unknown[], sum = 25) => json(200, { data, meta: { page: 1, pageSize: 25, total: data.length }, sum });

const signIn = (role: string, extra: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /doctors'] = () => json(200, { data: DOCTORS });
  api.routes['GET /labs'] = () => json(200, { data: [{ id: 1, name: 'Kadi Lab' }] });
  api.routes['GET /suppliers'] = () => json(200, { data: [{ id: 2, name: 'Safadi' }] });
};

describe('expenses page', () => {
  it('is for admins and staff, not doctors', async () => {
    signIn('doctor', { doctor: { id: 1, kind: 'owner' } });
    renderApp(<App />, '/expenses');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/expenses')).toBe(false);
  });

  it('lists expenses with what each was for and the total, and asks the server to filter and sort', async () => {
    signIn('staff');
    api.routes['GET /expenses'] = () => list([expense(), expense({ id: 5, type: 'lab', description: null, lab: { id: 1, name: 'Kadi Lab' }, amount: 500 })], 525);
    renderApp(<App />, '/expenses');
    const row = (await screen.findByText('Water bill')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Clinic')).toBeInTheDocument();
    expect(within((await screen.findByText('Kadi Lab')).closest('tr') as HTMLElement).getByText(formatMoney(500))).toBeInTheDocument();
    expect(screen.getByText(`2 shown, ${formatMoney(525)} in total`)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Amount' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/expenses').at(-1)!.query.get('sort')).toBe('amount'));
    await userEvent.click(screen.getByLabelText('Type'));
    await userEvent.click(await screen.findByRole('option', { name: 'Lab' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/expenses').at(-1)!.query.get('type')).toBe('lab'));
  });

  it('does not offer personal expenses to staff, but does to admins', async () => {
    signIn('staff');
    api.routes['GET /expenses'] = () => list([]);
    renderApp(<App />, '/expenses');
    await userEvent.click(await screen.findByLabelText('Type'));
    expect(screen.queryByRole('option', { name: 'Personal' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Supplier' })).toBeInTheDocument();
  });

  it('shows admins the personal type', async () => {
    signIn('admin');
    api.routes['GET /expenses'] = () => list([]);
    renderApp(<App />, '/expenses');
    await userEvent.click(await screen.findByLabelText('Type'));
    expect(await screen.findByRole('option', { name: 'Personal' })).toBeInTheDocument();
  });

  it('adds a lab expense and makes the person choose the lab first', async () => {
    signIn('staff');
    api.routes['GET /expenses'] = () => list([]);
    api.routes['POST /expenses'] = () => json(201, { expense: expense({ type: 'lab' }) });
    renderApp(<App />, '/expenses');
    await userEvent.click(await screen.findByRole('button', { name: 'New expense' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText(/^Type/));
    await userEvent.click(await screen.findByRole('option', { name: 'Lab' }));
    fireEvent.change(within(dialog).getByLabelText(/^Amount/), { target: { value: '500' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }));
    expect(await within(dialog).findByText('Choose the lab')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.click(within(dialog).getByRole('combobox', { name: /^Lab/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Kadi Lab' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/expenses')?.body).toMatchObject({ type: 'lab', labId: 1, amount: 500, date: '2026-10-05' }));
    expect(await screen.findByText('Expense added')).toBeInTheDocument();
  });

  it('records a specialist fee for a visit the specialist treated', async () => {
    signIn('admin');
    api.routes['GET /expenses'] = () => list([]);
    api.routes['GET /expenses/commission-appointments'] = () => json(200, { data: [{ id: 9, date: '2026-10-01', time: '10:00', patient: { fname: 'Hicham', lname: 'Cheaib' } }] });
    api.routes['POST /expenses'] = () => json(201, { expense: expense({ type: 'commission' }) });
    renderApp(<App />, '/expenses');
    await userEvent.click(await screen.findByRole('button', { name: 'New expense' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText(/^Type/));
    await userEvent.click(await screen.findByRole('option', { name: 'Specialist fee' }));
    expect(within(dialog).getByLabelText(/^Visit/)).toHaveAttribute('aria-disabled', 'true'); // pick the specialist first
    await userEvent.click(within(dialog).getByLabelText(/^Specialist paid/));
    await userEvent.click(await screen.findByRole('option', { name: 'Cidra Specialist' })); // owners are not offered
    expect(screen.queryByRole('option', { name: 'Aya Al Ghali' })).not.toBeInTheDocument();
    await userEvent.click(await within(dialog).findByLabelText(/^Visit/));
    await userEvent.click(await screen.findByRole('option', { name: /Hicham Cheaib/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Amount/), { target: { value: '35' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/expenses')?.body).toMatchObject({ type: 'commission', doctorId: 2, appointmentId: 9, amount: 35 }));
  });

  it('edits and deletes an expense, saying it goes to the Trash', async () => {
    signIn('staff');
    api.routes['GET /expenses'] = () => list([expense()]);
    api.routes['PATCH /expenses/4'] = () => json(200, { expense: expense({ amount: 30 }) });
    api.routes['DELETE /expenses/4'] = () => new Response(null, { status: 204 });
    renderApp(<App />, '/expenses');
    await userEvent.click(await screen.findByRole('button', { name: `Edit expense of ${formatMoney(25)}` }));
    const form = await screen.findByRole('dialog');
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '30' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/expenses/4')?.body).toMatchObject({ amount: 30, type: 'clinic' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(await screen.findByRole('button', { name: `Delete expense of ${formatMoney(25)}` }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(/goes to the Trash/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete expense' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/expenses/4')).toBe(true));
  });
});

describe('commission page', () => {
  const owner = { id: 1, fname: 'Aya', lname: 'Al Ghali' };
  const specialist = { id: 2, fname: 'Cidra', lname: 'Specialist', commissionPercent: 30 };
  const statement = (extra: object = {}) => ({
    lines: [
      { specialist, owner, collected: 200, owed: 60, received: 25, balance: 35 },
      { specialist, owner: null, collected: 100, owed: 30, received: 0, balance: 30 },
    ],
    fees: [{ specialist: { id: 2, fname: 'Cidra', lname: 'Specialist' }, owner, paid: 50, count: 2 }],
    missingPercentage: [],
    ...extra,
  });
  const cpay = (extra: object = {}) => ({ id: 7, date: '2026-10-02', amount: 25, currency: '$', method: 'cash', description: null, specialist: { id: 2, fname: 'Cidra', lname: 'Specialist' }, owner, ...extra });

  it('is for admins and doctors only', async () => {
    signIn('staff');
    renderApp(<App />, '/commission');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.startsWith('/commission'))).toBe(false);
  });

  it('shows what each specialist owes each owner, with totals and the fees paid', async () => {
    signIn('admin');
    api.routes['GET /commission/statement'] = () => json(200, statement());
    api.routes['GET /commission/payments'] = () => json(200, { data: [cpay()] });
    renderApp(<App />, '/commission');
    const row = (await screen.findAllByText('Cidra Specialist'))[0]!.closest('tr') as HTMLElement;
    expect(within(row).getByText(formatMoney(60))).toBeInTheDocument();
    expect(within(row).getByText(formatMoney(35))).toBeInTheDocument();
    expect(screen.getByText('No visit to go by')).toBeInTheDocument();
    const total = screen.getByText('Total').closest('tr') as HTMLElement;
    expect(within(total).getByText(formatMoney(90))).toBeInTheDocument(); // owed 60 + 30
    expect(within(total).getByText(formatMoney(65))).toBeInTheDocument(); // balance 35 + 30
    expect(screen.getByText('Fees paid to specialists')).toBeInTheDocument();
  });

  it('warns, instead of showing wrong figures, when a percentage is missing', async () => {
    signIn('admin');
    api.routes['GET /commission/statement'] = () => json(200, statement({
      lines: [{ specialist: { ...specialist, commissionPercent: null }, owner, collected: 200, owed: null, received: 0, balance: null }],
      missingPercentage: [{ id: 2, fname: 'Cidra', lname: 'Specialist' }], fees: [],
    }));
    api.routes['GET /commission/payments'] = () => json(200, { data: [] });
    renderApp(<App />, '/commission');
    expect(await screen.findByText(/No commission percentage is set for Cidra Specialist/)).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('sends the period to the server', async () => {
    signIn('admin');
    api.routes['GET /commission/statement'] = () => json(200, statement());
    api.routes['GET /commission/payments'] = () => json(200, { data: [] });
    renderApp(<App />, '/commission');
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/commission/statement').at(-1)!.query.get('from')).toBe('2026-09-01'));
  });

  it('lets an admin record what a specialist paid an owner, choosing both', async () => {
    signIn('admin');
    api.routes['GET /commission/statement'] = () => json(200, statement());
    api.routes['GET /commission/payments'] = () => json(200, { data: [] });
    api.routes['POST /commission/payments'] = () => json(201, { payment: cpay() });
    renderApp(<App />, '/commission');
    await userEvent.click(await screen.findByRole('button', { name: 'Record commission received' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    expect(await within(dialog).findByText('Choose the specialist')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose the owner')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText(/^Paid by \(specialist\)/));
    await userEvent.click(await screen.findByRole('option', { name: 'Cidra Specialist' }));
    await userEvent.click(within(dialog).getByLabelText(/^Received by/));
    await userEvent.click(await screen.findByRole('option', { name: 'Aya Al Ghali' }));
    fireEvent.change(within(dialog).getByLabelText(/^Amount/), { target: { value: '25' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/commission/payments')?.body).toMatchObject({ specialistId: 2, ownerId: 1, amount: 25, method: 'cash' }));
    expect(await screen.findByText('Commission payment recorded')).toBeInTheDocument();
  });

  it('lets an owner record only what he received himself (the owner is fixed), and a specialist none', async () => {
    signIn('doctor', { doctor: { id: 1, kind: 'owner' } });
    api.routes['GET /commission/statement'] = () => json(200, statement());
    api.routes['GET /commission/payments'] = () => json(200, { data: [cpay()] });
    renderApp(<App />, '/commission');
    await userEvent.click(await screen.findByRole('button', { name: 'Record commission received' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/^Received by/)).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByLabelText(/^Received by/)).toHaveTextContent('Aya Al Ghali');
  });

  it('lets an admin change who received a payment, and fixes an old one with no owner', async () => {
    signIn('admin');
    api.routes['GET /commission/statement'] = () => json(200, statement({ fees: [] }));
    api.routes['GET /commission/payments'] = () => json(200, { data: [cpay({ owner: null })] });
    api.routes['PATCH /commission/payments/7'] = () => json(200, { payment: cpay() });
    renderApp(<App />, '/commission');
    await userEvent.click(await screen.findByRole('button', { name: `Edit payment of ${formatMoney(25)}` }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This payment does not say who received it: choose the owner.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText(/^Received by/));
    await userEvent.click(await screen.findByRole('option', { name: 'Aya Al Ghali' }));
    await userEvent.click(within(dialog).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/commission/payments/7')?.body).toMatchObject({ ownerId: 1 }));
  });

  it('gives a specialist the figures only, no way to record', async () => {
    signIn('doctor', { doctor: { id: 2, kind: 'external' } });
    api.routes['GET /commission/statement'] = () => json(200, statement({ fees: [] }));
    api.routes['GET /commission/payments'] = () => json(200, { data: [cpay()] });
    renderApp(<App />, '/commission');
    await screen.findAllByText('Cidra Specialist');
    expect(screen.queryByRole('button', { name: 'Record commission received' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Edit payment of ${formatMoney(25)}` })).not.toBeInTheDocument();
  });

  it('deletes a commission payment after a confirmation', async () => {
    signIn('admin');
    api.routes['GET /commission/statement'] = () => json(200, statement({ fees: [] }));
    api.routes['GET /commission/payments'] = () => json(200, { data: [cpay()] });
    api.routes['DELETE /commission/payments/7'] = () => new Response(null, { status: 204 });
    renderApp(<App />, '/commission');
    await userEvent.click(await screen.findByRole('button', { name: `Delete payment of ${formatMoney(25)}` }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete payment' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/commission/payments/7')).toBe(true));
  });
});
