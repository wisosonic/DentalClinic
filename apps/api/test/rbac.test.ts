import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertPatientAccess } from '../src/lib/ownership';
import { can } from '../src/lib/permissions';
import { PASSWORD, buildTestApp, loggedIn, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp();
});
afterAll(() => t.destroy());
beforeEach(async () => {
  await t.db('users').update({ is_active: true, change_password: false, password: bcrypt.hashSync(PASSWORD, 4) });
  await t.db('users').where({ email: 'admin2@clinic.test' }).update({ role: 'admin' });
  await t.db('users').where({ email: 'created@clinic.test' }).del();
  await t.db('refresh_tokens').del();
  await t.db('audit_log').del();
});

describe('permission matrix', () => {
  it('denies by default', () => {
    expect(can('admin', 'users:create')).toBe(true);
    expect(can('doctor', 'users:read')).toBe(false);
    expect(can('staff', 'users:read')).toBe(false);
    expect(can('patient', 'users:read')).toBe(false);
    // Deleting: staff and doctors soft delete; only an admin touches the Trash.
    expect(can('staff', 'patients:delete')).toBe(true);
    expect(can('doctor', 'appointments:delete')).toBe(true);
    expect(can('staff', 'visits:delete')).toBe(true);
    expect(can('staff', 'visits:update')).toBe(false);
    expect(can('patient', 'patients:delete')).toBe(false);
    expect(can('patient', 'appointments:delete')).toBe(false);
    for (const action of ['read', 'update', 'delete'] as const) {
      expect(can('admin', `trash:${action}`)).toBe(true);
      for (const role of ['doctor', 'staff', 'patient'] as const) expect(can(role, `trash:${action}`)).toBe(false);
    }
    expect(can('doctor', 'expenses:read')).toBe(false);
    expect(can('patient', 'payments:create')).toBe(false);
    expect(can('patient', 'appointments:create')).toBe(false); // patients cannot book online
    expect(can('patient', 'appointments:read')).toBe(true);
    expect(can('doctor', 'appointments:create')).toBe(true);
    expect(can('staff', 'appointments:create')).toBe(true);
    expect(can('doctor', 'doctors:create')).toBe(true); // external doctors only; enforced in the route
    expect(can('staff', 'doctors:create')).toBe(false);
    // Offers and payments: staff may record a payment and read offers, but not browse payments or write offers.
    expect(can('staff', 'payments:create')).toBe(true);
    expect(can('staff', 'payments:read')).toBe(false);
    expect(can('staff', 'offers:read')).toBe(true);
    expect(can('staff', 'offers:create')).toBe(false);
    expect(can('staff', 'offers:update')).toBe(false);
    expect(can('doctor', 'offers:create')).toBe(true);
    expect(can('doctor', 'payments:create')).toBe(true);
    expect(can('admin', 'offers:read')).toBe(true);
    expect(can('patient', 'offers:create')).toBe(false);
    expect(can('staff', 'quotes:read')).toBe(false); // the old modules are gone
    expect(can('doctor', 'plans:read')).toBe(false);
    expect(can('admin', 'nonexistent:read')).toBe(false);
  });
});

describe('users API authorization', () => {
  it('rejects anonymous callers', async () => {
    expect((await t.client().get('/users')).status).toBe(401);
  });

  it.each(['doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'])('forbids %s', async (email) => {
    const c = await loggedIn(t, email);
    expect((await c.get('/users')).status).toBe(403);
    expect((await c.post('/users', { name: 'X', email: 'x@clinic.test', role: 'admin' })).status).toBe(403);
    expect((await c.patch('/users/1', { role: 'admin' })).status).toBe(403);
    expect((await c.get('/audit-log')).status).toBe(403);
  });

  it('lets an admin list users without leaking secrets', async () => {
    const c = await loggedIn(t, 'admin@clinic.test');
    const res = await c.get('/users?pageSize=2&page=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 2, total: 5 });
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$|"password"/);
  });

  it('filters and searches', async () => {
    const c = await loggedIn(t, 'admin@clinic.test');
    expect((await c.get('/users?role=doctor')).body.data).toHaveLength(1);
    expect((await c.get('/users?q=sam')).body.data[0].email).toBe('staff@clinic.test');
  });

  it('validates query parameters', async () => {
    const c = await loggedIn(t, 'admin@clinic.test');
    expect((await c.get('/users?pageSize=100000')).status).toBe(400);
    expect((await c.get('/users?role=root')).status).toBe(400);
  });

  it('treats SQL metacharacters in search as plain text', async () => {
    const c = await loggedIn(t, 'admin@clinic.test');
    const res = await c.get(`/users?q=${encodeURIComponent("' OR 1=1 --")}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('creating and managing users', () => {
  it('creates a user with a one-time temporary password that must be changed', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    const res = await admin.post('/users', { name: 'New Person', email: 'Created@Clinic.test', role: 'staff' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'created@clinic.test', role: 'staff', mustChangePassword: true });
    expect(res.body.temporaryPassword).toHaveLength(16);

    const fresh = t.client();
    const login = await fresh.login('created@clinic.test', res.body.temporaryPassword);
    expect(login.status).toBe(200);
    expect((await fresh.get('/users')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('refuses duplicate emails, weak passwords, and the patient role', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    expect((await admin.post('/users', { name: 'D', email: 'STAFF@clinic.test', role: 'staff' })).status).toBe(409);
    expect((await admin.post('/users', { name: 'W', email: 'weak@clinic.test', role: 'staff', password: 'short' })).status).toBe(400);
    expect((await admin.post('/users', { name: 'P', email: 'p@clinic.test', role: 'patient' })).status).toBe(400);
  });

  it('deactivating a user ends their session immediately', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    const staff = await loggedIn(t, 'staff@clinic.test');
    const id = (await t.db('users').where({ email: 'staff@clinic.test' }).first()).id;

    expect((await admin.patch(`/users/${id}`, { isActive: false })).status).toBe(200);
    expect((await staff.get('/auth/me')).status).toBe(401);
    expect((await staff.post('/auth/refresh')).status).toBe(401);
    expect((await t.client().login('staff@clinic.test')).status).toBe(401);
  });

  it('a role change ends the user’s existing sessions', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    const staff = await loggedIn(t, 'staff@clinic.test');
    const id = (await t.db('users').where({ email: 'staff@clinic.test' }).first()).id;
    await admin.patch(`/users/${id}`, { role: 'doctor' });
    expect((await staff.post('/auth/refresh')).status).toBe(401);
    await t.db('users').where({ id }).update({ role: 'staff' });
  });

  it('stops an admin from deactivating or demoting themselves', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    const self = (await t.db('users').where({ email: 'admin@clinic.test' }).first()).id;
    expect((await admin.patch(`/users/${self}`, { isActive: false })).body.error.code).toBe('SELF_MODIFY');
    expect((await admin.patch(`/users/${self}`, { role: 'staff' })).body.error.code).toBe('SELF_MODIFY');
  });

  it('lets one admin demote another, which ends the demoted admin’s sessions', async () => {
    const admin1 = await loggedIn(t, 'admin@clinic.test');
    const admin2 = await loggedIn(t, 'admin2@clinic.test');
    const a1 = (await t.db('users').where({ email: 'admin@clinic.test' }).first()).id;
    expect((await admin2.patch(`/users/${a1}`, { role: 'staff' })).status).toBe(200);
    expect((await admin1.get('/users')).status).toBe(403);
    expect((await admin1.post('/auth/refresh')).status).toBe(401);
    await t.db('users').where({ id: a1 }).update({ role: 'admin' });
  });

  it('refuses to change the role of a patient account', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    const id = (await t.db('users').where({ email: 'patient@clinic.test' }).first()).id;
    expect((await admin.patch(`/users/${id}`, { role: 'staff' })).body.error.code).toBe('PATIENT_ROLE_LOCKED');
  });

  it('resets another user’s password and forces a change', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    const id = (await t.db('users').where({ email: 'doctor@clinic.test' }).first()).id;
    const res = await admin.post(`/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    const fresh = t.client();
    expect((await fresh.login('doctor@clinic.test', PASSWORD)).status).toBe(401);
    const login = await fresh.login('doctor@clinic.test', res.body.temporaryPassword);
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it('returns 404 for unknown users and 400 for bad ids', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    expect((await admin.patch('/users/99999', { name: 'x' })).status).toBe(404);
    expect((await admin.patch('/users/abc', { name: 'x' })).status).toBe(400);
    expect((await admin.patch('/users/1', {})).status).toBe(400);
  });
});

describe('audit log', () => {
  it('records admin actions and redacts secrets', async () => {
    const admin = await loggedIn(t, 'admin@clinic.test');
    await admin.post('/users', { name: 'New Person', email: 'created@clinic.test', role: 'staff', password: 'Sup3r-Secret-Pass' });

    const res = await admin.get('/audit-log?action=user.create');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].diff).toMatchObject({ email: 'created@clinic.test', role: 'staff' });
    expect(JSON.stringify(res.body)).not.toContain('Sup3r-Secret-Pass');
  });
});

describe('object-level access (IDOR guard)', () => {
  it('lets a patient reach only their own record, and staff reach any', async () => {
    const now = '2026-01-01 00:00:00';
    const patientUser = await t.db('users').where({ email: 'patient@clinic.test' }).first();
    const staffUser = await t.db('users').where({ email: 'staff@clinic.test' }).first();
    const [mine] = await t.db('patients').insert({ patient_identifier: 'P1', fname: 'Pat', lname: 'One', phone: '1', user_id: patientUser.id, created_at: now });
    const [theirs] = await t.db('patients').insert({ patient_identifier: 'P2', fname: 'Other', lname: 'Two', phone: '2', created_at: now });
    const asPatient = { id: patientUser.id, name: '', email: '', role: 'patient' as const, mustChangePassword: false };
    const asStaff = { ...asPatient, id: staffUser.id, role: 'staff' as const };

    await expect(assertPatientAccess(t.db, asPatient, mine as number)).resolves.toBeUndefined();
    await expect(assertPatientAccess(t.db, asPatient, theirs as number)).rejects.toMatchObject({ status: 404 });
    await expect(assertPatientAccess(t.db, asStaff, theirs as number)).resolves.toBeUndefined();

    await t.db('patients').update({ deleted_at: now }).where({ id: mine });
    await expect(assertPatientAccess(t.db, asPatient, mine as number)).rejects.toMatchObject({ status: 404 });
  });
});

describe('platform hardening', () => {
  it('sends security headers and hides the framework', async () => {
    const res = await t.client().agent.get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });

  it('returns JSON errors for unknown routes, bad JSON, and oversized bodies', async () => {
    const c = t.client();
    expect((await c.agent.get('/api/v1/nope')).body.error.code).toBe('NOT_FOUND');
    const bad = await c.agent.post('/api/v1/auth/login').set('content-type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const huge = await c.agent.post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(2_000_000) });
    expect(huge.status).toBe(413);
  });
});
