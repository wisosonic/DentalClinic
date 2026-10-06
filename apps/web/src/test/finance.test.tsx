import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { formatMoney } from '../lib/money';
import { PATIENT, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const payment = (extra: object = {}) => ({
  id: 9, offerId: 3, offer: { id: 3, title: 'Crown' }, patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, date: '2026-10-04', amount: 40, remaining: 60, currency: '$',
  method: 'cash', description: null, type: 'clinic', collectedBy: { id: 1, fname: 'Aya', lname: 'Ghali' }, createdAt: '2026-10-04 09:00:00', ...extra,
});
const page = (data: unknown[]) => json(200, { data, meta: { page: 1, pageSize: 25, total: data.length } });

const signIn = (role: string, extra: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /patients'] = () => page([PATIENT]);
};

describe('payments page', () => {
  it('shows a doctor or admin the list, with filters and sorting', async () => {
    signIn('admin');
    api.routes['GET /payments'] = () => page([payment(), payment({ id: 10, amount: 15, method: 'card', remaining: 45 })]);
    renderApp(<App />, '/payments');
    expect(await screen.findAllByText('Crown')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Amount' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/payments').at(-1)!.query.get('sort')).toBe('amount'));
    await userEvent.click(screen.getByLabelText('Paid by'));
    await userEvent.click(await screen.findByRole('option', { name: 'Card' }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/payments').at(-1)!.query.get('method')).toBe('card'));
  });

  it('can be limited to one patient from the patient page, and the filter can be removed', async () => {
    signIn('doctor', { doctor: { id: 1, kind: 'owner' } });
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /payments'] = () => page([payment()]);
    renderApp(<App />, '/payments?patientId=7');
    expect(await screen.findByText('Only Hicham Cheaib')).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path === '/payments').at(-1)!.query.get('patientId')).toBe('7');
    await userEvent.click(within(screen.getByText('Only Hicham Cheaib').closest('.MuiChip-root') as HTMLElement).getByTestId('CancelIcon'));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/payments').at(-1)!.query.has('patientId')).toBe(false));
  });

  it('has an icon on every payment that opens its treatment offer', async () => {
    signIn('admin');
    api.routes['GET /payments'] = () => page([payment(), payment({ id: 10, amount: 15, offerId: 4, offer: { id: 4, title: 'Bridge' } })]);
    renderApp(<App />, '/payments');
    const link = await screen.findByRole('link', { name: `Open the treatment offer of the payment of ${formatMoney(15)}` });
    expect(link).toHaveAttribute('href', '/treatment-offers/4');
    expect(screen.getByRole('link', { name: `Open the treatment offer of the payment of ${formatMoney(40)}` })).toHaveAttribute('href', '/treatment-offers/3');
  });

  it('gives staff only their own recent entries, never the full list, and lets them record one', async () => {
    signIn('staff');
    api.routes['GET /payments/mine'] = () => json(200, { data: [payment()] });
    api.routes['GET /payments/open-offers'] = () => json(200, { data: [{ id: 3, title: 'Crown', price: 100, paid: 40, remaining: 60 }] });
    api.routes['POST /payments'] = () => json(201, { payment: payment({ id: 11, amount: 20, remaining: 40 }) });
    renderApp(<App />, '/payments');
    expect(await screen.findByText('Crown')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/payments' && c.method === 'GET')).toBe(false); // the full list is not even asked for
    expect(screen.queryByLabelText('Search payments')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText(/^Patient/), 'Hic');
    await userEvent.click(await screen.findByRole('option', { name: /Hicham Cheaib/ }));
    await userEvent.click(await within(form).findByLabelText(/^Treatment offer/));
    await userEvent.click(await screen.findByRole('option', { name: /Crown/ }));
    expect(await within(form).findByText(`Still owed ${formatMoney(60)}`)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '20' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/payments')?.body).toMatchObject({ offerId: 3, amount: 20, method: 'cash' }));
  });

  it('lets staff fix an entry of theirs', async () => {
    signIn('staff');
    api.routes['GET /payments/mine'] = () => json(200, { data: [payment()] });
    api.routes['PATCH /payments/9'] = () => json(200, { payment: payment({ amount: 35 }) });
    renderApp(<App />, '/payments');
    await userEvent.click(await screen.findByRole('button', { name: `Edit payment of ${formatMoney(40)}` }));
    const form = await screen.findByRole('dialog');
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '35' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH' && c.path === '/payments/9')?.body).toMatchObject({ amount: 35 }));
  });

  it('explains when a patient has no treatment offer to pay', async () => {
    signIn('staff');
    api.routes['GET /payments/mine'] = () => json(200, { data: [] });
    api.routes['GET /payments/open-offers'] = () => json(200, { data: [] });
    renderApp(<App />, '/payments');
    await userEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText(/^Patient/), 'Hic');
    await userEvent.click(await screen.findByRole('option', { name: /Hicham Cheaib/ }));
    expect(await within(form).findByText('This patient has no treatment offer waiting for a payment.')).toBeInTheDocument();
  });
});

describe('PDF downloads', () => {
  it('gives staff a receipt for the payments they entered', async () => {
    signIn('staff');
    api.routes['GET /payments/mine'] = () => json(200, { data: [payment()] });
    renderApp(<App />, '/payments');
    expect(await screen.findByRole('link', { name: `Receipt for payment of ${formatMoney(40)}` })).toHaveAttribute('href', '/api/v1/payments/9/receipt');
  });
});
