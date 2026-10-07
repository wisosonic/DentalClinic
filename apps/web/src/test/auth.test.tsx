import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { makeStore } from '../app/store';

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

const USER = { id: 1, name: 'Aya Ghali', email: 'aya@clinic.test', role: 'admin', mustChangePassword: false, isActive: true, lastLoginAt: null };
let calls: Call[] = [];
let routes: Record<string, (call: Call) => Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url);
    const text = await input.clone().text();
    const call: Call = {
      method: input.method,
      path: url.pathname.replace('/api/v1', ''),
      headers: input.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    return handler ? handler(call) : json(404, { error: { code: 'NOT_FOUND', message: 'no mock' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  );
}

const unauthenticated = () => {
  routes['GET /auth/me'] = () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  routes['POST /auth/refresh'] = () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Session expired' } });
};

describe('route protection', () => {
  it('sends anonymous visitors to the sign-in page', async () => {
    unauthenticated();
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the dashboard to a signed-in user', async () => {
    routes['GET /auth/me'] = () => json(200, { user: USER });
    renderAt('/');
    expect(await screen.findByText(/Welcome, Dr. Aya Ghali/)).toBeInTheDocument();
  });

  it('forces a password change before anything else', async () => {
    routes['GET /auth/me'] = () => json(200, { user: { ...USER, mustChangePassword: true } });
    renderAt('/');
    expect(await screen.findByText(/must set a new password/i)).toBeInTheDocument();
    expect(screen.queryByText(/Welcome/)).not.toBeInTheDocument();
  });

  it('silently refreshes an expired access token and retries once', async () => {
    let meCalls = 0;
    routes['GET /auth/me'] = () => (++meCalls === 1 ? json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }) : json(200, { user: USER }));
    routes['POST /auth/refresh'] = () => json(200, { user: USER });
    renderAt('/');
    expect(await screen.findByText(/Welcome, Dr. Aya Ghali/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });
});

describe('login form', () => {
  it('validates before calling the server', async () => {
    unauthenticated();
    renderAt('/login');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email or username')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auth/login')).toBe(false);
  });

  it('signs in, sends the CSRF header when present, and lands on the dashboard', async () => {
    unauthenticated();
    routes['POST /auth/login'] = () => json(200, { user: USER });
    renderAt('/login');

    await userEvent.type(await screen.findByLabelText('Email or username'), 'aya@clinic.test');
    await userEvent.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Welcome, Dr. Aya Ghali/)).toBeInTheDocument();
    const login = calls.find((c) => c.path === '/auth/login')!;
    expect(login.body).toEqual({ identifier: 'aya@clinic.test', password: 'Correct-Horse-9', remember: false });
  });

  it('shows the server’s error and stays on the page', async () => {
    unauthenticated();
    routes['POST /auth/login'] = () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email, username or password' } });
    renderAt('/login');

    await userEvent.type(await screen.findByLabelText('Email or username'), 'aya@clinic.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email, username or password');
    // A failed login must not be mistaken for an expired token and trigger a refresh.
    expect(calls.some((c) => c.path === '/auth/refresh' && c.method === 'POST' && calls.indexOf(c) > calls.findIndex((x) => x.path === '/auth/login'))).toBe(false);
  });

  it('sends the CSRF token from the cookie on state-changing calls', async () => {
    document.cookie = 'csrf_token=abc123; path=/';
    unauthenticated();
    routes['POST /auth/login'] = () => json(200, { user: USER });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Email or username'), 'aya@clinic.test');
    await userEvent.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/auth/login')).toBe(true));
    expect(calls.find((c) => c.path === '/auth/login')!.headers.get('x-csrf-token')).toBe('abc123');
  });
});

describe('password reset', () => {
  it('tells people to ask the clinic, because no email is sent', async () => {
    unauthenticated();
    renderAt('/forgot-password');
    expect(await screen.findByText(/Ask the clinic to reset your password/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send reset link' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('rejects mismatched passwords locally and sends the token from the URL otherwise', async () => {
    unauthenticated();
    routes['POST /auth/reset-password'] = () => json(200, { message: 'ok' });
    renderAt('/reset-password/tok-123');

    await userEvent.type(await screen.findByLabelText('New password'), 'Reset-Pass-4242');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'Different-Pass-1');
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auth/reset-password')).toBe(false);

    await userEvent.clear(screen.getByLabelText('Confirm new password'));
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'Reset-Pass-4242');
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText(/Password updated/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/reset-password')!.body).toEqual({ token: 'tok-123', password: 'Reset-Pass-4242' });
  });

  it('rejects weak passwords with the policy message', async () => {
    unauthenticated();
    renderAt('/reset-password/tok-123');
    await userEvent.type(await screen.findByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Update password' }));
    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
  });
});
