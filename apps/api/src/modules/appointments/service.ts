import type { Knex } from 'knex';
import {
  ACTIVE_STATUSES,
  type AppointmentDto,
  type AppointmentStatus,
  type BusyDto,
  type BusyPeriodDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/connection';
import { HttpError, badRequest } from '../../lib/errors';
import type { DoctorScope } from '../../lib/scope';
import { fromMinutes, toMinutes } from '../../lib/time';

type Conn = Db | Knex.Transaction;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- joined rows

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Appointments joined with patient, doctor, clinic and unit. Soft-deleted patients are excluded. */
export function appointmentQuery(db: Conn) {
  return db('appointments as a')
    .join('patients as p', 'p.id', 'a.patient_id')
    .join('doctors as d', 'd.id', 'a.doctor_id')
    .leftJoin('clinics as c', 'c.id', 'a.clinic_id') // an appointment of a deleted clinic has none, and stays
    .leftJoin('dental_units as u', 'u.id', 'a.unit_id')
    .whereNull('p.deleted_at')
    .whereNull('a.deleted_at')
    .select(
      'a.*',
      'p.fname as p_fname', 'p.lname as p_lname', 'p.phone as p_phone', 'p.doctor_id as p_doctor_id',
      'd.fname as d_fname', 'd.lname as d_lname',
      'c.name as c_name',
      'u.name as u_name', 'u.owner_doctor_id as u_owner',
    );
}

export async function toDtos(
  db: Conn,
  rows: Row[],
  opts: { staff: boolean; withTeeth?: boolean; scope?: DoctorScope },
): Promise<AppointmentDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const categories = await db('appointment_category as ac')
    .join('categories as c', 'c.id', 'ac.category_id')
    .whereIn('ac.appointment_id', ids)
    .select('ac.appointment_id as appointmentId', 'c.id', 'c.name')
    .orderBy('c.name');

  const reported = new Set<number>(
    (await db('reports').whereIn('appointment_id', ids).whereNull('deleted_at').select('appointment_id')).map((r: Row) => r.appointment_id as number),
  );

  const teeth = opts.withTeeth
    ? await db('appointment_tooth as at')
        .join('teeth as t', 't.id', 'at.tooth_id')
        .whereIn('at.appointment_id', ids)
        .select('at.appointment_id as appointmentId', 't.id as toothId', 't.index', 't.name', 'at.description')
    : [];

  // A restricted specialist sees another doctor's patient only as a name on an appointment he treats.
  const visible = (r: Row) => !opts.scope?.restricted || (opts.scope.doctorId !== null && r.p_doctor_id === opts.scope.doctorId);

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    time: r.time,
    durationMinutes: r.duration_minutes,
    endTime: fromMinutes(toMinutes(r.time) + r.duration_minutes),
    status: r.status as AppointmentStatus,
    intended: r.intended ?? null,
    patientId: r.patient_id,
    doctorId: r.doctor_id,
    clinicId: r.clinic_id ?? null,
    unitId: r.unit_id ?? null,
    offerId: r.offer_id ?? null,
    patientVisible: visible(r),
    patient: { id: r.patient_id, fname: r.p_fname, lname: r.p_lname, ...(opts.staff && visible(r) ? { phone: r.p_phone } : {}) },
    doctor: { id: r.doctor_id, fname: r.d_fname, lname: r.d_lname },
    clinic: r.clinic_id ? { id: r.clinic_id, name: r.c_name } : null,
    unit: r.unit_id ? { id: r.unit_id, name: r.u_name, ownerDoctorId: r.u_owner } : null,
    hasReport: reported.has(r.id),
    categories: categories.filter((c: Row) => c.appointmentId === r.id).map((c: Row) => ({ id: c.id, name: c.name })),
    ...(opts.withTeeth && opts.staff
      ? {
          teeth: teeth
            .filter((t: Row) => t.appointmentId === r.id)
            .map((t: Row) => ({ toothId: t.toothId, index: t.index, name: t.name, description: t.description ?? null })),
        }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// Busy periods and booking rules
// ---------------------------------------------------------------------------

interface BusyQuery {
  doctorId: number;
  unitId: number;
  date: string;
  excludeId?: number;
}

/** Appointments that occupy a doctor's or a unit's time on a day, earliest first. */
async function periods(
  db: Conn,
  column: 'doctor_id' | 'unit_id',
  id: number,
  date: string,
  excludeId?: number,
  scope?: DoctorScope,
): Promise<BusyPeriodDto[]> {
  const rows = await db('appointments as a')
    .join('patients as p', 'p.id', 'a.patient_id')
    .where(`a.${column}`, id)
    .where('a.date', date)
    .whereNull('a.deleted_at')
    .whereIn('a.status', ACTIVE_STATUSES)
    .modify((qb) => {
      if (excludeId) qb.whereNot('a.id', excludeId);
    })
    .select('a.id', 'a.time', 'a.duration_minutes', 'a.status', 'a.doctor_id', 'p.fname', 'p.lname', 'p.doctor_id as p_doctor_id')
    .orderBy(['a.time', 'a.id']);

  return rows.map((r: Row) => {
    const start = toMinutes(r.time);
    return {
      appointmentId: r.id,
      start: r.time,
      end: fromMinutes(start + r.duration_minutes),
      durationMinutes: r.duration_minutes,
      status: r.status as AppointmentStatus,
      // A restricted specialist learns that the time is taken, not by whom, unless it concerns him.
      patientName:
        scope?.restricted && !(scope.doctorId !== null && (r.doctor_id === scope.doctorId || r.p_doctor_id === scope.doctorId))
          ? 'Another patient'
          : `${r.fname} ${r.lname}`.trim(),
    };
  });
}

export async function getBusy(db: Conn, q: BusyQuery, scope?: DoctorScope): Promise<BusyDto> {
  return {
    date: q.date,
    doctorBusy: await periods(db, 'doctor_id', q.doctorId, q.date, q.excludeId, scope),
    unitBusy: await periods(db, 'unit_id', q.unitId, q.date, q.excludeId, scope),
  };
}

export interface BookingCheck extends BusyQuery {
  clinicId: number;
  time: string;
  durationMinutes: number;
}

/**
 * Throws if this appointment can't happen. The only booking rules are:
 *  - the doctor works at the clinic and the unit belongs to it
 *  - the appointment ends before midnight
 *  - neither the doctor nor the dental unit has another appointment overlapping it
 *
 * Doctors have no fixed hours, so there are no working-hours rules. Must run inside the same
 * transaction as the insert/update that follows, so two requests can't both pass.
 */
export async function assertBookable(ctx: AppContext, trx: Conn, b: BookingCheck): Promise<void> {
  const { env } = ctx;

  // Serialise bookings on MySQL, always locking doctor then unit. SQLite has one connection.
  if (env.DB_CLIENT === 'mysql') {
    await trx('doctors').where({ id: b.doctorId }).forUpdate().first('id');
    await trx('dental_units').where({ id: b.unitId }).forUpdate().first('id');
  }

  const link = await trx('clinic_doctor').where({ doctor_id: b.doctorId, clinic_id: b.clinicId }).first('id');
  if (!link) throw new HttpError(409, 'DOCTOR_NOT_AT_CLINIC', 'This doctor does not work at the selected clinic');

  const unit = await trx('dental_units').where({ id: b.unitId }).first('clinic_id');
  if (!unit) throw badRequest('UNKNOWN_UNIT', 'Unknown dental unit');
  if (unit.clinic_id !== b.clinicId) throw badRequest('UNIT_NOT_AT_CLINIC', 'That dental unit belongs to a different clinic');

  const start = toMinutes(b.time);
  const end = start + b.durationMinutes;
  if (end > 1440) throw badRequest('ENDS_AFTER_MIDNIGHT', 'The appointment must end before midnight');

  const clash = (list: BusyPeriodDto[]) => list.find((p) => toMinutes(p.start) < end && start < toMinutes(p.start) + p.durationMinutes);

  const doctorClash = clash(await periods(trx, 'doctor_id', b.doctorId, b.date, b.excludeId));
  if (doctorClash) {
    throw new HttpError(409, 'DOCTOR_BUSY', `The doctor already has an appointment from ${doctorClash.start} to ${doctorClash.end}`, {
      appointmentId: doctorClash.appointmentId, start: doctorClash.start, end: doctorClash.end,
    });
  }
  const unitClash = clash(await periods(trx, 'unit_id', b.unitId, b.date, b.excludeId));
  if (unitClash) {
    throw new HttpError(409, 'UNIT_BUSY', `The dental unit is already in use from ${unitClash.start} to ${unitClash.end}`, {
      appointmentId: unitClash.appointmentId, start: unitClash.start, end: unitClash.end,
    });
  }
}


/** An appointment (or report) of a deleted clinic is kept for the records but can no longer be changed. */
export function assertClinicExists(row: { clinic_id?: number | null }): void {
  if (row.clinic_id === null || row.clinic_id === undefined) {
    throw new HttpError(409, 'CLINIC_DELETED', 'This record belongs to a deleted clinic and can no longer be changed');
  }
}
