import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOW, buildTestApp, loggedIn, seedClinic, type Client, type TestApp } from './helpers';
import { can, defaultPermissions, setPermissionOverrides } from '../src/lib/permissions';
import { loadPermissionOverrides } from '../src/modules/roles/router';

/**
 * Administration > Roles. The admin may take permissions away from doctors and staff, and give back or add
 * some; admin and patient never change; the built-in table stays the default and only differences are stored.
 */
let t: TestApp;
let admin: Client, doctor: Client, staff: Client, patient: Client;

beforeAll(async () => {
  t = await buildTestApp({}, () => NOW);
  await seedClinic(t);
  [admin, doctor, staff, patient] = await Promise.all(['admin@clinic.test', 'doctor@clinic.test', 'staff@clinic.test', 'patient@clinic.test'].map((e) => loggedIn(t, e)));
});
afterAll(() => t.destroy());

beforeEach(async () => {
  await t.db('role_permissions').del();
  await t.db('audit_log').del();
  await loadPermissionOverrides(t.db);
});

const role = async (name: string) => (await admin.get('/roles')).body.roles.find((r: { role: string }) => r.role === name);
const without = (list: string[], ...drop: string[]) => list.filter((p) => !drop.includes(p));

describe('who may open the roles', () => {
  it('is the admin’s alone', async () => {
    expect((await admin.get('/roles')).status).toBe(200);
    for (const c of [doctor, staff, patient]) {
      expect((await c.get('/roles')).status).toBe(403);
      expect((await c.put('/roles/staff', { permissions: [] })).status).toBe(403);
      expect((await c.post('/roles/staff/reset')).status).toBe(403);
    }
    expect((await t.client().get('/roles')).status).toBe(401);
  });

  it('describes the four roles with their accounts, what they may do and what is built in', async () => {
    const body = (await admin.get('/roles')).body;
    expect(body.roles.map((r: { role: string }) => r.role)).toEqual(['admin', 'doctor', 'staff', 'patient']);
    expect(body.roles.map((r: { editable: boolean }) => r.editable)).toEqual([false, true, true, false]);
    expect((await role('staff')).users).toBe(1);
    expect((await role('doctor')).permissions).toEqual((await role('doctor')).defaults);
    expect(body.switchable).not.toContain('users:read');
    expect(body.switchable).not.toContain('trash:update');
    expect(body.revokeOnly).toContain('offers:read');
  });

  it('tells each person what their role may do, for the screens to hide the rest', async () => {
    const me = (await staff.get('/auth/me')).body.user;
    expect(me.permissions).toContain('appointments:read');
    expect(me.permissions).not.toContain('offers:create'); // staff read offers but cannot write them
  });
});

describe('changing what a role may do', () => {
  it('takes a permission away at once, keeps the rest, and shows it to the person', async () => {
    expect((await staff.post('/labs', { name: 'Lab Q', phone: '03 123' })).status).toBe(201);
    const staffPerms = (await role('staff')).permissions as string[];
    const res = await admin.put('/roles/staff', { permissions: without(staffPerms, 'labs:create') });
    expect(res.status).toBe(200);
    expect((await role('staff')).permissions).not.toContain('labs:create');
    expect((await staff.post('/labs', { name: 'Lab R', phone: '03 123' })).status).toBe(403);
    expect((await staff.get('/labs')).status).toBe(200); // the rest is untouched
    expect((await staff.get('/auth/me')).body.user.permissions).not.toContain('labs:create');
    expect((await doctor.get('/medications')).status).toBe(200); // another role is not affected
    expect(await t.db('role_permissions').select('role', 'permission', 'allowed')).toEqual([{ role: 'staff', permission: 'labs:create', allowed: 0 }]);
  });

  it('gives a role something it did not have, and only the differences are stored', async () => {
    expect((await staff.post('/medications', {})).status).toBe(403);
    const staffPerms = (await role('staff')).permissions as string[];
    expect((await admin.put('/roles/staff', { permissions: [...staffPerms, 'medications:create'] })).status).toBe(200);
    expect((await staff.post('/medications', {})).status).toBe(400); // allowed in, then the empty form is refused
    expect(await t.db('role_permissions').select('permission', 'allowed')).toEqual([{ permission: 'medications:create', allowed: 1 }]);
    // sending the built-in list again removes the difference
    expect((await admin.put('/roles/staff', { permissions: (await role('staff')).defaults })).status).toBe(200);
    expect(await t.db('role_permissions')).toEqual([]);
    expect((await staff.post('/medications', {})).status).toBe(403);
  });

  it('puts a role back to the built-in permissions with one reset', async () => {
    const docPerms = (await role('doctor')).permissions as string[];
    await admin.put('/roles/doctor', { permissions: without(docPerms, 'medications:create', 'medications:update') });
    expect(can('doctor', 'medications:update')).toBe(false);
    expect((await admin.post('/roles/doctor/reset')).status).toBe(200);
    expect(can('doctor', 'medications:update')).toBe(true);
    expect(await t.db('role_permissions')).toEqual([]);
    expect((await role('doctor')).permissions).toEqual(defaultPermissions('doctor').sort());
  });

  it('keeps the changes after a restart (they are read from the database)', async () => {
    const staffPerms = (await role('staff')).permissions as string[];
    await admin.put('/roles/staff', { permissions: without(staffPerms, 'labs:create') });
    setPermissionOverrides([]); // what a fresh process starts with
    expect(can('staff', 'labs:create')).toBe(true);
    await loadPermissionOverrides(t.db);
    expect(can('staff', 'labs:create')).toBe(false);
  });

  it('records who changed what, as permission names only', async () => {
    const staffPerms = (await role('staff')).permissions as string[];
    await admin.put('/roles/staff', { permissions: [...without(staffPerms, 'labs:create'), 'medications:create'] });
    await admin.post('/roles/staff/reset');
    const rows = await t.db('audit_log').whereIn('action', ['role.update', 'role.reset']).orderBy('id');
    expect(rows.map((r: { action: string }) => r.action)).toEqual(['role.update', 'role.reset']);
    expect(JSON.parse(rows[0].diff)).toEqual({ granted: ['medications:create'], revoked: ['labs:create'] });
    expect(rows[0].entity_id).toBe('staff');
  });
});

describe('what can never be changed', () => {
  it('refuses to touch the admin or patient roles', async () => {
    for (const r of ['admin', 'patient']) {
      expect((await admin.put(`/roles/${r}`, { permissions: [] })).status).toBe(403);
      expect((await admin.post(`/roles/${r}/reset`)).status).toBe(403);
    }
    expect((await admin.put('/roles/janitor', { permissions: [] })).status).toBe(400);
    expect(can('admin', 'users:create')).toBe(true);
  });

  it('never gives the system modules to anyone but the admin, and ignores unknown permissions', async () => {
    const staffPerms = (await role('staff')).permissions as string[];
    for (const p of ['users:read', 'trash:delete', 'settings:update', 'audit:read', 'roles:update', 'nonsense:read']) {
      expect((await admin.put('/roles/staff', { permissions: [...staffPerms, p] })).body.error.code, p).toBe('INVALID_PERMISSION');
    }
    expect((await admin.put('/roles/staff', { permissions: ['not a permission'] })).status).toBe(400);
    expect((await staff.get('/users')).status).toBe(403);
  });

  it('lets money and supplier access be taken away but not given', async () => {
    const staffPerms = (await role('staff')).permissions as string[];
    const res = await admin.put('/roles/staff', { permissions: [...staffPerms, 'payments:read'] });
    expect(res.body.error.code).toBe('NOT_GRANTABLE');
    const docPerms = (await role('doctor')).permissions as string[];
    expect((await admin.put('/roles/doctor', { permissions: [...docPerms, 'expenses:read'] })).body.error.code).toBe('NOT_GRANTABLE');
    // taking it away is fine
    expect((await admin.put('/roles/doctor', { permissions: without(docPerms, 'offers:read', 'offers:create', 'offers:update', 'offers:delete') })).status).toBe(200);
    expect((await doctor.get('/treatment-offers')).status).toBe(403);
  });

  it('refuses to let a role change something it can no longer see', async () => {
    const docPerms = (await role('doctor')).permissions as string[];
    const res = await admin.put('/roles/doctor', { permissions: without(docPerms, 'patients:read') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('READ_REQUIRED');
    expect(can('doctor', 'patients:read')).toBe(true);
  });
});
