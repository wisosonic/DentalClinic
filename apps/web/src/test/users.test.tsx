import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const USERS = [
  user('admin', { id: 1, name: 'Aya Ghali', email: 'aya@clinic.test', lastLoginAt: '2026-10-04 08:00:00' }),
  user('doctor', { id: 2, name: 'Sami Khoury', email: 'sami@clinic.test', doctor: null }),
  user('staff', { id: 3, name: 'Nour Haddad', email: 'nour@clinic.test' }),
  user('staff', { id: 4, name: 'Old Timer', email: 'old@clinic.test', isActive: false }),
];

const setup = (role = 'admin') => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, { id: 1 }) });
  api.routes['GET /users'] = () => json(200, { data: USERS, meta: { page: 1, pageSize: 100, total: USERS.length } });
};
const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

describe('users page', () => {
  it('is for admins only', async () => {
    setup('doctor');
    renderApp(<App />, '/settings/users');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New account' })).not.toBeInTheDocument();
  });

  it('lists accounts, flags a doctor login that is not linked, and shows who is switched off', async () => {
    setup();
    renderApp(<App />, '/settings/users');
    expect(within(await rowOf('Sami Khoury')).getByText('Not linked to a doctor')).toBeInTheDocument();
    expect(within(await rowOf('Old Timer')).getByText('Switched off')).toBeInTheDocument();
    expect(within(await rowOf('Nour Haddad')).getByText('Active')).toBeInTheDocument();
  });

  it('cannot switch yourself off', async () => {
    setup();
    renderApp(<App />, '/settings/users');
    expect(within(await rowOf('Aya Ghali')).queryByRole('button', { name: 'Switch off' })).not.toBeInTheDocument();
    expect(within(await rowOf('Nour Haddad')).getByRole('button', { name: 'Switch off' })).toBeInTheDocument();
  });

  it('makes a reset link, shows it once with its expiry, and sends nothing by email', async () => {
    setup();
    api.routes['POST /users/3/reset-link'] = () => json(200, { link: 'http://localhost:5180/reset-password/abc', expiresInHours: 24 });
    renderApp(<App />, '/settings/users');
    await userEvent.click(within(await rowOf('Nour Haddad')).getByRole('button', { name: 'Reset link for Nour Haddad' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Copy and hand this over')).toHaveValue('http://localhost:5180/reset-password/abc');
    expect(within(dialog).getByText(/expires in 24 hours/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('asks before making a temporary password, then shows it once', async () => {
    setup();
    api.routes['POST /users/3/reset-password'] = () => json(200, { temporaryPassword: 'Temp-Secret-77' });
    renderApp(<App />, '/settings/users');
    await userEvent.click(within(await rowOf('Nour Haddad')).getByRole('button', { name: 'Temporary password for Nour Haddad' }));
    expect(api.calls.some((c) => c.path === '/users/3/reset-password')).toBe(false); // not until confirmed
    await userEvent.click(await screen.findByRole('button', { name: 'Make password' }));
    expect(await screen.findByDisplayValue('Temp-Secret-77')).toBeInTheDocument();
  });

  it('creates an account and shows its temporary password', async () => {
    setup();
    api.routes['POST /users'] = (call) =>
      json(201, { user: user(call.body.role, { id: 9, name: call.body.name, email: call.body.email }), temporaryPassword: 'Fresh-Pass-31' });
    renderApp(<App />, '/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'New account' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Rana Saab');
    fireEvent.change(within(dialog).getByLabelText(/^Email/), { target: { value: 'rana@clinic.test' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create account' }));
    expect(await screen.findByDisplayValue('Fresh-Pass-31')).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/users')!.body).toMatchObject({ name: 'Rana Saab', email: 'rana@clinic.test', role: 'staff' });
  });

  it('checks the name and email before sending', async () => {
    setup();
    renderApp(<App />, '/settings/users');
    await userEvent.click(await screen.findByRole('button', { name: 'New account' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('switches an account on without asking, and off only after confirming', async () => {
    setup();
    api.routes['PATCH /users/4'] = () => json(200, { user: USERS[3] });
    api.routes['PATCH /users/3'] = () => json(200, { user: USERS[2] });
    renderApp(<App />, '/settings/users');
    await userEvent.click(within(await rowOf('Old Timer')).getByRole('button', { name: 'Switch on' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/users/4')?.body).toEqual({ isActive: true }));

    await userEvent.click(within(await rowOf('Nour Haddad')).getByRole('button', { name: 'Switch off' }));
    expect(api.calls.some((c) => c.path === '/users/3')).toBe(false);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/users/3')?.body).toEqual({ isActive: false }));
  });

  it('sorts by a column', async () => {
    setup();
    renderApp(<App />, '/settings/users');
    await rowOf('Aya Ghali');
    await userEvent.click(screen.getByRole('button', { name: 'Email' }));
    const names = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    await waitFor(() => expect(names()[0]).toContain('aya@clinic.test'));
    await userEvent.click(screen.getByRole('button', { name: 'Email' }));
    await waitFor(() => expect(names()[0]).toContain('sami@clinic.test'));
  });
});
