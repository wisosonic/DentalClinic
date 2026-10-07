import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { timeAgo } from '../features/notifications/NotificationBell';
import { empty, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };
const note = (extra: object = {}) => ({ id: 1, type: 'appointment.booked', title: 'New appointment', content: 'Pat Patient with Dr Aya on 2026-10-06 at 10:00.', link: '/appointments', status: 'unread', createdAt: '2026-10-05 07:00:00', readAt: null, ...extra });
const list = (data: unknown[], unread = data.filter((n) => (n as { status: string }).status === 'unread').length) => json(200, { data, meta: { page: 1, pageSize: 10, total: data.length }, unread });

const signIn = (role = 'staff', notifications = list([note(), note({ id: 2, title: 'Payment received', content: '$100.00 from Pat Patient.', link: '/payments', status: 'read', readAt: '2026-10-05 08:00:00' })])) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 100, total: 0 } });
  api.routes['GET /notifications'] = () => notifications;
};

describe('the notification bell', () => {
  it('shows the number of unread notifications on the bell', async () => {
    signIn();
    renderApp(<App />, '/');
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
  });

  it('is there for everyone who signs in, patients included (their reminders and bookings arrive there)', async () => {
    signIn('patient');
    renderApp(<App />, '/');
    await screen.findByText(/Welcome/);
    expect(await screen.findByRole('button', { name: /Notifications/ })).toBeInTheDocument();
  });

  it('opens a list with the unread ones marked, newest first', async () => {
    signIn();
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    const items = within(dialog).getAllByRole('button').filter((b) => b.textContent?.includes('New appointment') || b.textContent?.includes('Payment received'));
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('New appointment');
    expect(items[0]).toHaveTextContent('Unread');
    expect(items[1]).not.toHaveTextContent('Unread');
    expect(within(dialog).getByText(/Pat Patient with Dr Aya/)).toBeInTheDocument();
  });

  it('marks one as read and goes to where it points when it is clicked', async () => {
    signIn();
    api.routes['PATCH /notifications/1/read'] = () => json(200, { notification: note({ status: 'read' }) });
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    await userEvent.click(await screen.findByText('New appointment'));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH' && c.path === '/notifications/1/read')).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Appointments' })).toBeInTheDocument(); // the link was followed
  });

  it('does not mark a notification that was already read, but still follows its link', async () => {
    signIn();
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    await userEvent.click(await screen.findByText('Payment received'));
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('marks everything as read in one step', async () => {
    signIn();
    api.routes['POST /notifications/read-all'] = () => empty();
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/notifications/read-all')).toBe(true));
  });

  it('has nothing to mark when everything is read, and says so when the list is empty', async () => {
    signIn('staff', list([]));
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('No notifications yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });
});

describe('how long ago', () => {
  afterEach(() => vi.useRealTimers());
  const now = Date.parse('2026-10-05T10:00:00Z');

  it('says it in minutes, hours and days, and gives a date after a week', () => {
    expect(timeAgo('2026-10-05 09:59:50', now)).toMatch(/now|0 seconds|seconds? ago/i);
    expect(timeAgo('2026-10-05 09:30:00', now)).toContain('30');
    expect(timeAgo('2026-10-05 07:00:00', now)).toContain('3');
    expect(timeAgo('2026-10-03 10:00:00', now)).toContain('2');
    expect(timeAgo('2026-09-01 10:00:00', now)).toMatch(/2026/);
    expect(timeAgo(null, now)).toBe('');
    expect(timeAgo('nonsense', now)).toBe('');
  });
});
