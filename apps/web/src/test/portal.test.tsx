import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { PATIENT, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-07' };
const appointment = (extra: object = {}) => ({
  id: 5, date: '2026-10-12', time: '10:00', endTime: '10:30', durationMinutes: 30, status: 'confirmed', doctor: { fname: 'Aya', lname: 'Ghali' },
  clinic: { name: 'Hamra Clinic', address: 'Hamra Street', phone: '01234567' }, procedures: ['Scaling'], canCancel: true, cancelUntil: '2026-10-11 10:00', ...extra,
});
const overview = (extra: object = {}) => ({
  patient: { id: 7, fname: 'Hicham', lname: 'Cheaib', patientIdentifier: '100007', username: 'hicham.cheaib', doctor: { fname: 'Aya', lname: 'Ghali' } },
  next: appointment(), upcomingCount: 1, balance: { price: 450, paid: 250, remaining: 200, currency: '$' }, documentsCount: 2, cancelMinHours: 24, ...extra,
});
const offer = (extra: object = {}) => ({
  id: 9, title: 'Rehabilitation', description: 'Upper jaw', price: 350, paid: 100, remaining: 250, currency: '$', paymentState: 'partly_paid', workState: 'in_progress',
  progress: { done: 1, total: 2, percent: 50 }, doctor: { fname: 'Aya', lname: 'Ghali' },
  items: [
    { id: 1, sequence: 0, description: 'Crown', tooth: '18', price: 300, status: 'scheduled', visit: { date: '2026-10-12', time: '10:00' } },
    { id: 2, sequence: 1, description: 'Check', tooth: null, price: 50, status: 'done', visit: null },
  ], createdAt: '2026-10-01 09:00:00', ...extra,
});
const list = (data: unknown[]) => json(200, { data });

const signIn = (role = 'patient') => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, { username: role === 'patient' ? 'hicham.cheaib' : null }) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /portal/overview'] = () => json(200, overview());
  api.routes['GET /portal/upcoming'] = () => list([appointment()]);
  api.routes['GET /portal/offers'] = () => list([offer()]);
  api.routes['GET /portal/payments'] = () => list([]);
  api.routes['GET /portal/documents'] = () => list([]);
  api.routes['GET /patients/me'] = () => json(200, { patient: { ...PATIENT, email: 'h@example.com', address: 'Beirut' } });
  api.routes['GET /patients/me/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 100, total: 0 } });
};

describe('the patient’s home', () => {
  it('shows the next appointment with its details, the balance and the way into the rest, and no staff pages', async () => {
    signIn();
    renderApp(<App />, '/');
    expect(await screen.findByRole('heading', { name: 'Your next appointment' })).toBeInTheDocument();
    const card = within(await screen.findByRole('region', { name: 'Your next appointment' }));
    expect(await card.findByText(/With Dr\. Aya Ghali/)).toBeInTheDocument();
    expect(card.getByText('10:00')).toBeInTheDocument();
    expect(card.getByText(/Hamra Clinic, Hamra Street/)).toBeInTheDocument();
    expect(card.getByRole('link', { name: '01234567' })).toHaveAttribute('href', 'tel:01234567');
    expect(card.getByText('Scaling')).toBeInTheDocument();
    expect(card.getByText(/You can cancel it online until/)).toBeInTheDocument();
    const balance = within(screen.getByRole('region', { name: 'Your treatment balance' }));
    expect(balance.getByText(/450\.00/)).toBeInTheDocument();
    expect(balance.getByText(/250\.00/)).toBeInTheDocument();
    expect(balance.getByText(/200\.00/)).toBeInTheDocument();
    const nav = within(screen.getByRole('navigation', { name: 'My care' }));
    expect(nav.getByRole('link', { name: /My documents/ })).toHaveAttribute('href', '/my/documents');
    expect(screen.getByText('2 shared with you')).toBeInTheDocument();
    expect(screen.queryByText(/portal is coming soon/)).not.toBeInTheDocument();
    // the side menu: the patient's own pages, nothing of the clinic's
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = within(screen.getByRole('navigation', { name: 'Main' }));
    for (const [name, href] of [['My appointments', '/my/appointments'], ['My treatment', '/my/treatment'], ['My payments', '/my/payments'], ['My documents', '/my/documents'], ['My profile', '/my/profile']]) {
      expect(menu.getByRole('link', { name }), name).toHaveAttribute('href', href);
    }
    for (const staffPage of ['Patients', 'Appointments', 'Payments', 'Treatment offers', 'Reports', 'Users']) expect(menu.queryByRole('link', { name: staffPage }), staffPage).not.toBeInTheDocument();
  });

  it('says so when there is nothing coming up, and that booking is by phone', async () => {
    signIn();
    api.routes['GET /portal/overview'] = () => json(200, overview({ next: null, upcomingCount: 0, balance: { price: 0, paid: 0, remaining: 0, currency: '$' }, documentsCount: 0 }));
    renderApp(<App />, '/');
    expect(await screen.findByText('You have no appointment coming up. To book one, please call the clinic.')).toBeInTheDocument();
    expect(screen.getByText('You have no treatment plan with a price yet.')).toBeInTheDocument();
    expect(screen.getByText('Nothing shared with you yet')).toBeInTheDocument();
  });

  it('has no way to book: only cancel', async () => {
    signIn();
    renderApp(<App />, '/');
    await screen.findByRole('heading', { name: 'Your next appointment' });
    expect(screen.queryByRole('button', { name: /Book/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel appointment' })).toBeInTheDocument();
  });

  it('cancels the appointment after asking, and tells the clinic', async () => {
    signIn();
    api.routes['POST /appointments/5/cancel'] = () => json(200, { appointment: { id: 5, status: 'cancelled' } });
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' });
    expect(within(dialog).getByText(/The clinic will be told/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/appointments/5/cancel')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Cancel this appointment?' })).getByRole('button', { name: 'Cancel appointment' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/appointments/5/cancel')).toBe(true));
    expect(await screen.findByText('Appointment cancelled', undefined, { timeout: 4000 })).toBeInTheDocument();
  });

  it('offers no cancel button when it is too late, and says to phone the clinic', async () => {
    signIn();
    api.routes['GET /portal/overview'] = () => json(200, overview({ next: appointment({ canCancel: false, cancelUntil: '2026-10-06 10:00' }) }));
    renderApp(<App />, '/');
    expect(await screen.findByText(/less than 24 hours away, so it can only be changed by phone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel appointment' })).not.toBeInTheDocument();
  });

  it('shows the server’s refusal when cancelling is no longer allowed', async () => {
    signIn();
    api.routes['POST /appointments/5/cancel'] = () => json(409, errorBody('TOO_LATE_TO_CANCEL', 'Appointments can only be cancelled online at least 24 hours ahead. Please call the clinic.'));
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel appointment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 24 hours ahead/);
  });
});

describe('my appointments', () => {
  const history = [
    { appointment: { id: 3, date: '2026-09-20', time: '09:00', endTime: '09:30', durationMinutes: 30, status: 'completed', doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, clinic: null, categories: ['Scaling'] }, hasReport: true,
      report: { id: 1, appointmentId: 3, summary: 'Cleaned and polished.', medications: [{ id: 1, medicationId: 1, name: 'Amoxicillin', type: 'Capsule', dose: '500 mg', frequency: 3, timeUnit: 'day', notes: 'After meals' }], createdAt: null, updatedAt: null } },
    { appointment: { id: 4, date: '2026-09-10', time: '11:00', endTime: '11:30', durationMinutes: 30, status: 'cancelled', doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, clinic: null, categories: [] }, hasReport: false, report: null },
    { appointment: { id: 5, date: '2026-10-12', time: '10:00', endTime: '10:30', durationMinutes: 30, status: 'confirmed', doctor: { id: 1, fname: 'Aya', lname: 'Ghali' }, clinic: null, categories: [] }, hasReport: false, report: null },
  ];

  it('lists what is coming and the history, with each visit’s summary and prescription and a printable summary', async () => {
    signIn();
    api.routes['GET /patients/me/timeline'] = () => json(200, { data: history, meta: { page: 1, pageSize: 100, total: 3 } });
    renderApp(<App />, '/my/appointments');
    expect(await screen.findByRole('heading', { name: 'My appointments' })).toBeInTheDocument();
    const upcoming = within(await screen.findByRole('region', { name: 'Upcoming' }));
    expect(await upcoming.findByText(/With Dr\. Aya Ghali/)).toBeInTheDocument();
    const past = within(screen.getByRole('region', { name: 'History' }));
    expect(await past.findByText('Completed')).toBeInTheDocument();
    expect(past.getByText('Cancelled')).toBeInTheDocument();
    expect(past.queryByText('Confirmed')).not.toBeInTheDocument(); // the upcoming one is above, not repeated
    await userEvent.click(past.getByText('Completed'));
    expect(await past.findByText('Cleaned and polished.')).toBeInTheDocument();
    expect(past.getByText(/Amoxicillin/)).toBeInTheDocument();
    expect(past.getByText(/500 mg, 3 times per day/)).toBeInTheDocument();
    expect(past.getByRole('link', { name: 'Visit summary (PDF)' })).toHaveAttribute('href', '/api/v1/appointments/3/report/pdf');
    expect(past.queryByText(/Tooth notes/)).not.toBeInTheDocument(); // clinic-only
  });

  it('says so when there is nothing yet', async () => {
    signIn();
    api.routes['GET /portal/upcoming'] = () => list([]);
    renderApp(<App />, '/my/appointments');
    expect(await screen.findByText('You have no appointment coming up.')).toBeInTheDocument();
    expect(await screen.findByText('Your visits will appear here.')).toBeInTheDocument();
  });
});

describe('my treatment', () => {
  it('shows the plan item by item with prices, progress, what is paid and a printable copy', async () => {
    signIn();
    renderApp(<App />, '/my/treatment');
    const card = within(await screen.findByRole('article', { name: 'Rehabilitation' }));
    expect(card.getByText('Upper jaw')).toBeInTheDocument();
    expect(card.getByText('In progress')).toBeInTheDocument();
    expect(card.getByText('Partly paid')).toBeInTheDocument();
    expect(card.getByText('1 of 2 done')).toBeInTheDocument();
    const crown = card.getByText('Crown').closest('tr') as HTMLElement;
    expect(within(crown).getByText('18')).toBeInTheDocument();
    expect(within(crown).getByText('Booked')).toBeInTheDocument();
    expect(within(crown).getByText(/300\.00/)).toBeInTheDocument();
    expect(within(card.getByText('Check').closest('tr') as HTMLElement).getByText('Done')).toBeInTheDocument();
    expect(card.getByText(/350\.00/)).toBeInTheDocument();
    expect(card.getByText(/250\.00/)).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Print the plan (PDF)' })).toHaveAttribute('href', '/api/v1/portal/offers/9/pdf');
    expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();
  });

  it('says so when there is no plan yet', async () => {
    signIn();
    api.routes['GET /portal/offers'] = () => list([]);
    renderApp(<App />, '/my/treatment');
    expect(await screen.findByText('You have no treatment plan yet.')).toBeInTheDocument();
  });
});

describe('my payments', () => {
  const payments = [
    { id: 1, date: '2026-10-01', amount: 100, currency: '$', method: 'cash', offerId: 9, offerTitle: 'Rehabilitation', remaining: 250 },
    { id: 2, date: '2026-10-03', amount: 50, currency: '$', method: 'card', offerId: 9, offerTitle: 'Rehabilitation', remaining: 200 },
  ];

  it('lists them newest first with the balance after each and a receipt, and sorts by any column', async () => {
    signIn();
    api.routes['GET /portal/payments'] = () => list(payments);
    renderApp(<App />, '/my/payments');
    const table = await screen.findByRole('table', { name: 'My payments' });
    const rows = () => within(table).getAllByRole('row').slice(1).map((r) => (within(r).getAllByRole('cell')[3]!.textContent ?? '').replace('US', ''));
    expect(rows()).toEqual(['$50.00', '$100.00']);
    expect(within(table).getAllByRole('link', { name: /Receipt of the payment of/ })[0]).toHaveAttribute('href', '/api/v1/portal/payments/2/receipt');
    await userEvent.click(within(table).getByRole('button', { name: /Amount/ }));
    expect(rows()).toEqual(['$50.00', '$100.00']); // ascending: smallest first
    await userEvent.click(within(table).getByRole('button', { name: /Amount/ }));
    expect(rows()).toEqual(['$100.00', '$50.00']);
  });

  it('says so when there are none', async () => {
    signIn();
    renderApp(<App />, '/my/payments');
    expect(await screen.findByText('You have no payments yet.')).toBeInTheDocument();
  });
});

describe('my documents', () => {
  const docs = [
    { id: 1, category: 'xray', title: 'Upper jaw', takenOn: '2026-10-01', mime: 'image/png', sizeBytes: 2_500_000, isImage: true },
    { id: 2, category: 'blood_test', title: 'Blood results', takenOn: '2026-09-20', mime: 'application/pdf', sizeBytes: 90_000, isImage: false },
  ];

  it('shows what the clinic shared, with a preview for a picture and a way to open each', async () => {
    signIn();
    api.routes['GET /portal/documents'] = () => list(docs);
    renderApp(<App />, '/my/documents');
    const pic = within(await screen.findByRole('article', { name: 'Upper jaw' }));
    expect(pic.getByText('X-ray')).toBeInTheDocument();
    expect(pic.getByRole('link', { name: 'Open Upper jaw' })).toHaveAttribute('href', '/api/v1/portal/documents/1/file');
    expect(pic.getByRole('link', { name: 'Open Upper jaw' })).toHaveAttribute('target', '_blank');
    const img = document.querySelector('article[aria-label="Upper jaw"] img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', '/api/v1/portal/documents/1/thumbnail');
    const pdf = within(screen.getByRole('article', { name: 'Blood results' }));
    expect(pdf.getByText('Blood test')).toBeInTheDocument();
    expect(document.querySelector('article[aria-label="Blood results"] img')).toBeNull();
  });

  it('says so when nothing is shared', async () => {
    signIn();
    renderApp(<App />, '/my/documents');
    expect(await screen.findByText('Nothing has been shared with you yet.')).toBeInTheDocument();
  });
});

describe('my profile', () => {
  it('shows the details, the username, and a way to change the password', async () => {
    signIn();
    renderApp(<App />, '/my/profile');
    expect(await screen.findByText('Hicham Cheaib')).toBeInTheDocument();
    expect(screen.getByText('hicham.cheaib')).toBeInTheDocument();
    expect(screen.getByText('100007')).toBeInTheDocument();
    expect(screen.getByText('h@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change my password' })).toHaveAttribute('href', '/change-password');
    expect(screen.getByText(/ask the clinic for a new patient card/)).toBeInTheDocument();
  });
});

describe('who may open the portal pages', () => {
  it('sends staff away from them, to their own dashboard', async () => {
    signIn('staff');
    api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 100, total: 0 } });
    renderApp(<App />, '/my/payments');
    await waitFor(() => expect(screen.queryByRole('table', { name: 'My payments' })).not.toBeInTheDocument());
    expect(api.calls.some((c) => c.path.startsWith('/portal'))).toBe(false);
  });
});

describe('the patient’s notifications', () => {
  it('reach the patient through the bell, and lead to their own pages', async () => {
    signIn();
    api.routes['GET /notifications'] = () => json(200, {
      data: [{ id: 1, type: 'appointment.reminder', title: 'Appointment reminder', content: 'You have an appointment with Dr Aya Ghali tomorrow at 09:00. To cancel it online, do it at least 24 hours ahead.', link: '/my/appointments', status: 'unread', createdAt: '2026-10-07 07:00:00' }],
      meta: { page: 1, pageSize: 10, total: 1 }, unread: 1,
    });
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(dialog).getByText('Appointment reminder')).toBeInTheDocument();
    expect(within(dialog).getByText(/You have an appointment with Dr Aya Ghali tomorrow at 09:00/)).toBeInTheDocument();
  });
});
