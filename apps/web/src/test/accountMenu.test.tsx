import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

describe('the account menu', () => {
  it.each(['admin', 'doctor', 'staff'])('shows the name, the email and the role of a signed-in %s, with the two actions', async (role) => {
    api.routes['GET /auth/me'] = () => json(200, { user: user(role, { name: 'Aya Ghali', email: 'aya@clinic.test', ...(role === 'doctor' ? { doctor: { id: 1, kind: 'owner' } } : {}) }) });
    api.routes['GET /config'] = () => json(200, { defaultDuration: 30, timezone: 'Asia/Beirut', today: '2026-10-10' });
    renderApp(<App />, '/');
    await userEvent.click(await screen.findByRole('button', { name: 'Account menu' }));
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByText('Aya Ghali')).toBeInTheDocument();
    expect(menu.getByText('aya@clinic.test')).toBeInTheDocument();
    expect(menu.getByLabelText(`Role: ${role}`)).toHaveTextContent(role);
    expect(menu.getByRole('menuitem', { name: 'Change password' })).toBeInTheDocument();
    expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });
});
