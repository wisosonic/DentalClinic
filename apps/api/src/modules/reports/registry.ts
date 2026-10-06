import type { AppContext } from '../../context';
import type { AuthUser } from '../../middleware/auth';
import { REPORT_LIMITS, appointmentsList, labOrdersReport, outstandingBalances, patientsReport, proceduresReport, revenue } from './data';
import type { ReportTable } from './render';

type Role = AuthUser['role'];

/** Who may run which report: admin all; a doctor within his own patients; staff only the schedule and the lab orders. */
export const ACCESS: Record<string, Role[]> = {
  'daily-schedule': ['admin', 'doctor', 'staff'],
  revenue: ['admin', 'doctor'],
  'outstanding-balances': ['admin', 'doctor'],
  appointments: ['admin', 'doctor'],
  procedures: ['admin', 'doctor'],
  patients: ['admin', 'doctor'],
  'lab-orders': ['admin', 'doctor', 'staff'],
};

/**
 * Builds a report again from what was saved when it was queued (the filters), as the person who asked, under
 * the rules of their role today. Only the reports that can be big as Excel files are here: the daily schedule
 * is one day, and PDFs are never made in the background.
 */
export async function buildQueued(ctx: AppContext, user: AuthUser, key: string, params: Record<string, unknown>): Promise<ReportTable> {
  const p = { from: String(params.from ?? ''), to: String(params.to ?? '') };
  switch (key) {
    case 'revenue':
      return revenue(ctx, user, p, params.groupBy === 'type' || params.groupBy === 'doctor' ? params.groupBy : 'month');
    case 'outstanding-balances':
      return outstandingBalances(ctx, user);
    case 'appointments':
      return appointmentsList(ctx, user, p, { doctorId: typeof params.doctorId === 'number' ? params.doctorId : undefined, status: typeof params.status === 'string' ? params.status : undefined }, REPORT_LIMITS.background);
    case 'procedures':
      return proceduresReport(ctx, user, p);
    case 'patients':
      return patientsReport(ctx, user, p, REPORT_LIMITS.background);
    case 'lab-orders':
      return labOrdersReport(ctx, user, p, typeof params.status === 'string' ? params.status : undefined, REPORT_LIMITS.background);
    default:
      throw new Error(`Report ${key} cannot be queued`);
  }
}
