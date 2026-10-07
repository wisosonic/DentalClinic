import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { errorMessage } from '../lib/baseQuery';
import { formatMoney } from '../lib/money';
import { CLINIC, CLINIC_DOCTOR, PATIENT, UNIT, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };

const item = (extra: object = {}) => ({
  id: 1, sequence: 1, description: 'Root canal', tooth: { id: 3, index: '16' }, category: { id: 2, name: 'Endodontics' }, price: 120, cost: 40, status: 'pending', appointment: null, completedAt: null, ...extra,
});
const offer = (extra: object = {}) => ({
  id: 9, patientId: 7, patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, doctor: { id: 1, fname: 'Aya', lname: 'Al Ghali' }, title: 'Full rehabilitation', description: null,
  status: 'accepted', startDate: null, notes: null, price: 420.5, cost: 140.25, currency: '$', paid: 0, remaining: 420.5, paymentState: 'unpaid', workState: 'not_started',
  progress: { done: 0, total: 2, percent: 0 }, createdAt: '2026-10-01 09:00:00',
  items: [item(), item({ id: 2, sequence: 2, description: 'Crown', category: null, tooth: null, price: 300.5, cost: 100.25 })], ...extra,
});
const payment = (extra: object = {}) => ({
  id: 12, offerId: 9, offer: { id: 9, title: 'Full rehabilitation' }, patient: { id: 7, fname: 'Hicham', lname: 'Cheaib' }, date: '2026-10-04', amount: 100, remaining: 320.5, currency: '$',
  method: 'cash', description: null, type: 'clinic', collectedBy: { id: 1, fname: 'Aya', lname: 'Ghali' }, createdAt: '2026-10-04 09:00:00', ...extra,
});
const page = (data: unknown[]) => json(200, { data, meta: { page: 1, pageSize: 25, total: data.length } });

const DOCTOR = { doctor: { id: 1, kind: 'owner' } };
const signIn = (role: string, extra: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /categories'] = () => json(200, { data: [{ id: 2, name: 'Endodontics', priceMin: 80, priceMax: 200, features: [], featurePrices: [] }] });
  api.routes['GET /teeth'] = () => json(200, { data: [{ id: 3, index: '16', name: 'Upper right first molar', type: 'Molar' }] });
  api.routes['GET /patients'] = () => page([PATIENT]);
};
const lastCall = (path: string) => api.calls.filter((c) => c.path === path).at(-1)!;

describe('treatment offers list', () => {
  it('shows each offer with its three indicators, total and what is left', async () => {
    signIn('doctor', DOCTOR);
    api.routes['GET /treatment-offers'] = () => page([offer({ paid: 100, remaining: 320.5, paymentState: 'partly_paid', workState: 'in_progress', progress: { done: 1, total: 2, percent: 50 } })]);
    renderApp(<App />, '/treatment-offers');
    const row = (await screen.findByText('Full rehabilitation')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Hicham Cheaib')).toBeInTheDocument();
    expect(within(row).getByText('Accepted')).toBeInTheDocument();
    expect(within(row).getByText('Partly paid')).toBeInTheDocument();
    expect(within(row).getByText('1 of 2 done')).toBeInTheDocument();
    expect(within(row).getByText(formatMoney(420.5))).toBeInTheDocument();
    expect(within(row).getByText(formatMoney(320.5))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New treatment offer' })).toBeInTheDocument();
  });

  it('lets staff read the offers but not start one', async () => {
    signIn('staff');
    api.routes['GET /treatment-offers'] = () => page([offer({ cost: undefined })]);
    renderApp(<App />, '/treatment-offers');
    await screen.findByText('Full rehabilitation');
    expect(screen.queryByRole('button', { name: 'New treatment offer' })).not.toBeInTheDocument();
  });

  it('asks the server to sort and filter, and can be limited to a patient or to what is owed', async () => {
    signIn('admin');
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    api.routes['GET /treatment-offers'] = () => page([offer()]);
    renderApp(<App />, '/treatment-offers?patientId=7');
    await screen.findByText('Only Hicham Cheaib');
    expect(lastCall('/treatment-offers').query.get('patientId')).toBe('7');
    await userEvent.click(screen.getByRole('button', { name: 'Total' }));
    await waitFor(() => expect(lastCall('/treatment-offers').query.get('sort')).toBe('price'));
    await userEvent.click(screen.getByRole('button', { name: 'Work' }));
    await waitFor(() => expect(lastCall('/treatment-offers').query.get('sort')).toBe('progress'));
    await userEvent.click(screen.getByLabelText('Status'));
    await userEvent.click(await screen.findByRole('option', { name: 'Draft' }));
    await waitFor(() => expect(lastCall('/treatment-offers').query.get('status')).toBe('draft'));
    expect(screen.queryByRole('option', { name: 'Sent' })).not.toBeInTheDocument(); // nothing is sent online
    await userEvent.click(screen.getByLabelText('Payment'));
    await userEvent.click(await screen.findByRole('option', { name: 'Partly paid' }));
    await waitFor(() => expect(lastCall('/treatment-offers').query.get('paymentState')).toBe('partly_paid'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only with a balance owed' }));
    await waitFor(() => expect(lastCall('/treatment-offers').query.get('debt')).toBe('1'));
  });

  it('says so when nothing matches, and sends the old quote and plan addresses here', async () => {
    signIn('admin');
    api.routes['GET /treatment-offers'] = () => page([]);
    renderApp(<App />, '/quotes');
    expect(await screen.findByText('No treatment offers match.')).toBeInTheDocument();
  });
});

describe('a treatment offer', () => {
  const open = async (role: string, o: object, extra: object = {}, payments: unknown[] = []) => {
    signIn(role, extra);
    api.routes['GET /treatment-offers/9'] = () => json(200, { offer: o });
    api.routes['GET /payments'] = () => page(payments);
    renderApp(<App />, '/treatment-offers/9');
    await screen.findByRole('heading', { name: 'Full rehabilitation' });
  };

  it('shows its work in order with prices, the cost for a doctor, and a button to book each item still to do', async () => {
    await open('doctor', offer(), DOCTOR);
    const root = screen.getByText('Root canal').closest('tr') as HTMLElement;
    expect(within(root).getByText('Endodontics')).toBeInTheDocument();
    expect(within(root).getByText('To do')).toBeInTheDocument();
    expect(within(root).getByText(formatMoney(120))).toBeInTheDocument();
    expect(within(root).getByText(formatMoney(40))).toBeInTheDocument(); // the cost
    expect(within(root).getByRole('button', { name: 'Book a visit for Root canal' })).toBeInTheDocument();
    expect(screen.getByText('Hicham Cheaib · Dr. Aya Al Ghali')).toBeInTheDocument();
    expect(screen.getByText('Clinic cost')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument();
  });

  it('shows the three indicators and the totals', async () => {
    await open('doctor', offer({ paid: 100, remaining: 320.5, paymentState: 'partly_paid', workState: 'in_progress', progress: { done: 1, total: 2, percent: 50 } }), DOCTOR);
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Partly paid')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Total').parentElement).toHaveTextContent(formatMoney(420.5));
    expect(screen.getByText('1 of 2 done')).toBeInTheDocument();
  });

  it('never shows the cost to staff, who can still book visits and record a payment', async () => {
    await open('staff', offer({ cost: undefined, items: [item({ cost: undefined })] }));
    expect(screen.queryByText('Clinic cost')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book a visit for Root canal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rejected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Root canal as done' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Payments' })).not.toBeInTheDocument(); // no payment history for staff
    expect(api.calls.some((c) => c.path === '/payments')).toBe(false);
  });

  it('shows a booked item with its visit and no booking button', async () => {
    await open('doctor', offer({ items: [item({ status: 'scheduled', appointment: { id: 5, date: '2026-10-06', time: '10:00', status: 'confirmed' } })] }), DOCTOR);
    const row = screen.getByText('Root canal').closest('tr') as HTMLElement;
    expect(within(row).getByText('Booked')).toBeInTheDocument();
    expect(within(row).getByText('10:00')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Book a visit/ })).not.toBeInTheDocument();
  });

  it('asks for nothing more on a new offer (it is accepted already), only to cancel or change it', async () => {
    await open('doctor', offer(), DOCTOR);
    for (const gone of ['Patient accepted', 'Mark as sent', 'Mark as expired', 'Rejected']) expect(screen.queryByRole('button', { name: gone }), gone).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel offer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('lets a draft be accepted, and asks the server to move it along', async () => {
    await open('doctor', offer({ status: 'draft' }), DOCTOR);
    api.routes['POST /treatment-offers/9/accept'] = () => json(200, { offer: offer({ status: 'accepted' }) });
    expect(screen.queryByRole('button', { name: 'Mark as sent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as expired' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Patient accepted' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/treatment-offers/9/accept')).toBe(true));
    expect(await screen.findByText('Offer accepted')).toBeInTheDocument();
  });

  it('cannot be rejected or cancelled once it has payments or visits', async () => {
    await open('doctor', offer({ paid: 100, remaining: 320.5, paymentState: 'partly_paid' }), DOCTOR, [payment()]);
    expect(screen.queryByRole('button', { name: 'Rejected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel offer' })).not.toBeInTheDocument();
  });

  it('does not offer to book before the patient accepts', async () => {
    await open('doctor', offer({ status: 'draft' }), DOCTOR);
    expect(screen.queryByRole('button', { name: /Book a visit for/ })).not.toBeInTheDocument();
    expect(screen.getByText('This offer is a draft. Visits and payments come once the patient has accepted it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Patient accepted' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument(); // a draft takes no payments
  });

  it('lists the payments for a doctor and records a new one on this offer', async () => {
    await open('doctor', offer({ paid: 100, remaining: 320.5, paymentState: 'partly_paid' }), DOCTOR, [payment()]);
    const region = within(screen.getByRole('region', { name: 'Payments' }));
    expect(await region.findByText('Cash')).toBeInTheDocument();
    expect(region.getByRole('link', { name: `Receipt for payment of ${formatMoney(100)}` })).toHaveAttribute('href', '/api/v1/payments/12/receipt');
    api.routes['POST /payments'] = () => json(201, { payment: payment({ id: 13, amount: 50 }) });
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    const form = await screen.findByRole('dialog');
    expect(within(form).getByText(`Still owed ${formatMoney(320.5)}`)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: '50' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/payments')?.body).toMatchObject({ offerId: 9, amount: 50, method: 'cash', date: '2026-10-05' }));
    expect(await screen.findByText('Payment recorded')).toBeInTheDocument();
  });

  it('offers no payment once it is paid up or closed', async () => {
    await open('doctor', offer({ paid: 420.5, remaining: 0, paymentState: 'paid' }), DOCTOR, [payment({ amount: 420.5 })]);
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });

  it('is offered as a PDF, opening in a new tab', async () => {
    await open('doctor', offer(), DOCTOR);
    const pdf = screen.getByRole('link', { name: 'Offer (PDF)' });
    expect(pdf).toHaveAttribute('href', '/api/v1/treatment-offers/9/pdf');
    expect(pdf).toHaveAttribute('target', '_blank');
  });

  it('is deleted after a confirmation that says it goes to the Trash', async () => {
    await open('admin', offer());
    api.routes['DELETE /treatment-offers/9'] = () => new Response(null, { status: 204 });
    api.routes['GET /treatment-offers'] = () => page([]);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText(/go to the Trash/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete offer' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/treatment-offers/9')).toBe(true));
  });

  it('books an item through the offer, with the patient and procedure already chosen', async () => {
    await open('staff', offer({ cost: undefined }));
    api.routes['GET /clinics'] = () => json(200, { data: [CLINIC] });
    api.routes['GET /clinics/1/doctors'] = () => json(200, { data: [CLINIC_DOCTOR] });
    api.routes['GET /units'] = () => json(200, { data: [UNIT] });
    api.routes['GET /appointments/busy'] = () => json(200, { doctorBusy: [], unitBusy: [] });
    api.routes['POST /treatment-offers/9/items/1/schedule'] = () => json(201, { offer: offer(), appointmentId: 11 });
    await userEvent.click(screen.getByRole('button', { name: 'Book a visit for Root canal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book a visit for this treatment' });
    expect(within(dialog).getByLabelText(/Patient/)).toHaveValue('Hicham Cheaib');
    expect(within(dialog).getByLabelText(/Patient/)).toBeDisabled();
    expect(within(dialog).getByLabelText('Reason / notes')).toHaveValue('Root canal');
    await waitFor(() => expect(within(dialog).getByLabelText(/Doctor/)).toHaveTextContent(/Aya/));
    await userEvent.type(within(dialog).getByLabelText(/Date/), '2026-10-06');
    await userEvent.type(within(dialog).getByLabelText(/Start time/), '10:00');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/treatment-offers/9/items/1/schedule')).toBe(true));
    expect(api.calls.find((c) => c.path === '/treatment-offers/9/items/1/schedule')!.body).toMatchObject({ doctorId: 1, clinicId: 1, unitId: 1, date: '2026-10-06', time: '10:00', durationMinutes: 30 });
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/appointments')).toBe(false);
  });

  it('marks an item done by hand for the patient’s doctor', async () => {
    await open('doctor', offer(), DOCTOR);
    api.routes['POST /treatment-offers/9/items/1/done'] = () => json(200, { offer: offer() });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Root canal as done' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/treatment-offers/9/items/1/done')).toBe(true));
    expect(await screen.findByText('Marked as done')).toBeInTheDocument();
  });

  it('puts a booked or finished work back to pending, and books one visit for several chosen works', async () => {
    await open('doctor', offer({ items: [
      item({ status: 'done' }), item({ id: 2, sequence: 2, description: 'Crown', status: 'scheduled', appointment: { id: 5, date: '2026-10-06', time: '10:00', status: 'confirmed' } }),
      item({ id: 3, sequence: 3, description: 'Filling' }), item({ id: 4, sequence: 4, description: 'Cleaning' }),
    ] }), DOCTOR);
    api.routes['POST /treatment-offers/9/items/1/pending'] = () => json(200, { offer: offer() });
    await userEvent.click(screen.getByRole('button', { name: 'Mark Root canal as pending' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/treatment-offers/9/items/1/pending')).toBe(true));
    expect(await screen.findByText('Marked as pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark Crown as done' })).toBeInTheDocument(); // a booked work can be marked done after the visit
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Filling for one visit' }));
    expect(screen.queryByRole('button', { name: /Book one visit/ })).not.toBeInTheDocument(); // one is not "several"
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Cleaning for one visit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Book one visit for the 2 selected works' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason / notes')).toHaveValue('Filling, Cleaning');
  });

  it('shows the server’s refusal in the language of the screen', async () => {
    await open('doctor', offer({ status: 'draft' }), DOCTOR);
    api.routes['POST /treatment-offers/9/accept'] = () => json(409, { error: { code: 'EMPTY_OFFER', message: 'Add at least one item first' } });
    await userEvent.click(screen.getByRole('button', { name: 'Patient accepted' }));
    expect(await screen.findByText('Add at least one item first')).toBeInTheDocument();
    expect(errorMessage({ data: { error: { code: 'INVALID_OFFER_TRANSITION', message: 'x', details: { status: 'cancelled', action: 'accept' } } } })).toBe('A cancelled offer cannot be accepted');
  });
});

describe('the treatment offer form', () => {
  it('creates an offer with its items, prices and costs from the form, in the order chosen', async () => {
    signIn('doctor', DOCTOR);
    api.routes['GET /treatment-offers'] = () => page([]);
    api.routes['POST /treatment-offers'] = () => json(201, { offer: offer({ status: 'draft' }) });
    api.routes['GET /treatment-offers/9'] = () => json(200, { offer: offer({ status: 'draft' }) });
    api.routes['GET /payments'] = () => page([]);
    renderApp(<App />, '/treatment-offers?patientId=7');
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    await userEvent.click(await screen.findByRole('button', { name: 'New treatment offer' }));
    const dialog = await screen.findByRole('dialog', { name: 'New treatment offer' });
    await userEvent.type(within(dialog).getByLabelText(/^Title/), 'Full rehabilitation');
    await userEvent.type(within(dialog).getByLabelText('Description of item 1'), 'Root canal');
    await userEvent.type(within(dialog).getByLabelText('Price of item 1'), '120');
    await userEvent.type(within(dialog).getByLabelText('Cost of item 1'), '40');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add item' }));
    await userEvent.type(within(dialog).getByLabelText('Description of item 2'), 'Crown');
    await userEvent.type(within(dialog).getByLabelText('Price of item 2'), '300.5');
    expect(within(dialog).getByText(`Total: ${formatMoney(420.5)}`)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move item 2 up' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create offer' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/treatment-offers')).toBe(true));
    const body = api.calls.find((c) => c.method === 'POST' && c.path === '/treatment-offers')!.body;
    expect(body.patientId).toBe(7);
    expect(body.items.map((i: { description: string; price: number; cost: number | null }) => [i.description, i.price, i.cost])).toEqual([['Crown', 300.5, null], ['Root canal', 120, 40]]);
    expect(body.asDraft).toBeUndefined(); // final: the patient agreed in the chair
    expect(await screen.findByText('Treatment offer created')).toBeInTheDocument();
  });

  it('can be saved as a draft, even with nothing listed yet', async () => {
    signIn('doctor', DOCTOR);
    api.routes['GET /treatment-offers'] = () => page([]);
    api.routes['POST /treatment-offers'] = () => json(201, { offer: offer({ status: 'draft' }) });
    api.routes['GET /treatment-offers/9'] = () => json(200, { offer: offer({ status: 'draft' }) });
    api.routes['GET /payments'] = () => page([]);
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    renderApp(<App />, '/treatment-offers?patientId=7');
    await userEvent.click(await screen.findByRole('button', { name: 'New treatment offer' }));
    const dialog = await screen.findByRole('dialog', { name: 'New treatment offer' });
    await userEvent.type(within(dialog).getByLabelText(/^Title/), 'Still thinking');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/treatment-offers')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/treatment-offers')!.body).toMatchObject({ patientId: 7, title: 'Still thinking', asDraft: true, items: [] });
  });

  it('needs at least one item to make a final offer, and says so without sending anything', async () => {
    signIn('doctor', DOCTOR);
    api.routes['GET /treatment-offers'] = () => page([]);
    api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
    renderApp(<App />, '/treatment-offers?patientId=7');
    await userEvent.click(await screen.findByRole('button', { name: 'New treatment offer' }));
    const dialog = await screen.findByRole('dialog', { name: 'New treatment offer' });
    await userEvent.type(within(dialog).getByLabelText(/^Title/), 'Crown');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create offer' }));
    expect(await within(dialog).findByText('Add at least one item first')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('asks for a title and a patient, and refuses a price with more than two decimals, before sending', async () => {
    signIn('admin');
    api.routes['GET /treatment-offers'] = () => page([]);
    renderApp(<App />, '/treatment-offers');
    await userEvent.click(await screen.findByRole('button', { name: 'New treatment offer' }));
    const dialog = await screen.findByRole('dialog', { name: 'New treatment offer' });
    await userEvent.type(within(dialog).getByLabelText('Description of item 1'), 'Crown');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create offer' }));
    expect(await within(dialog).findByText('Title is required')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a patient')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Price of item 1'), { target: { value: '10.123' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create offer' }));
    expect(await within(dialog).findByText('Use at most two decimals')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('the offer form’s ids', () => {
  it('accepts a procedure and a tooth chosen in the form, which arrive as text', async () => {
    const { offerInputSchema } = await import('@aya/shared');
    const parsed = offerInputSchema.safeParse({ patientId: 7, title: 'Crown', items: [{ description: 'Crown', categoryId: '5', toothId: '12', price: '100', cost: '' }, { description: 'Check', categoryId: '', toothId: '', price: 0 }] });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.items.map((i) => [i.categoryId, i.toothId])).toEqual([[5, 12], [null, null]]);
  });
});
