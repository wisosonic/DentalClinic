import { Router } from 'express';
import { z } from 'zod';
import { ROLES, rolePermissionsInputSchema, type Role, type RoleDto, type RolesResponse } from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { sqlNow } from '../../db/connection';
import { badRequest, forbidden } from '../../lib/errors';
import {
  EDITABLE_ROLES, REVOKE_ONLY_MODULES, defaultPermissions, editablePermissions, effectivePermissions, setPermissionOverrides,
} from '../../lib/permissions';
import { requireAuth, requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { audit } from '../audit/audit';

const roleParam = z.enum(ROLES);

/** Reads the admin's saved changes into the permission table (at start-up and after every save). */
export async function loadPermissionOverrides(db: Db): Promise<void> {
  setPermissionOverrides(await db('role_permissions').select('role', 'permission', 'allowed'));
}

const revokeOnly = () => editablePermissions().filter((p) => REVOKE_ONLY_MODULES.includes(p.split(':')[0]!));

/** Administration > Roles: what each role may do. Doctor and staff can be changed; admin and patient are shown as they are. */
export function rolesRouter(ctx: AppContext) {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));
  router.use(requireRole('admin'));

  async function describe(): Promise<RolesResponse> {
    const counts: { role: string; n: number | string }[] = await db('users').groupBy('role').select('role').count({ n: '*' });
    const roles: RoleDto[] = ROLES.map((role) => ({
      role,
      editable: EDITABLE_ROLES.includes(role),
      users: Number(counts.find((c) => c.role === role)?.n ?? 0),
      permissions: effectivePermissions(role),
      defaults: [...defaultPermissions(role)].sort(),
    }));
    return { roles, switchable: editablePermissions(), revokeOnly: revokeOnly() };
  }

  router.get('/', requirePermission('roles:read'), async (_req, res) => {
    res.json(await describe());
  });

  /** Replaces the role's permissions with the list sent; only the differences from the defaults are stored. */
  async function save(role: Role, wanted: Set<string>, userId: number): Promise<{ granted: string[]; revoked: string[] }> {
    const defaults = new Set(defaultPermissions(role));
    const granted = [...wanted].filter((p) => !defaults.has(p)).sort();
    const revoked = [...defaults].filter((p) => editablePermissions().includes(p) && !wanted.has(p)).sort();
    const now = sqlNow();
    await db.transaction(async (trx) => {
      await trx('role_permissions').where({ role }).del();
      const rows = [...granted.map((p) => [p, true] as const), ...revoked.map((p) => [p, false] as const)];
      if (rows.length) {
        await trx('role_permissions').insert(rows.map(([permission, allowed]) => ({ role, permission, allowed, updated_by: userId, created_at: now, updated_at: now })));
      }
    });
    await loadPermissionOverrides(db);
    return { granted, revoked };
  }

  const lockedRole = (role: Role) => {
    if (!EDITABLE_ROLES.includes(role)) {
      throw forbidden(role === 'admin' ? 'The admin role always keeps every permission' : 'A patient’s access follows their own records and cannot be changed here');
    }
  };

  router.put('/:role', requirePermission('roles:update'), async (req, res) => {
    const user = requireUser(req);
    const role = roleParam.parse(req.params.role);
    lockedRole(role);
    const { permissions } = rolePermissionsInputSchema.parse(req.body);
    const switchable = new Set(editablePermissions());
    const wanted = new Set(permissions);
    if ([...wanted].some((p) => !switchable.has(p))) throw badRequest('INVALID_PERMISSION', 'That permission cannot be given to this role');
    const defaults = new Set(defaultPermissions(role));
    const noGrant = new Set(revokeOnly());
    if ([...wanted].some((p) => noGrant.has(p) && !defaults.has(p))) throw badRequest('NOT_GRANTABLE', 'Money and supplier access can be taken away but not given to this role');
    // Writing something without being able to see it makes no sense, and would break the screens.
    for (const p of wanted) {
      const [module, action] = p.split(':') as [string, string];
      if (action !== 'read' && switchable.has(`${module}:read`) && !wanted.has(`${module}:read`) && !(role === 'staff' && module === 'payments')) {
        throw badRequest('READ_REQUIRED', 'A role that can change something must also be able to see it');
      }
    }
    const diff = await save(role, wanted, user.id);
    await audit(ctx, req, { userId: user.id, action: 'role.update', entity: 'role', entityId: role, diff });
    res.json(await describe());
  });

  router.post('/:role/reset', requirePermission('roles:update'), async (req, res) => {
    const user = requireUser(req);
    const role = roleParam.parse(req.params.role);
    lockedRole(role);
    await save(role, new Set(defaultPermissions(role)), user.id);
    await audit(ctx, req, { userId: user.id, action: 'role.reset', entity: 'role', entityId: role });
    res.json(await describe());
  });

  return router;
}
