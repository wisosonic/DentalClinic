import type { Knex } from 'knex';
import type { PrescriptionDto, ReportDto, ToothNoteDto } from '@aya/shared';
import { SURFACES } from '@aya/shared';
import type { Db } from '../../db/connection';

type Conn = Db | Knex.Transaction;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

/** Loads reports (with prescriptions and per-tooth notes) for several appointments at once. */
export async function loadReports(db: Conn, appointmentIds: number[]): Promise<Map<number, ReportDto>> {
  const out = new Map<number, ReportDto>();
  if (!appointmentIds.length) return out;

  const reports: Row[] = await db('reports').whereIn('appointment_id', appointmentIds).whereNull('deleted_at');
  if (!reports.length) return out;
  const ids = reports.map((r) => r.id);

  const meds: Row[] = await db('medication_report as mr')
    .join('medications as m', 'm.id', 'mr.medication_id')
    .whereIn('mr.report_id', ids)
    .select('mr.*', 'm.name as m_name', 'm.type as m_type')
    .orderBy('mr.id');
  const teeth: Row[] = await db('report_tooth as rt')
    .join('teeth as t', 't.id', 'rt.tooth_id')
    .whereIn('rt.report_id', ids)
    .select('rt.*', 't.index as t_index', 't.name as t_name')
    .orderBy('t.id');

  for (const r of reports) {
    out.set(r.appointment_id, {
      id: r.id,
      appointmentId: r.appointment_id,
      summary: r.summary ?? null,
      medications: meds.filter((m) => m.report_id === r.id).map(toPrescription),
      teeth: teeth.filter((t) => t.report_id === r.id).map(toToothNote),
      createdAt: r.created_at ?? null,
      updatedAt: r.updated_at ?? null,
    });
  }
  return out;
}

const toPrescription = (m: Row): PrescriptionDto => ({
  id: m.id,
  medicationId: m.medication_id,
  name: m.m_name,
  type: m.m_type ?? null,
  dose: m.dose,
  frequency: Number(m.frequency),
  timeUnit: m.time_unit,
  notes: m.notes ?? null,
});

const toToothNote = (t: Row): ToothNoteDto => ({
  toothId: t.tooth_id,
  index: t.t_index,
  name: t.t_name,
  date: t.date,
  ...(Object.fromEntries(SURFACES.map((s) => [s, t[s] ?? null])) as Record<(typeof SURFACES)[number], string | null>),
});

/** What a patient may see of a report: the summary and the prescriptions, nothing clinical. */
export const patientSafe = (report: ReportDto): ReportDto => {
  const { teeth: _teeth, ...rest } = report;
  void _teeth;
  return rest;
};
