import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { formatMoney } from '../lib/money';
import { PATIENT, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const order = (extra: object = {}) => ({
  id: 3, lab: { id: 1, name: 'Kadi Lab' }, patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, item: 'Zirconia crown', tooth: { id: 3, index: '16' }, appointmentId: null,
  cost: 85, currency: '$', status: 'draft', sentAt: null, dueAt: '2026-10-10', receivedAt: null, overdue: false, ...extra,
});
const page = (data: unknown[]) => json(200, { data, meta: { page: 1, pageSize: 50, total: data.length } });
const LABS = [{ id: 1, name: 'Kadi Lab', contact: 'Rami', address: 'Beirut', phone: '03 123', description: null }];

const signIn = (role: string, extra: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /labs'] = (c) => json(200, { data: c.query.get('full') ? LABS : [{ id: 1, name: 'Kadi Lab' }] });
  api.routes['GET /suppliers'] = () => json(200, { data: [] });
  api.routes['GET /teeth'] = () => json(200, { data: [{ id: 3, index: '16', name: 'Upper right first molar', type: 'Molar' }] });
  api.routes['GET /patients'] = () => json(200, { data: [PATIENT], meta: { page: 1, pageSize: 10, total: 1 } });
};

describe('lab orders', () => {
  it('shows staff each order with its dates and cost, and flags the overdue ones', async () => {
    signIn('staff');
    api.routes['GET /lab-orders'] = () => page([order({ overdue: true, dueAt: '2026-10-01' })]);
    renderApp(<App />, '/lab-orders');
    const row = (await screen.findByText('Zirconia crown')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Kadi Lab')).toBeInTheDocument();
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    expect(within(row).getByText('Overdue')).toBeInTheDocument();
    expect(within(row).getByText(formatMoney(85))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New lab order' })).toBeInTheDocument();
  });

  it('shows a doctor the orders without the cost and without any buttons to change them', async () => {
    signIn('doctor', { doctor: { id: 1, kind: 'owner' } });
    api.routes['GET /lab-orders'] = () => page([order({ cost: undefined })]);
    renderApp(<App />, '/lab-orders');
    await screen.findByText('Zirconia crown');
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New lab order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark sent' })).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/labs')).toBe(false); // the lab list is for staff
  });

  it('moves an order along with one button per step', async () => {
    signIn('staff');
    api.routes['GET /lab-orders'] = () => page([order()]);
    api.routes['POST /lab-orders/3/send'] = () => json(200, { order: order({ status: 'sent', sentAt: '2026-10-05' }) });
    renderApp(<App />, '/lab-orders');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark sent' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/lab-orders/3/send')).toBe(true));
    expect(await screen.findByText('Order marked as sent')).toBeInTheDocument();
  });

  it('offers the right next step for each status, and none once fitted', async () => {
    signIn('admin');
    api.routes['GET /lab-orders'] = () => page([order({ id: 1, status: 'sent', item: 'Night guard' }), order({ id: 2, status: 'received', item: 'Retainer' }), order({ id: 4, status: 'fitted', item: 'Veneer' })]);
    renderApp(<App />, '/lab-orders');
    expect(within((await screen.findByText('Night guard')).closest('tr') as HTMLElement).getByRole('button', { name: 'Mark received' })).toBeInTheDocument();
    expect(within(screen.getByText('Retainer').closest('tr') as HTMLElement).getByRole('button', { name: 'Mark fitted' })).toBeInTheDocument();
    const fitted = screen.getByText('Veneer').closest('tr') as HTMLElement;
    expect(within(fitted).queryByRole('button', { name: /Mark/ })).not.toBeInTheDocument();
    expect(within(fitted).queryByRole('button', { name: /Edit order/ })).not.toBeInTheDocument(); // a fitted order is closed
  });

  it('filters through the server, and sorts any column in the browser', async () => {
    signIn('staff');
    api.routes['GET /lab-orders'] = () => page([order({ id: 1, item: 'Bridge', cost: 50 }), order({ id: 2, item: 'Aligner', cost: 200 })]);
    renderApp(<App />, '/lab-orders');
    await screen.findByText('Bridge');
    const items = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[2]!.textContent);
    await userEvent.click(screen.getByRole('button', { name: 'Item' }));
    await waitFor(() => expect(items()).toEqual(['Aligner', 'Bridge']));
    await userEvent.click(screen.getByRole('button', { name: 'Cost' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cost' })); // descending
    await waitFor(() => expect(items()).toEqual(['Aligner', 'Bridge']));
    await userEvent.click(screen.getByLabelText('Overdue only'));
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/lab-orders').at(-1)!.query.get('overdue')).toBe('true'));
  });

  it('creates an order for the chosen patient and lab', async () => {
    signIn('staff');
    api.routes['GET /lab-orders'] = () => page([]);
    api.routes['POST /lab-orders'] = () => json(201, { order: order() });
    renderApp(<App />, '/lab-orders');
    await userEvent.click(await screen.findByRole('button', { name: 'New lab order' }));
    const dialog = await screen.findByRole('dialog', { name: 'New lab order' });
    await userEvent.type(within(dialog).getByLabelText(/Patient/), 'Hic');
    await userEvent.click(await screen.findByRole('option', { name: /Hicham Cheaib/ }));
    await userEvent.click(within(dialog).getByLabelText(/^Lab/));
    await userEvent.click(await screen.findByRole('option', { name: 'Kadi Lab' }));
    await userEvent.type(within(dialog).getByLabelText(/What is ordered/), 'Zirconia crown');
    await userEvent.type(within(dialog).getByLabelText(/Cost to the clinic/), '85');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add order' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/lab-orders')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/lab-orders')!.body).toMatchObject({ patientId: 7, labId: 1, item: 'Zirconia crown', cost: 85 });
    expect(await screen.findByText('Lab order added')).toBeInTheDocument();
  });

  it('asks for the lab and the item before saving', async () => {
    signIn('staff');
    api.routes['GET /lab-orders'] = () => page([]);
    renderApp(<App />, '/lab-orders');
    await userEvent.click(await screen.findByRole('button', { name: 'New lab order' }));
    const dialog = await screen.findByRole('dialog', { name: 'New lab order' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add order' }));
    expect(await within(dialog).findByText('Describe what is ordered')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('labs and suppliers', () => {
  it('is for admins and staff, not doctors', async () => {
    signIn('doctor', { doctor: { id: 1, kind: 'owner' } });
    renderApp(<App />, '/labs');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/labs')).toBe(false);
  });

  it('lists the labs with their contact details', async () => {
    signIn('staff');
    renderApp(<App />, '/labs');
    const row = (await screen.findByText('Kadi Lab')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Rami')).toBeInTheDocument();
    expect(within(row).getByText('03 123')).toBeInTheDocument();
    expect(within(row).getByText('Beirut')).toBeInTheDocument();
  });

  it('adds a supplier, and requires a name and a phone', async () => {
    signIn('admin');
    api.routes['POST /suppliers'] = () => json(201, { entry: { id: 5, name: 'Safadi', contact: null, address: null, phone: '03 555', description: null } });
    renderApp(<App />, '/suppliers');
    await userEvent.click(await screen.findByRole('button', { name: 'New supplier' }));
    const dialog = await screen.findByRole('dialog', { name: 'New supplier' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add supplier' }));
    expect(await within(dialog).findByText('Name is required')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Safadi');
    await userEvent.type(within(dialog).getByLabelText(/^Phone/), '03 555');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add supplier' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/suppliers')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ name: 'Safadi', phone: '03 555' });
    expect(await screen.findByText('Added')).toBeInTheDocument();
  });

  it('explains why a lab that is in use cannot be deleted', async () => {
    signIn('staff');
    api.routes['DELETE /labs/1'] = () => json(409, errorBody('IN_USE', 'This lab is used by existing records and cannot be deleted'));
    renderApp(<App />, '/labs');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Kadi Lab' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete lab' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This lab is used by existing records and cannot be deleted');
  });

  it('searches and sorts the list in the browser', async () => {
    signIn('staff');
    api.routes['GET /labs'] = () => json(200, { data: [
      { id: 1, name: 'Zed Lab', contact: null, address: null, phone: '1', description: null },
      { id: 2, name: 'Alpha Lab', contact: null, address: null, phone: '2', description: null },
    ] });
    renderApp(<App />, '/labs');
    await screen.findByText('Zed Lab');
    const names = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(names()).toEqual(['Alpha Lab', 'Zed Lab']); // by name to begin with
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    await waitFor(() => expect(names()).toEqual(['Zed Lab', 'Alpha Lab']));
    await userEvent.type(screen.getByLabelText('Search labs'), 'alp');
    await waitFor(() => expect(names()).toEqual(['Alpha Lab']));
  });
});
