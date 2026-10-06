import { SURFACES, type ChartToothDto, type Paginated, type TimelineEntryDto } from '@aya/shared';
import type { Db } from '../../db/connection';
import type { AuthUser } from '../../middleware/auth';
import { appointmentQuery, toDtos } from '../appointments/service';
import { accessChecker } from './access';
import { loadReports, patientSafe } from './reports';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

export interface TimelinePatient {
  id: number;
  user_id: number | null;
  doctor_id: number | null;
}

/**
 * A patient's appointments, newest first, each with its report when the viewer may read it.
 * A patient (viewing their own timeline) gets the summary and prescriptions only.
 * `hasReport` tells a viewer a report exists even when they may not open it.
 */
export async function buildTimeline(
  db: Db,
  user: AuthUser,
  patient: TimelinePatient,
  page: { page: number; pageSize: number },
): Promise<Paginated<TimelineEntryDto>> {
  const check = await accessChecker(db, user);

  const base = appointmentQuery(db).where('a.patient_id', patient.id);
  const total = Number((await base.clone().clearSelect().count({ n: '*' }).first())?.n ?? 0);
  const rows: Row[] = await base
    .clone()
    .orderBy([{ column: 'a.date', order: 'desc' }, { column: 'a.time', order: 'desc' }, { column: 'a.id', order: 'desc' }])
    .limit(page.pageSize)
    .offset((page.page - 1) * page.pageSize);

  const dtos = await toDtos(db, rows, { staff: true });
  const reports = await loadReports(db, rows.map((r) => r.id));

  const data = dtos.map((a, i): TimelineEntryDto => {
    const report = reports.get(a.id);
    const access = check({ doctor_id: rows[i]!.doctor_id, patient_user_id: patient.user_id, patient_doctor_id: patient.doctor_id });
    return {
      appointment: {
        id: a.id, date: a.date, time: a.time, endTime: a.endTime, durationMinutes: a.durationMinutes, status: a.status,
        doctor: a.doctor, clinic: a.clinic, categories: a.categories.map((c) => c.name),
      },
      hasReport: Boolean(report),
      report: report && access.read ? (access.full ? report : patientSafe(report)) : null,
    };
  });
  return { data, meta: { page: page.page, pageSize: page.pageSize, total } };
}

/**
 * Tooth history for the dental chart: every note ever recorded on each tooth, oldest first.
 * Clinic-only. A doctor sees the notes of visits he is allowed to read.
 */
export async function buildChart(db: Db, user: AuthUser, patient: TimelinePatient): Promise<ChartToothDto[]> {
  const check = await accessChecker(db, user);
  const rows: Row[] = await db('report_tooth as rt')
    .join('reports as r', 'r.id', 'rt.report_id')
    .join('appointments as a', 'a.id', 'r.appointment_id')
    .join('teeth as t', 't.id', 'rt.tooth_id')
    .join('doctors as d', 'd.id', 'a.doctor_id')
    .where('a.patient_id', patient.id)
    .whereNull('a.deleted_at')
    .whereNull('r.deleted_at')
    .select('rt.*', 'a.id as appointment_id', 'a.doctor_id', 'd.fname as d_fname', 'd.lname as d_lname', 't.index as t_index', 't.name as t_name')
    .orderBy([{ column: 't.id' }, { column: 'rt.date' }, { column: 'rt.id' }]);

  const byTooth = new Map<number, ChartToothDto>();
  for (const r of rows) {
    if (!SURFACES.some((s) => r[s])) continue; // a tooth listed with no notes isn't history
    const access = check({ doctor_id: r.doctor_id, patient_user_id: patient.user_id, patient_doctor_id: patient.doctor_id });
    if (!access.read || !access.full) continue;
    const tooth: ChartToothDto = byTooth.get(r.tooth_id) ?? { toothId: r.tooth_id, index: r.t_index, name: r.t_name, entries: [] };
    tooth.entries.push({
      appointmentId: r.appointment_id, date: r.date, doctor: { id: r.doctor_id, fname: r.d_fname, lname: r.d_lname },
      ...(Object.fromEntries(SURFACES.map((s) => [s, r[s] ?? null])) as Record<(typeof SURFACES)[number], string | null>),
    });
    byTooth.set(r.tooth_id, tooth);
  }
  return [...byTooth.values()];
}
