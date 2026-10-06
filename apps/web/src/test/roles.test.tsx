import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-05' };

const DOCTOR_DEFAULTS = ['appointments:read', 'patients:read', 'offers:read', 'offers:create', 'offers:update', 'payments:read', 'reports:read'];
const STAFF_DEFAULTS = ['appointments:read', 'patients:read', 'payments:create', 'labs:read', 'labs:create', 'reports:read'];
const SWITCHABLE = [...new Set([...DOCTOR_DEFAULTS, ...STAFF_DEFAULTS, 'medications:read', 'medications:create'])];

const roles = (doctor = DOCTOR_DEFAULTS, staff = STAFF_DEFAULTS) => ({
  roles: [
    { role: 'admin', editable: false, users: 1, permissions: SWITCHABLE, defaults: SWITCHABLE },
    { role: 'doctor', editable: true, users: 2, permissions: doctor, defaults: DOCTOR_DEFAULTS },
    { role: 'staff', editable: true, users: 1, permissions: staff, defaults: STAFF_DEFAULTS },
    { role: 'patient', editable: false, users: 5, permissions: ['patients:read'], defaults: ['patients:read'] },
  ],
  switchable: SWITCHABLE,
  revokeOnly: ['offers:read', 'offers:create', 'offers:update', 'payments:read', 'payments:create'],
});

const signIn = (role = 'admin', extra: object = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user(role, extra) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /roles'] = () => json(200, roles());
};

describe('roles page', () => {
  it('is for admins only', async () => {
    signIn('doctor');
    renderApp(<App />, '/settings/roles');
    expect(await screen.findByRole('heading', { name: /Welcome/ })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/roles')).toBe(false);
  });

  it('shows each role with its account count, and the matrix of what it may do', async () => {
    signIn();
    renderApp(<App />, '/settings/roles');
    const tabs = await screen.findByRole('tablist');
    expect(within(tabs).getByRole('tab', { name: /doctor/ })).toHaveTextContent('2 accounts');
    expect(within(tabs).getByRole('tab', { name: /staff/ })).toHaveTextContent('1 account');
    const table = await screen.findByRole('table', { name: 'Permissions of doctor' });
    expect(within(table).getByRole('checkbox', { name: 'View Payments' })).toBeChecked();
    expect(within(table).getByRole('checkbox', { name: 'Change Treatment offers' })).toBeChecked();
    expect(within(table).getByRole('checkbox', { name: 'View Medications' })).not.toBeChecked();
    expect(screen.getByText(/always for administrators only/)).toBeInTheDocument();
  });

  it('saves only what was changed, and tells how many changes there are', async () => {
    signIn();
    api.routes['PUT /roles/doctor'] = () => json(200, roles(DOCTOR_DEFAULTS.filter((p) => p !== 'offers:update')));
    renderApp(<App />, '/settings/roles');
    const save = await screen.findByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Change Treatment offers' }));
    expect(screen.getByText('1 change from the built-in setting')).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/roles/doctor')?.body).toEqual({ permissions: DOCTOR_DEFAULTS.filter((p) => p !== 'offers:update').sort() }));
    expect(await screen.findByText('Permissions saved')).toBeInTheDocument();
  });

  it('takes the rest of an area away with its View, and turns View on with anything else', async () => {
    signIn();
    renderApp(<App />, '/settings/roles');
    await screen.findByRole('table', { name: 'Permissions of doctor' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'View Treatment offers' }));
    expect(screen.getByRole('checkbox', { name: 'Change Treatment offers' })).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Add Treatment offers' }));
    expect(screen.getByRole('checkbox', { name: 'View Treatment offers' })).toBeChecked();
  });

  it('will not let money access be given, and locks the admin and patient roles', async () => {
    signIn();
    renderApp(<App />, '/settings/roles');
    await userEvent.click(await screen.findByRole('tab', { name: /staff/ }));
    expect(screen.getByRole('checkbox', { name: 'View Payments' })).toBeDisabled(); // staff lacks it and money cannot be given
    expect(screen.getByRole('checkbox', { name: 'Add Payments' })).toBeEnabled(); // staff has it: it can be taken away
    await userEvent.click(screen.getByRole('tab', { name: /admin/ }));
    expect(screen.getByText('The admin role always keeps every permission.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'View Payments' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /patient/ }));
    expect(screen.getByText(/only ever sees their own records/)).toBeInTheDocument();
  });

  it('puts a role back to the built-in permissions after asking', async () => {
    signIn();
    api.routes['GET /roles'] = () => json(200, roles(DOCTOR_DEFAULTS.filter((p) => p !== 'offers:update')));
    api.routes['POST /roles/doctor/reset'] = () => json(200, roles());
    renderApp(<App />, '/settings/roles');
    await userEvent.click(await screen.findByRole('button', { name: 'Back to the built-in permissions' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Every change made to this role is undone/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Put back' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/roles/doctor/reset')).toBe(true));
  });

  it('shows the server’s refusal', async () => {
    signIn();
    api.routes['PUT /roles/doctor'] = () => json(400, errorBody('READ_REQUIRED', 'A role that can change something must also be able to see it'));
    renderApp(<App />, '/settings/roles');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Change Treatment offers' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A role that can change something must also be able to see it');
  });
});

describe('the side menu follows what the role may do', () => {
  const menu = async (extra: object) => {
    signIn('staff', extra);
    api.routes['GET /appointments'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
    api.routes['GET /doctors'] = () => json(200, { data: [] });
    renderApp(<App />, '/');
    await screen.findByRole('heading', { name: /Welcome/ });
    const nav = screen.getAllByRole('navigation', { hidden: true }).find((n) => n.getAttribute('aria-label') === 'Main')!;
    return within(nav).getAllByRole('link', { hidden: true }).map((l) => l.textContent);
  };

  it('shows the pages the role may open', async () => {
    const all = await menu({ permissions: ['appointments:read', 'patients:read', 'labs:read', 'labs:create', 'reports:read', 'payments:create'] });
    expect(all).toEqual(expect.arrayContaining(['Appointments', 'Patients', 'Lab orders', 'Payments']));
  });

  it('hides a page whose permissions were taken away', async () => {
    const less = await menu({ permissions: ['appointments:read', 'reports:read'] });
    expect(less).toContain('Appointments');
    for (const gone of ['Patients', 'Lab orders', 'Payments', 'Labs']) expect(less).not.toContain(gone);
  });
});
