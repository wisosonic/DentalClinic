import type { Request } from 'express';
import type { AppContext } from '../../context';
import { sqlFuture, sqlNow } from '../../db/connection';

export interface AuditEntry {
  userId?: number | null;
  action: string;
  entity?: string;
  entityId?: string | number;
  diff?: unknown;
}

const SENSITIVE = /password|token|secret|hash/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}

export async function audit(ctx: AppContext, req: Request | null, entry: AuditEntry): Promise<void> {
  try {
    await ctx.db('audit_log').insert({
      user_id: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity ?? null,
      entity_id: entry.entityId === undefined ? null : String(entry.entityId),
      diff: entry.diff === undefined ? null : JSON.stringify(redact(entry.diff)),
      ip: req?.ip ?? null,
      created_at: sqlNow(),
    });
  } catch (err) {
    // An audit failure must not take down the request, but it must be visible.
    ctx.logger.error({ err, action: entry.action }, 'audit log write failed');
  }
}

/** The same person opening the same thing again within this time is one entry, not a flood. */
const VIEW_WINDOW_MS = 10 * 60 * 1000;

export type ViewKind = 'patient.view' | 'patient.timeline.view' | 'patient.chart.view' | 'patient.family.view' | 'patient.appointments.view' | 'appointment.view' | 'report.view' | 'lab_order.view' | 'offer.view' | 'document.view';

/**
 * Records that a member of the clinic opened a patient's record (read access). Everything is filed
 * under the patient, whichever screen was used, so one patient's history of views can be reviewed.
 * Only ids go in the log, never any of the content. Patients looking at their own record are not logged.
 */
export async function auditView(
  ctx: AppContext,
  req: Request,
  entry: { user: { id: number; role: string }; action: ViewKind; patientId: number; appointmentId?: number },
): Promise<void> {
  if (entry.user.role === 'patient') return;
  try {
    const diff = entry.appointmentId === undefined ? null : JSON.stringify({ appointmentId: entry.appointmentId });
    const recent = await ctx.db('audit_log')
      .where({ user_id: entry.user.id, action: entry.action, entity: 'patient', entity_id: String(entry.patientId) })
      .where('created_at', '>=', sqlFuture(-VIEW_WINDOW_MS))
      .modify((qb) => (diff === null ? qb.whereNull('diff') : qb.where({ diff })))
      .first('id');
    if (recent) return;
  } catch (err) {
    ctx.logger.error({ err, action: entry.action }, 'audit view check failed');
  }
  await audit(ctx, req, {
    userId: entry.user.id, action: entry.action, entity: 'patient', entityId: entry.patientId,
    diff: entry.appointmentId === undefined ? undefined : { appointmentId: entry.appointmentId },
  });
}
