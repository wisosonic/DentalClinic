import { z } from 'zod';

export const rolePermissionsInputSchema = z.object({
  permissions: z.array(z.string().regex(/^[a-z_]+:(read|create|update|delete)$/, 'Unknown permission')).max(200),
});
export type RolePermissionsInput = z.infer<typeof rolePermissionsInputSchema>;

/** A report too big to wait for, made in the background. */
export interface ReportJobDto {
  id: number;
  report: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  rows: number | null;
  createdAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  /** Where to download it once it is done. */
  downloadUrl: string | null;
}

export interface RoleDto {
  role: 'admin' | 'doctor' | 'staff' | 'patient';
  /** Whether the admin may change this role's permissions (doctor and staff only). */
  editable: boolean;
  /** How many accounts have this role. */
  users: number;
  /** What the role may do now ("module:action"), the admin's changes included. */
  permissions: string[];
  /** What it may do without any change. */
  defaults: string[];
}

export interface RolesResponse {
  roles: RoleDto[];
  /** Every permission the admin may switch on or off for an editable role. */
  switchable: string[];
  /** Of those, the ones that can only be taken away, never given where the role lacks them. */
  revokeOnly: string[];
}
