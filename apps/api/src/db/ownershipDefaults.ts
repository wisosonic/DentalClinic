import type { Knex } from 'knex';
import { sqlNow } from './connection';

type Conn = Knex | Knex.Transaction;

export interface OwnershipReport {
  owners: number;
  units: number;
  appointments: number;
}

/**
 * One-time setup for data that predates doctor kinds and dental units. It is NOT safe to
 * re-run on a live database, because it can't tell an owner from an external doctor who
 * also works at the clinic; it runs once from migration 004 and after the dump import.
 *
 *  1. Doctors assigned to a clinic become owners; everyone else is external.
 *  2. Each owner gets a dental unit in each clinic they are assigned to.
 *  3. Every appointment is placed on its doctor's unit at its clinic, else on the first unit
 *     of that clinic.
 *
 * Dr Sara and any other owner who isn't assigned yet are set up in the app afterwards.
 */
export async function applyOwnershipDefaults(db: Conn): Promise<OwnershipReport> {
  const now = sqlNow();
  const links = await db('clinic_doctor as cd')
    .join('doctors as d', 'd.id', 'cd.doctor_id')
    .select('cd.doctor_id', 'cd.clinic_id', 'd.fname');

  const owners = [...new Set(links.map((l: { doctor_id: number }) => l.doctor_id))];
  if (owners.length) await db('doctors').whereIn('id', owners).update({ kind: 'owner', commission_percent: null });

  let units = 0;
  for (const l of links as { doctor_id: number; clinic_id: number; fname: string }[]) {
    const exists = await db('dental_units').where({ clinic_id: l.clinic_id, owner_doctor_id: l.doctor_id }).first('id');
    if (exists) continue;
    await db('dental_units').insert({
      clinic_id: l.clinic_id, owner_doctor_id: l.doctor_id, name: `Dr ${l.fname}'s unit`, created_at: now, updated_at: now,
    });
    units++;
  }

  let appointments = 0;
  const unplaced = await db('appointments').whereNull('unit_id').select('id', 'doctor_id', 'clinic_id');
  for (const a of unplaced as { id: number; doctor_id: number; clinic_id: number }[]) {
    const unit =
      (await db('dental_units').where({ clinic_id: a.clinic_id, owner_doctor_id: a.doctor_id }).first('id')) ??
      (await db('dental_units').where({ clinic_id: a.clinic_id }).orderBy('id').first('id'));
    if (!unit) continue;
    await db('appointments').where({ id: a.id }).update({ unit_id: unit.id });
    appointments++;
  }
  return { owners: owners.length, units, appointments };
}
