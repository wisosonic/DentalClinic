import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import {
  COMMISSION_REQUIRED,
  STAFF_ROLES,
  clinicDoctorInputSchema,
  clinicInputSchema,
  clinicUpdateSchema,
  doctorInputSchema,
  doctorUpdateSchema,
  unitCreateSchema,
  unitUpdateSchema,
  type ClinicDoctorDto,
  type ClinicDto,
  type DeletedClinicDataDto,
  type DoctorDto,
  type UnitDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { isForeignKeyError } from '../../lib/dbErrors';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { sniffImage } from '../../lib/images';
import { doctorScope, type DoctorScope } from '../../lib/scope';
import { clinicNow } from '../../lib/time';
import { requireAuth, requirePermission, requireRole, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

function toDoctorDto(r: Row, user: AuthUser, scope: DoctorScope): DoctorDto {
  const dto: DoctorDto = {
    id: r.id, fname: r.fname, lname: r.lname, speciality: r.speciality ?? null,
    gender: r.gender ? String(r.gender).toLowerCase() : null, kind: r.kind,
  };
  // Contact details are for the clinic, not for patients.
  if (user.role !== 'patient') {
    Object.assign(dto, {
      email: r.email ?? null, phone: r.phone ?? null, address: r.address ?? null,
      facebook: r.facebook ?? null, instagram: r.instagram ?? null, twitter: r.twitter ?? null,
    });
  }
  // The commission percentage is financial: admins and owner doctors, and a specialist sees only his own.
  if (user.role === 'admin' || (user.role === 'doctor' && (!scope.restricted || r.id === scope.doctorId))) {
    dto.commissionPercent = r.commission_percent == null ? null : Number(r.commission_percent);
  }
  // Which login is this doctor: an admin concern.
  if (user.role === 'admin') {
    dto.userId = r.user_id ?? null;
    dto.taxSpouse = Boolean(r.tax_spouse);
    dto.taxChildren = Number(r.tax_children ?? 0);
  }
  return dto;
}

// The file name carries a random part, so it doubles as a cache-buster when the logo is replaced.
const LOGO_NAME = /^clinic-\d+-([a-f0-9]{12})\.(png|jpg|webp)$/;
const LOGO_MAX_BYTES = 512 * 1024;

const toClinicDto = (r: Row): ClinicDto => ({
  id: r.id, name: r.name, phone: r.phone ?? null, address: r.address ?? null,
  type: r.type ?? null, latitude: r.latitude ?? null, longitude: r.longitude ?? null,
  logoUrl: r.logo_file && LOGO_NAME.test(r.logo_file) ? `/api/v1/clinics/${r.id}/logo?v=${LOGO_NAME.exec(r.logo_file)![1]}` : null,
});

const toUnitDto = (r: Row): UnitDto => ({
  id: r.id, clinicId: r.clinic_id, name: r.name, ownerDoctorId: r.owner_doctor_id, ownerName: `${r.fname} ${r.lname}`.trim(),
});

const DOCTOR_COLS: Record<string, string> = {
  fname: 'fname', lname: 'lname', email: 'email', speciality: 'speciality', gender: 'gender', phone: 'phone',
  address: 'address', facebook: 'facebook', instagram: 'instagram', twitter: 'twitter',
  kind: 'kind', commissionPercent: 'commission_percent', userId: 'user_id', taxSpouse: 'tax_spouse', taxChildren: 'tax_children',
};

function toDoctorColumns(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([k, v]) => v !== undefined && k in DOCTOR_COLS).map(([k, v]) => [DOCTOR_COLS[k]!, v]),
  );
}

export function doctorsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', requirePermission('doctors:read'), async (req, res) => {
    const user = requireUser(req);
    const rows = await db('doctors').orderBy(['fname', 'lname']);
    const scope = await doctorScope(db, user);
    res.json({ data: rows.map((r: Row) => toDoctorDto(r, user, scope)) });
  });

  router.get('/:id', requirePermission('doctors:read'), async (req, res) => {
    const row = await db('doctors').where({ id: idParam.parse(req.params.id) }).first();
    if (!row) throw notFound('Doctor not found');
    const user = requireUser(req);
    res.json({ doctor: toDoctorDto(row, user, await doctorScope(db, user)) });
  });

  // Admins create any doctor; owner doctors may only add external doctors.
  router.post('/', requirePermission('doctors:create'), async (req, res) => {
    const user = requireUser(req);
    const input = doctorInputSchema.parse(req.body);
    if (user.role !== 'admin' && input.kind !== 'external') throw forbidden('Only an admin can add an owner doctor');
    // External specialists don't manage the clinic's doctors.
    if ((await doctorScope(db, user)).restricted) throw forbidden('Only an owner doctor or an admin can add doctors');

    const now = sqlNow();
    const values = toDoctorColumns({ ...input, commissionPercent: input.kind === 'external' ? input.commissionPercent : null });
    const [id] = await db('doctors').insert({ ...values, created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'doctor.create', entity: 'doctor', entityId: id as number, diff: { kind: input.kind } });
    res.status(201).json({ doctor: toDoctorDto(await db('doctors').where({ id }).first(), user, await doctorScope(db, user)) });
  });

  router.patch('/:id', requirePermission('doctors:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = doctorUpdateSchema.parse(req.body);
    if (!Object.keys(input).length) throw badRequest('EMPTY_UPDATE', 'Nothing to update');

    const target = await db('doctors').where({ id }).first();
    if (!target) throw notFound('Doctor not found');
    if ((await doctorScope(db, user)).restricted) throw forbidden('Only an owner doctor or an admin can edit doctors');
    if (user.role !== 'admin' && (target.kind !== 'external' || input.kind === 'owner')) {
      throw forbidden('Only an admin can change an owner doctor');
    }

    if (input.taxSpouse !== undefined || input.taxChildren !== undefined) {
      if (user.role !== 'admin') throw forbidden('Only an admin can change the income tax family details');
    }
    if (input.userId !== undefined) {
      if (user.role !== 'admin') throw forbidden('Only an admin can link a doctor to a login');
      if (input.userId !== null) {
        const account = await db('users').where({ id: input.userId }).first('role');
        if (!account) throw badRequest('UNKNOWN_USER', 'Unknown user');
        if (!['admin', 'doctor'].includes(account.role)) throw badRequest('INVALID_USER_ROLE', 'Only an admin or doctor login can be linked to a doctor');
        const taken = await db('doctors').where({ user_id: input.userId }).whereNot({ id }).first('id');
        if (taken) throw new HttpError(409, 'USER_ALREADY_LINKED', 'That login is already linked to another doctor');
      }
    }

    const nextKind = input.kind ?? target.kind;
    if (input.kind && input.kind !== target.kind && target.kind === 'owner') {
      const owned = await db('dental_units').where({ owner_doctor_id: id }).first('id');
      if (owned) throw new HttpError(409, 'DOCTOR_OWNS_UNITS', 'This doctor owns a dental unit, so they cannot become external');
    }
    // A percentage is required whenever a doctor becomes external or the percentage is edited.
    if (nextKind === 'external' && (input.kind === 'external' || input.commissionPercent !== undefined)) {
      const percent = input.commissionPercent !== undefined ? input.commissionPercent : target.commission_percent;
      if (percent === null || percent === undefined) {
        throw badRequest('COMMISSION_REQUIRED', COMMISSION_REQUIRED, [{ path: 'commissionPercent', message: COMMISSION_REQUIRED }]);
      }
    }

    const values = toDoctorColumns({ ...input, ...(nextKind === 'owner' ? { commissionPercent: null } : {}) });
    await db('doctors').where({ id }).update({ ...values, updated_at: sqlNow() });
    await audit(ctx, req, { userId: user.id, action: 'doctor.update', entity: 'doctor', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ doctor: toDoctorDto(await db('doctors').where({ id }).first(), user, await doctorScope(db, user)) });
  });

  router.delete('/:id', requireRole('admin'), requirePermission('doctors:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    try {
      // Patients keep their record (doctor is set to none); appointments and owned units block the delete.
      const changed = await db('doctors').where({ id }).del();
      if (!changed) throw notFound('Doctor not found');
    } catch (err) {
      if (isForeignKeyError(err)) {
        throw new HttpError(409, 'DOCTOR_IN_USE', 'This doctor has appointments or owns a dental unit and cannot be deleted');
      }
      throw err;
    }
    await audit(ctx, req, { userId: user.id, action: 'doctor.delete', entity: 'doctor', entityId: id });
    res.status(204).end();
  });

  return router;
}

export function clinicsRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router();
  router.use(requireAuth(ctx));

  const uploadDir = path.resolve(env.UPLOAD_DIR);
  const removeFile = (name: string | null | undefined) => {
    if (name && LOGO_NAME.test(name)) void unlink(path.join(uploadDir, name)).catch(() => undefined);
  };

  router.get('/', requirePermission('clinics:read'), async (_req, res) => {
    res.json({ data: (await db('clinics').orderBy('name')).map(toClinicDto) });
  });

  /** What deleted clinics left behind: appointments and dental units with no clinic. Read-only records; delete them elsewhere (an appointment goes to the Trash). */
  router.get('/deleted-data', requireRole('admin'), requirePermission('clinics:read'), async (_req, res) => {
    const appts: Row[] = await db('appointments as a').join('patients as p', 'p.id', 'a.patient_id').join('doctors as d', 'd.id', 'a.doctor_id').leftJoin('dental_units as u', 'u.id', 'a.unit_id')
      .whereNull('a.clinic_id').whereNull('a.deleted_at').whereNull('p.deleted_at').orderBy([{ column: 'a.date', order: 'desc' }, { column: 'a.time', order: 'desc' }])
      .select('a.id', 'a.date', 'a.time', 'a.status', 'p.id as pid', 'p.fname', 'p.lname', 'd.id as did', 'd.fname as d_fname', 'd.lname as d_lname', 'u.id as uid', 'u.name as u_name');
    const reported = new Set<number>((appts.length ? await db('reports').whereIn('appointment_id', appts.map((a) => a.id)).whereNull('deleted_at').pluck('appointment_id') : []) as number[]);
    const units: Row[] = await db('dental_units as u').join('doctors as d', 'd.id', 'u.owner_doctor_id').whereNull('u.clinic_id').orderBy('u.id')
      .select('u.id', 'u.name', 'd.fname', 'd.lname', db.raw('(SELECT COUNT(*) FROM appointments a WHERE a.unit_id = u.id) AS n'));
    const body: DeletedClinicDataDto = {
      appointments: appts.map((a) => ({
        id: a.id, date: a.date, time: a.time, status: a.status, patient: { id: a.pid, fname: a.fname, lname: a.lname }, doctor: { id: a.did, fname: a.d_fname, lname: a.d_lname },
        unit: a.uid ? { id: a.uid, name: a.u_name } : null, hasReport: reported.has(a.id),
      })),
      units: units.map((u) => ({ id: u.id, name: u.name, ownerName: `${u.fname} ${u.lname}`.trim(), appointments: Number(u.n) })),
    };
    res.json(body);
  });

  router.get('/:id', requirePermission('clinics:read'), async (req, res) => {
    const row = await db('clinics').where({ id: idParam.parse(req.params.id) }).first();
    if (!row) throw notFound('Clinic not found');
    res.json({ clinic: toClinicDto(row) });
  });

  router.post('/', requireRole('admin'), requirePermission('clinics:create'), async (req, res) => {
    const user = requireUser(req);
    const input = clinicInputSchema.parse(req.body);
    const now = sqlNow();
    const [id] = await db('clinics').insert({ ...compact(input), created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'clinic.create', entity: 'clinic', entityId: id as number });
    res.status(201).json({ clinic: toClinicDto(await db('clinics').where({ id }).first()) });
  });

  router.patch('/:id', requireRole('admin'), requirePermission('clinics:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = clinicUpdateSchema.parse(req.body);
    if (!Object.keys(input).length) throw badRequest('EMPTY_UPDATE', 'Nothing to update');
    if (!(await db('clinics').where({ id }).first('id'))) throw notFound('Clinic not found');
    await db('clinics').where({ id }).update({ ...compact(input), updated_at: sqlNow() });
    await audit(ctx, req, { userId: user.id, action: 'clinic.update', entity: 'clinic', entityId: id, diff: { fields: Object.keys(input) } });
    res.json({ clinic: toClinicDto(await db('clinics').where({ id }).first()) });
  });

  // ----- logo ----------------------------------------------------------------

  router.get('/:id/logo', requirePermission('clinics:read'), async (req, res) => {
    const row = await db('clinics').where({ id: idParam.parse(req.params.id) }).first('logo_file');
    if (!row?.logo_file || !LOGO_NAME.test(row.logo_file)) throw notFound('Clinic logo not found');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(row.logo_file, { root: uploadDir, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Clinic logo not found' } });
    });
  });

  // The image is sent as the raw request body (Content-Type image/png, image/jpeg or image/webp).
  router.put(
    '/:id/logo', requireRole('admin'), requirePermission('clinics:update'),
    express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: LOGO_MAX_BYTES }),
    async (req, res) => {
      const user = requireUser(req);
      const id = idParam.parse(req.params.id);
      const clinic = await db('clinics').where({ id }).first();
      if (!clinic) throw notFound('Clinic not found');
      const body: unknown = req.body;
      const kind = Buffer.isBuffer(body) && body.length > 0 ? sniffImage(body) : null;
      if (!kind) throw badRequest('INVALID_IMAGE', 'Choose a PNG, JPEG or WebP image');

      const name = `clinic-${id}-${randomBytes(6).toString('hex')}.${kind.ext}`;
      await mkdir(uploadDir, { recursive: true });
      await writeFile(path.join(uploadDir, name), body as Buffer);
      await db('clinics').where({ id }).update({ logo_file: name, updated_at: sqlNow() });
      removeFile(clinic.logo_file);
      await audit(ctx, req, { userId: user.id, action: 'clinic.logo.set', entity: 'clinic', entityId: id });
      res.json({ clinic: toClinicDto(await db('clinics').where({ id }).first()) });
    },
  );

  router.delete('/:id/logo', requireRole('admin'), requirePermission('clinics:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const clinic = await db('clinics').where({ id }).first();
    if (!clinic) throw notFound('Clinic not found');
    await db('clinics').where({ id }).update({ logo_file: null, updated_at: sqlNow() });
    removeFile(clinic.logo_file);
    await audit(ctx, req, { userId: user.id, action: 'clinic.logo.remove', entity: 'clinic', entityId: id });
    res.json({ clinic: toClinicDto(await db('clinics').where({ id }).first()) });
  });

  router.delete('/:id', requireRole('admin'), requirePermission('clinics:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const existing = await db('clinics').where({ id }).first('logo_file');
    if (!existing) throw notFound('Clinic not found');
    // Only the clinic's own record goes. Its appointments (and the dental units they were on) stay, for the
    // payment, commission and tax figures, with no clinic: read-only, and an admin can review or delete them.
    const kept = await db.transaction(async (trx) => {
      const appointments = Number((await trx('appointments').where({ clinic_id: id }).count({ n: '*' }).first())?.n ?? 0);
      // a unit nobody was ever booked on has nothing to keep
      const unused = await trx('dental_units as u').where('u.clinic_id', id).whereNotExists(trx('appointments as a').whereRaw('a.unit_id = u.id').select(trx.raw('1'))).pluck('u.id');
      if (unused.length) await trx('dental_units').whereIn('id', unused).del();
      const units = Number((await trx('dental_units').where({ clinic_id: id }).count({ n: '*' }).first())?.n ?? 0);
      await trx('clinics').where({ id }).del(); // the foreign keys set clinic_id to NULL on what is kept
      return { appointments, units };
    });
    removeFile(existing.logo_file);
    await audit(ctx, req, { userId: user.id, action: 'clinic.delete', entity: 'clinic', entityId: id, diff: { keptAppointments: kept.appointments, keptUnits: kept.units } });
    res.status(204).end();
  });

  // ----- which doctors work at this clinic -----------------------------------

  const toLinkDto = (r: Row, user: AuthUser): ClinicDoctorDto => ({
    doctorId: r.doctor_id, clinicId: r.clinic_id, fname: r.fname, lname: r.lname, speciality: r.speciality ?? null, kind: r.kind,
    // The doctor's share is a financial figure: admin only.
    ...(user.role === 'admin' ? { drPart: Number(r.dr_part) } : {}),
  });

  const links = (clinicId: number) =>
    db('clinic_doctor as cd').join('doctors as d', 'd.id', 'cd.doctor_id').where('cd.clinic_id', clinicId)
      .select('cd.*', 'd.fname', 'd.lname', 'd.speciality', 'd.kind');

  router.get('/:id/doctors', requirePermission('clinics:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    if (!(await db('clinics').where({ id }).first('id'))) throw notFound('Clinic not found');
    const rows = await links(id).orderBy(['d.fname', 'd.lname']);
    res.json({ data: rows.map((r: Row) => toLinkDto(r, user)) });
  });

  // Assigning an owner doctor also gives them their dental unit at this clinic.
  router.put('/:id/doctors/:doctorId', requireRole('admin'), requirePermission('clinics:update'), async (req, res) => {
    const user = requireUser(req);
    const clinicId = idParam.parse(req.params.id);
    const doctorId = idParam.parse(req.params.doctorId);
    const input = clinicDoctorInputSchema.parse(req.body ?? {});

    if (!(await db('clinics').where({ id: clinicId }).first('id'))) throw notFound('Clinic not found');
    const doctor = await db('doctors').where({ id: doctorId }).first();
    if (!doctor) throw notFound('Doctor not found');

    const now = sqlNow();
    const existing = await db('clinic_doctor').where({ clinic_id: clinicId, doctor_id: doctorId }).first('id');
    await db.transaction(async (trx) => {
      if (existing) {
        await trx('clinic_doctor').where({ id: existing.id }).update({ dr_part: input.drPart, updated_at: now });
      } else {
        await trx('clinic_doctor').insert({ clinic_id: clinicId, doctor_id: doctorId, dr_part: input.drPart, created_at: now, updated_at: now });
      }
      if (doctor.kind === 'owner' && !(await trx('dental_units').where({ clinic_id: clinicId, owner_doctor_id: doctorId }).first('id'))) {
        await trx('dental_units').insert({
          clinic_id: clinicId, owner_doctor_id: doctorId, name: `Dr ${doctor.fname}'s unit`, created_at: now, updated_at: now,
        });
      }
    });
    await audit(ctx, req, { userId: user.id, action: 'clinic.doctor.set', entity: 'clinic', entityId: clinicId, diff: { doctorId } });
    const row = await links(clinicId).where('cd.doctor_id', doctorId).first();
    res.status(existing ? 200 : 201).json({ link: toLinkDto(row, user) });
  });

  router.delete('/:id/doctors/:doctorId', requireRole('admin'), requirePermission('clinics:update'), async (req, res) => {
    const user = requireUser(req);
    const clinicId = idParam.parse(req.params.id);
    const doctorId = idParam.parse(req.params.doctorId);
    // Keep history intact: a doctor with upcoming bookings here can't simply be removed.
    const future = await db('appointments')
      .where({ clinic_id: clinicId, doctor_id: doctorId })
      .whereNull('deleted_at')
      .whereIn('status', ['pending', 'confirmed'])
      .where('date', '>=', clinicNow(ctx.env, ctx.clock()).date)
      .count({ n: '*' }).first();
    if (Number(future?.n) > 0) throw new HttpError(409, 'HAS_UPCOMING', 'This doctor has upcoming appointments at this clinic. Cancel or move them first.');
    const changed = await db('clinic_doctor').where({ clinic_id: clinicId, doctor_id: doctorId }).del();
    if (!changed) throw notFound('Doctor is not assigned to this clinic');
    await audit(ctx, req, { userId: user.id, action: 'clinic.doctor.remove', entity: 'clinic', entityId: clinicId, diff: { doctorId } });
    res.status(204).end();
  });

  return router;
}

/** Dental units: created with their owner doctor's clinic assignment; renamed or removed here. */
export function unitsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router();
  router.use(requireAuth(ctx), requireRole(...STAFF_ROLES));

  const query = () =>
    db('dental_units as u').join('doctors as d', 'd.id', 'u.owner_doctor_id').select('u.*', 'd.fname', 'd.lname');

  router.get('/', requirePermission('clinics:read'), async (req, res) => {
    const clinicId = z.coerce.number().int().positive().optional().parse(req.query.clinicId);
    const rows = await query().whereNotNull('u.clinic_id').modify((qb) => { // units of deleted clinics are on their own page
      if (clinicId) qb.where('u.clinic_id', clinicId);
    }).orderBy(['u.clinic_id', 'u.id']);
    res.json({ data: rows.map(toUnitDto) });
  });

  const nameTaken = async (clinicId: number, name: string, exceptId?: number) =>
    Boolean(
      await db('dental_units')
        .where({ clinic_id: clinicId })
        .whereRaw('LOWER(name) = ?', [name.toLowerCase()])
        .modify((qb) => {
          if (exceptId) qb.whereNot({ id: exceptId });
        })
        .first('id'),
    );

  // An admin adds a unit for an owner doctor who works at the clinic. (Assigning an owner
  // doctor to a clinic creates their first unit automatically; this is for extra ones.)
  router.post('/', requireRole('admin'), requirePermission('clinics:create'), async (req, res) => {
    const user = requireUser(req);
    const input = unitCreateSchema.parse(req.body);

    if (!(await db('clinics').where({ id: input.clinicId }).first('id'))) throw badRequest('UNKNOWN_CLINIC', 'Unknown clinic');
    const owner = await db('doctors').where({ id: input.ownerDoctorId }).first('kind');
    if (!owner) throw badRequest('UNKNOWN_DOCTOR', 'Unknown doctor');
    if (owner.kind !== 'owner') throw badRequest('NOT_AN_OWNER', 'Only an owner doctor can own a dental unit');
    if (!(await db('clinic_doctor').where({ clinic_id: input.clinicId, doctor_id: input.ownerDoctorId }).first('id'))) {
      throw new HttpError(409, 'DOCTOR_NOT_AT_CLINIC', 'Assign this doctor to the clinic first');
    }
    if (await nameTaken(input.clinicId, input.name)) throw new HttpError(409, 'NAME_TAKEN', 'This clinic already has a dental unit with that name');

    const now = sqlNow();
    const [id] = await db('dental_units').insert({
      clinic_id: input.clinicId, owner_doctor_id: input.ownerDoctorId, name: input.name, created_at: now, updated_at: now,
    });
    await audit(ctx, req, { userId: user.id, action: 'unit.create', entity: 'unit', entityId: id as number, diff: { clinicId: input.clinicId, ownerDoctorId: input.ownerDoctorId } });
    res.status(201).json({ unit: toUnitDto(await query().where('u.id', id).first()) });
  });

  router.patch('/:id', requireRole('admin'), requirePermission('clinics:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const { name } = unitUpdateSchema.parse(req.body);
    const existing = await db('dental_units').where({ id }).first('clinic_id');
    if (!existing) throw notFound('Dental unit not found');
    if (existing.clinic_id === null) throw new HttpError(409, 'CLINIC_DELETED', 'This record belongs to a deleted clinic and can no longer be changed');
    if (await nameTaken(existing.clinic_id, name, id)) throw new HttpError(409, 'NAME_TAKEN', 'This clinic already has a dental unit with that name');
    const changed = await db('dental_units').where({ id }).update({ name, updated_at: sqlNow() });
    if (!changed) throw notFound('Dental unit not found');
    await audit(ctx, req, { userId: user.id, action: 'unit.rename', entity: 'unit', entityId: id });
    res.json({ unit: toUnitDto(await query().where('u.id', id).first()) });
  });

  router.delete('/:id', requireRole('admin'), requirePermission('clinics:delete'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    try {
      const changed = await db('dental_units').where({ id }).del();
      if (!changed) throw notFound('Dental unit not found');
    } catch (err) {
      if (isForeignKeyError(err)) throw new HttpError(409, 'UNIT_IN_USE', 'This dental unit has appointments and cannot be deleted');
      throw err;
    }
    await audit(ctx, req, { userId: user.id, action: 'unit.delete', entity: 'unit', entityId: id });
    res.status(204).end();
  });

  return router;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}
