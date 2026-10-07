import type { Role } from '@aya/shared';

export type Action = 'read' | 'create' | 'update' | 'delete';
export type Permission = `${string}:${Action}`;

const ALL: Action[] = ['read', 'create', 'update', 'delete'];
const RW: Action[] = ['read', 'create', 'update'];
const R: Action[] = ['read'];

/**
 * Single source of truth for what each role may do. Deny by default: anything not
 * listed is forbidden. Patients are restricted further to their own records
 * (see ownership.ts); this table only says whether the module is reachable at all.
 *
 * Deleting (owner, 2026-10-02): staff and doctors may only soft delete; the Trash, restoring and erasing
 * for good (`trash`) are the admin's alone.
 *
 * Treatment offers (plans and quotes in one, 2026-10-06) and payments: an admin sees everything; a doctor
 * writes and sees only the offers and payments of the patients whose primary doctor he is (scoping is applied in
 * the routes); staff read every offer (never its cost) and book its visits, record payments but cannot browse
 * payment history, and cannot create or change offers.
 */
const DEFAULTS: Record<Role, Record<string, Action[]>> = {
  admin: {
    users: ALL, audit: ['read', 'delete'], patients: ALL, doctors: ALL, clinics: ALL, appointments: ALL,
    visits: ALL, teeth: R, categories: ALL, offers: ALL, payments: ALL, expenses: ALL,
    labs: ALL, suppliers: ALL, medications: ALL, documents: ALL, events: ALL, promotions: ALL,
    notifications: ALL, reports: R, settings: ALL, trash: ALL, roles: ['read', 'update'], waiting: ALL,
  },
  doctor: {
    patients: ALL, doctors: RW, clinics: R, appointments: ALL, visits: ALL, teeth: R,
    categories: R, offers: ALL, payments: ALL, labs: R, medications: RW, documents: ALL,
    notifications: RW, reports: R, waiting: ['read', 'update'],
  },
  staff: {
    patients: ALL, doctors: R, clinics: R, appointments: ALL, visits: ['read', 'delete'], teeth: R,
    categories: R, payments: ['create', 'update', 'delete'], expenses: ALL, labs: ALL, suppliers: ALL,
    medications: R, offers: R, documents: ALL, events: RW, promotions: R, notifications: RW, reports: R, waiting: RW,
  },
  patient: {
    patients: R, appointments: R, offers: R, payments: R,
    notifications: ['read', 'update'], doctors: R, clinics: R,
  },
};

/** The built-in permissions of a role, as "module:action" strings. */
export function defaultPermissions(role: Role): string[] {
  return Object.entries(DEFAULTS[role] ?? {}).flatMap(([module, actions]) => actions.map((a) => `${module}:${a}`));
}

/** Roles whose permissions the admin may change. Admin always keeps everything; a patient's reach is decided by ownership, not by this table. */
export const EDITABLE_ROLES: Role[] = ['doctor', 'staff'];

/** Never given to anyone but admin, whatever the admin chooses: they run the system itself. */
export const ADMIN_ONLY_MODULES = ['users', 'audit', 'trash', 'settings', 'roles'];

/**
 * Money and supplier data can be taken away from a role but not given to one that lacks it: who may see which
 * record (a doctor's own patients, the narrow staff entry) is enforced in the routes, so a bare grant would not do what it says.
 */
export const REVOKE_ONLY_MODULES = ['offers', 'payments', 'expenses', 'suppliers'];

/** What the admin may switch for a role: only the actions the admin's own table has for a module. */
export function editablePermissions(): string[] {
  return defaultPermissions('admin').filter((p) => !ADMIN_ONLY_MODULES.includes(p.split(':')[0]!));
}

// The admin's changes, loaded from the database once the server starts and again whenever they are saved.
let overrides = new Map<string, boolean>();

export function setPermissionOverrides(rows: { role: string; permission: string; allowed: number | boolean }[]): void {
  overrides = new Map(rows.map((r) => [`${r.role}|${r.permission}`, Boolean(r.allowed)]));
}

export function can(role: Role, permission: Permission): boolean {
  const changed = overrides.get(`${role}|${permission}`);
  if (changed !== undefined && role !== 'admin' && EDITABLE_ROLES.includes(role)) return changed;
  const [module, action] = permission.split(':') as [string, Action];
  return DEFAULTS[role]?.[module]?.includes(action) ?? false;
}

/** Everything a role may do now, defaults and the admin's changes together. */
export function effectivePermissions(role: Role): string[] {
  const all = new Set([...defaultPermissions(role), ...(EDITABLE_ROLES.includes(role) ? editablePermissions() : [])]);
  return [...all].filter((p) => can(role, p as Permission)).sort();
}
