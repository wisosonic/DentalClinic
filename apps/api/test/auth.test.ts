import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, buildTestApp, cookieValue, loggedIn, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp();
});
afterAll(() => t.destroy());
beforeEach(async () => {
  await t.db('users').update({
    failed_logins: 0,
    locked_until: null,
    is_active: true,
    change_password: false,
    password: bcrypt.hashSync(PASSWORD, 4),
  });
  await t.db('refresh_tokens').del();
  await t.db('audit_log').del();
});

describe('login', () => {
  it('signs in and sets hardened cookies without exposing the password hash', async () => {
    const res = await t.client().login('admin@clinic.test');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'admin@clinic.test', role: 'admin', mustChangePassword: false });
    expect(JSON.stringify(res.body)).not.toMatch(/"password"|\$2[aby]\$/i);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith('access_token='))!;
    const refresh = cookies.find((c) => c.startsWith('refresh_token='))!;
    const csrf = cookies.find((c) => c.startsWith('csrf_token='))!;
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
    expect(csrf).not.toMatch(/HttpOnly/i);
  });

  it('rejects wrong password and unknown email with the same response', async () => {
    const wrong = await t.client().login('admin@clinic.test', 'not-the-password');
    const unknown = await t.client().login('nobody@clinic.test', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('is case-insensitive on email', async () => {
    expect((await t.client().login('ADMIN@Clinic.Test')).status).toBe(200);
  });

  it('rejects malformed input with a validation error', async () => {
    const res = await t.client().post('/auth/login', { email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses inactive accounts', async () => {
    await t.db('users').where({ email: 'staff@clinic.test' }).update({ is_active: false });
    expect((await t.client().login('staff@clinic.test')).status).toBe(401);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    for (let i = 0; i < t.env.MAX_FAILED_LOGINS; i++) await t.client().login('staff@clinic.test', 'wrong-password-1');
    const locked = await t.client().login('staff@clinic.test');
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('INVALID_CREDENTIALS');

    const audit = await t.db('audit_log').where({ action: 'auth.lockout' });
    expect(audit).toHaveLength(1);

    await t.db('users').where({ email: 'staff@clinic.test' }).update({ locked_until: '2000-01-01 00:00:00' });
    expect((await t.client().login('staff@clinic.test')).status).toBe(200);
  });

  it('resets the failure counter on success', async () => {
    await t.client().login('staff@clinic.test', 'wrong-password-1');
    await t.client().login('staff@clinic.test');
    const row = await t.db('users').where({ email: 'staff@clinic.test' }).first();
    expect(row.failed_logins).toBe(0);
    expect(row.last_login_at).toBeTruthy();
  });

  it('accepts password hashes written by PHP ($2y$) and re-hashes at the configured cost', async () => {
    const strong = await buildTestApp({ BCRYPT_COST: '5' });
    try {
      const phpHash = bcrypt.hashSync(PASSWORD, 4).replace(/^\$2[ab]\$/, '$2y$');
      await strong.db('users').where({ email: 'doctor@clinic.test' }).update({ password: phpHash });
      expect((await strong.client().login('doctor@clinic.test')).status).toBe(200);
      const row = await strong.db('users').where({ email: 'doctor@clinic.test' }).first();
      expect(row.password).toMatch(/^\$2[ab]\$05\$/);
    } finally {
      await strong.destroy();
    }
  });

  it('records successes and failures in the audit log', async () => {
    await t.client().login('admin@clinic.test', 'wrong-password-1');
    await t.client().login('admin@clinic.test');
    const actions = (await t.db('audit_log').select('action')).map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login.failed', 'auth.login.success']));
  });
});

describe('rate limiting', () => {
  it('throttles repeated login attempts per IP', async () => {
    const limited = await buildTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await limited.client().login('nobody@clinic.test', 'wrong-password-1')).status);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await limited.destroy();
    }
  });
});

describe('session', () => {
  it('requires authentication for /me', async () => {
    expect((await t.client().get('/auth/me')).status).toBe(401);
  });

  it('returns the current user after login', async () => {
    const c = await loggedIn(t, 'doctor@clinic.test');
    const res = await c.get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('doctor');
  });

  it('rejects a tampered or foreign access token', async () => {
    const res = await request(t.app).get('/api/v1/auth/me').set('Cookie', 'access_token=abc.def.ghi');
    expect(res.status).toBe(401);
  });

  it('applies account deactivation immediately, without waiting for token expiry', async () => {
    const c = await loggedIn(t, 'staff@clinic.test');
    await t.db('users').where({ email: 'staff@clinic.test' }).update({ is_active: false });
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the family when an old one is replayed', async () => {
    const c = await t.client();
    const login = await c.login('admin@clinic.test');
    const oldRefresh = cookieValue(login, 'refresh_token')!;

    const first = await c.post('/auth/refresh');
    expect(first.status).toBe(200);
    const newRefresh = cookieValue(first, 'refresh_token')!;
    expect(newRefresh).not.toBe(oldRefresh);

    // An attacker replays the stolen, already-used token.
    const replay = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${oldRefresh}`, `csrf_token=${c.csrf}`])
      .set('x-csrf-token', c.csrf);
    expect(replay.status).toBe(401);

    // The legitimate (newer) token in the same family is now dead too.
    const after = await c.post('/auth/refresh');
    expect(after.status).toBe(401);
    // Both the replay and the follow-up present an already-revoked token.
    expect((await t.db('audit_log').where({ action: 'auth.refresh.reuse' })).length).toBeGreaterThanOrEqual(1);
  });

  it('rejects expired refresh tokens', async () => {
    const c = t.client();
    await c.login('admin@clinic.test');
    await t.db('refresh_tokens').update({ expires_at: '2000-01-01 00:00:00' });
    expect((await c.post('/auth/refresh')).status).toBe(401);
  });

  it('stores only a hash of the refresh token', async () => {
    const login = await t.client().login('admin@clinic.test');
    const raw = cookieValue(login, 'refresh_token')!;
    const rows = await t.db('refresh_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(raw);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logout revokes the session', async () => {
    const c = t.client();
    const login = await c.login('admin@clinic.test');
    const refresh = cookieValue(login, 'refresh_token')!;
    const csrf = c.csrf;

    expect((await c.post('/auth/logout')).status).toBe(204);
    expect(await t.db('refresh_tokens').whereNull('revoked_at')).toHaveLength(0);

    // A copy of the refresh cookie taken before logout no longer works.
    const replay = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${refresh}`, `csrf_token=${csrf}`])
      .set('x-csrf-token', csrf);
    expect(replay.status).toBe(401);
  });
});

describe('csrf', () => {
  it('blocks state-changing requests that lack the token header', async () => {
    const c = await loggedIn(t, 'admin@clinic.test');
    const res = await c.send('post', '/auth/logout', {}, false);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/CSRF/);
  });

  it('blocks a mismatching token', async () => {
    const c = await loggedIn(t, 'admin@clinic.test');
    const res = await c.agent.post('/api/v1/auth/logout').set('x-csrf-token', 'forged');
    expect(res.status).toBe(403);
  });

  it('does not require a token for login (no session yet)', async () => {
    const res = await request(t.app).post('/api/v1/auth/login').send({ email: 'admin@clinic.test', password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('change password', () => {
  it('confines accounts flagged for a password change until they change it', async () => {
    const c = await loggedIn(t, 'staff@clinic.test');
    await t.db('users').where({ email: 'staff@clinic.test' }).update({ change_password: true });

    const blocked = await c.get('/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await c.get('/auth/me')).body.user.mustChangePassword).toBe(true);

    const done = await c.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Brand-New-Pass-77' });
    expect(done.status).toBe(200);
    expect(done.body.user.mustChangePassword).toBe(false);
    expect((await c.get('/auth/me')).status).toBe(200);

    expect((await t.client().login('staff@clinic.test', PASSWORD)).status).toBe(401);
    expect((await t.client().login('staff@clinic.test', 'Brand-New-Pass-77')).status).toBe(200);
  });

  it('signs out other devices', async () => {
    const phone = await loggedIn(t, 'staff@clinic.test');
    const laptop = await loggedIn(t, 'staff@clinic.test');
    await laptop.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Brand-New-Pass-77' });
    expect((await phone.post('/auth/refresh')).status).toBe(401);
    expect((await laptop.get('/auth/me')).status).toBe(200);
    await t.db('users').update({ password: bcrypt.hashSync(PASSWORD, 4) });
  });

  it('verifies the current password', async () => {
    const c = await loggedIn(t, 'staff@clinic.test');
    const res = await c.post('/auth/change-password', { currentPassword: 'wrong-password-1', newPassword: 'Brand-New-Pass-77' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WRONG_PASSWORD');
  });

  it.each([
    ['too short', 'Short-1'],
    ['too common', 'password123'],
    ['one repeated character', 'aaaaaaaaaaaa'],
    ['contains the email name', 'staff-is-great-1'],
  ])('rejects a weak password (%s)', async (_label, weak) => {
    const c = await loggedIn(t, 'staff@clinic.test');
    const res = await c.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: weak });
    expect(res.status).toBe(400);
  });

  it('rejects reusing the current password', async () => {
    const c = await loggedIn(t, 'staff@clinic.test');
    const res = await c.post('/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(res.body.error.code).toBe('PASSWORD_UNCHANGED');
  });
});

describe('reset links handed over by an admin', () => {
  const tokenFrom = (link: string) => link.split('/').pop()!;
  const userId = async (email: string) => (await t.db('users').where({ email }).first('id')).id as number;
  const makeLink = async (email = 'staff@clinic.test') => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    const res = await admin.post(`/users/${await userId(email)}/reset-link`);
    return { res, admin, token: res.body.link ? tokenFrom(res.body.link) : '' };
  };

  it('has no public forgot-password route (the clinic sends no email)', async () => {
    expect((await t.client().post('/auth/forgot-password', { email: 'staff@clinic.test' })).status).toBe(404);
  });

  it('gives an admin a one-time link to hand over', async () => {
    const { res } = await makeLink();
    expect(res.status).toBe(200);
    expect(res.body.link).toMatch(/\/reset-password\/[A-Za-z0-9_-]{40,}$/);
    expect(res.body.expiresInHours).toBe(24);
    const logged = await t.db('audit_log').where({ action: 'user.reset-link' }).first();
    expect(logged).toBeTruthy();
    expect(JSON.stringify(logged)).not.toContain(tokenFrom(res.body.link)); // the link itself is never logged
  });

  it('is for admins only', async () => {
    const id = await userId('staff@clinic.test');
    for (const email of ['doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test']) {
      expect((await (await loggedIn(t, email)).post(`/users/${id}/reset-link`)).status).toBe(403);
    }
  });

  it('answers 404 for an unknown user and 400 for a switched-off account', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    expect((await admin.post('/users/99999/reset-link')).status).toBe(404);
    await t.db('users').where({ email: 'staff@clinic.test' }).update({ is_active: false });
    expect((await admin.post(`/users/${await userId('staff@clinic.test')}/reset-link`)).body.error.code).toBe('USER_INACTIVE');
  });

  it('lets the person choose a password once, ends sessions, and clears any lockout', async () => {
    const victim = await loggedIn(t, 'staff@clinic.test');
    await t.db('users').where({ email: 'staff@clinic.test' }).update({ locked_until: '2999-01-01 00:00:00' });
    const { token } = await makeLink();

    const ok = await t.client().post('/auth/reset-password', { token, password: 'Reset-Pass-4242' });
    expect(ok.status).toBe(200);
    expect((await victim.post('/auth/refresh')).status).toBe(401);
    expect((await t.client().login('staff@clinic.test', 'Reset-Pass-4242')).status).toBe(200);

    const again = await t.client().post('/auth/reset-password', { token, password: 'Another-Pass-4242' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects expired and unknown tokens', async () => {
    const { token } = await makeLink();
    await t.db('password_reset_tokens').update({ expires_at: '2000-01-01 00:00:00' });
    expect((await t.client().post('/auth/reset-password', { token, password: 'Reset-Pass-4242' })).status).toBe(400);
    expect((await t.client().post('/auth/reset-password', { token: 'x'.repeat(43), password: 'Reset-Pass-4242' })).status).toBe(400);
  });

  it('cancels the earlier link when a new one is made', async () => {
    const first = await makeLink();
    const second = await makeLink();
    expect((await t.client().post('/auth/reset-password', { token: first.token, password: 'Reset-Pass-4242' })).status).toBe(400);
    expect((await t.client().post('/auth/reset-password', { token: second.token, password: 'Reset-Pass-4242' })).status).toBe(200);
  });

  it('refuses a weak password and keeps the link usable', async () => {
    const { token } = await makeLink();
    expect((await t.client().post('/auth/reset-password', { token, password: 'short' })).status).toBe(400);
    expect((await t.client().post('/auth/reset-password', { token, password: 'Reset-Pass-4242' })).status).toBe(200);
  });

  it('stores only a hash of the token', async () => {
    const { token } = await makeLink();
    const rows = await t.db('password_reset_tokens');
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
  });
});
