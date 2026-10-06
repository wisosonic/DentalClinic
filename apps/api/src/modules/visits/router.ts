import { Router } from 'express';
import { z } from 'zod';
import { reportMedicationsSchema, reportSummarySchema, reportTeethSchema, type ReportResponse } from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow, type Db } from '../../db/connection';
import { isUniqueError } from '../../lib/dbErrors';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { fromMinutes, toMinutes } from '../../lib/time';
import { requireAuth, requirePermission, requireUser } from '../../middleware/auth';
import { audit, auditView } from '../audit/audit';
import { accessChecker, type ReportAccess } from './access';
import { assertClinicExists } from '../appointments/service';
import { contactOverride } from '../settings/app';
import { renderVisitPdf } from './pdf';
import { loadReports, patientSafe } from './reports';

const idParam = z.coerce.number().int().positive();

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The visit report of an appointment: `/appointments/:id/report`.
 * One report per appointment, optional, written by the treating doctor or an admin.
 * Anyone who may not read it gets 404, so reports can't be probed by id.
 */
export function visitReportRouter(ctx: AppContext): Router {
  const { db, env } = ctx;
  const router = Router({ mergeParams: true });
  router.use(requireAuth(ctx));

  /** Loads the appointment (with what the access rules need) and the caller's access. */
  async function open(req: Parameters<typeof requireUser>[0]) {
    const user = requireUser(req);
    const id = idParam.parse((req.params as Record<string, string>).id);
    const appt = await db('appointments as a')
      .join('patients as p', 'p.id', 'a.patient_id')
      .join('doctors as d', 'd.id', 'a.doctor_id')
      .leftJoin('clinics as c', 'c.id', 'a.clinic_id') // none once the clinic was deleted
      .where('a.id', id)
      .whereNull('p.deleted_at')
      .whereNull('a.deleted_at')
      .first(
        'a.id', 'a.date', 'a.time', 'a.duration_minutes', 'a.status', 'a.doctor_id', 'a.patient_id', 'a.clinic_id',
        'p.user_id as patient_user_id', 'p.doctor_id as patient_doctor_id', 'p.fname as p_fname', 'p.lname as p_lname', 'p.patient_identifier',
        'd.fname as d_fname', 'd.lname as d_lname', 'd.speciality',
        'c.name as c_name', 'c.address as c_address', 'c.phone as c_phone',
      );
    const access: ReportAccess = appt ? (await accessChecker(db, user))(appt) : { read: false, write: false, full: false };
    if (!appt || !access.read) throw notFound('Appointment not found');
    return { user, id, appt, access };
  }

  /** Writing: read access isn't enough. */
  function assertCanWrite(ctxt: Awaited<ReturnType<typeof open>>) {
    if (!ctxt.access.write) throw forbidden('Only the treating doctor or an admin can edit this report');
    assertClinicExists(ctxt.appt); // the clinic was deleted: the report stays as it was, read-only
    if (['cancelled', 'no_show'].includes(ctxt.appt.status)) {
      throw new HttpError(409, 'NOT_TREATED', `A ${String(ctxt.appt.status).replace('_', ' ')} appointment has no visit to report on`, { status: ctxt.appt.status });
    }
  }

  /** Finds the report, creating an empty one the first time. */
  async function ensureReport(trx: Tx, appointmentId: number): Promise<number> {
    const existing = await trx('reports').where({ appointment_id: appointmentId }).first('id', 'deleted_at');
    if (existing?.deleted_at) {
      throw new HttpError(409, 'REPORT_IN_TRASH', 'The report of this visit was deleted. An admin can restore it or erase it permanently from the Trash.');
    }
    if (existing) return existing.id;
    const now = sqlNow();
    try {
      const [id] = await trx('reports').insert({ appointment_id: appointmentId, summary: null, created_at: now, updated_at: now });
      return id as number;
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      return (await trx('reports').where({ appointment_id: appointmentId }).first('id')).id; // lost a race
    }
  }

  const respond = async (c: Awaited<ReturnType<typeof open>>): Promise<ReportResponse> => {
    const report = (await loadReports(db, [c.id])).get(c.id) ?? null;
    return { report: report ? (c.access.full ? report : patientSafe(report)) : null, canEdit: c.access.write };
  };

  router.get('/', async (req, res) => {
    const c = await open(req);
    await auditView(ctx, req, { user: c.user, action: 'report.view', patientId: c.appt.patient_id, appointmentId: c.id });
    res.json(await respond(c));
  });

  // Delete the report (to the Trash). Staff may, though they cannot edit reports; doctors only the ones they may edit.
  router.delete('/', requirePermission('visits:delete'), async (req, res) => {
    const c = await open(req);
    if (c.user.role !== 'staff' && !c.access.write) throw forbidden('Only the treating doctor or an admin can delete this report');
    const now = sqlNow();
    const changed = await db('reports').where({ appointment_id: c.id }).whereNull('deleted_at').update({ deleted_at: now, deleted_by: c.user.id, updated_at: now });
    if (!changed) throw notFound('This appointment has no report yet');
    await audit(ctx, req, { userId: c.user.id, action: 'report.delete', entity: 'appointment', entityId: c.id });
    res.status(204).end();
  });

  router.put('/', async (req, res) => {
    const c = await open(req);
    assertCanWrite(c);
    const { summary } = reportSummarySchema.parse(req.body);
    await db.transaction(async (trx) => {
      const reportId = await ensureReport(trx, c.id);
      await trx('reports').where({ id: reportId }).update({ summary: summary || null, updated_at: sqlNow() });
    });
    await audit(ctx, req, { userId: c.user.id, action: 'report.summary', entity: 'appointment', entityId: c.id });
    res.json(await respond(c));
  });

  router.put('/teeth', async (req, res) => {
    const c = await open(req);
    assertCanWrite(c);
    const { teeth } = reportTeethSchema.parse(req.body);
    const ids = teeth.map((t) => t.toothId);
    if (ids.length && Number((await db('teeth').whereIn('id', ids).count({ n: '*' }).first())?.n) !== ids.length) {
      throw badRequest('UNKNOWN_TOOTH', 'Unknown tooth');
    }
    const existing = await db('reports').where({ appointment_id: c.id }).first('id');
    if (existing || teeth.length) {
      const now = sqlNow();
      await db.transaction(async (trx) => {
        const reportId = await ensureReport(trx, c.id);
        await trx('report_tooth').where({ report_id: reportId }).del();
        if (teeth.length) {
          await trx('report_tooth').insert(
            teeth.map((t) => ({
              report_id: reportId, tooth_id: t.toothId, date: c.appt.date,
              labial: t.labial ?? null, buccal: t.buccal ?? null, lingual: t.lingual ?? null,
              mesial: t.mesial ?? null, distal: t.distal ?? null, occlusal: t.occlusal ?? null,
              created_at: now, updated_at: now,
            })),
          );
        }
        await trx('reports').where({ id: reportId }).update({ updated_at: now });
      });
    }
    // Field names only: the notes are health data and don't belong in the log.
    await audit(ctx, req, { userId: c.user.id, action: 'report.teeth', entity: 'appointment', entityId: c.id, diff: { toothIds: ids } });
    res.json(await respond(c));
  });

  router.put('/medications', async (req, res) => {
    const c = await open(req);
    assertCanWrite(c);
    const { medications } = reportMedicationsSchema.parse(req.body);
    const ids = [...new Set(medications.map((m) => m.medicationId))];
    if (ids.length && Number((await db('medications').whereIn('id', ids).count({ n: '*' }).first())?.n) !== ids.length) {
      throw badRequest('UNKNOWN_MEDICATION', 'Unknown medication');
    }
    const existing = await db('reports').where({ appointment_id: c.id }).first('id');
    if (existing || medications.length) {
      const now = sqlNow();
      await db.transaction(async (trx) => {
        const reportId = await ensureReport(trx, c.id);
        await trx('medication_report').where({ report_id: reportId }).del();
        if (medications.length) {
          await trx('medication_report').insert(
            medications.map((m) => ({
              report_id: reportId, medication_id: m.medicationId, dose: m.dose, frequency: String(m.frequency),
              time_unit: m.timeUnit, notes: m.notes ?? null, created_at: now, updated_at: now,
            })),
          );
        }
        await trx('reports').where({ id: reportId }).update({ updated_at: now });
      });
    }
    await audit(ctx, req, { userId: c.user.id, action: 'report.medications', entity: 'appointment', entityId: c.id, diff: { medicationIds: ids } });
    res.json(await respond(c));
  });

  // The patient-safe visit summary and prescription as a PDF.
  router.get('/pdf', async (req, res) => {
    const c = await open(req);
    const report = (await loadReports(db, [c.id])).get(c.id);
    if (!report) throw new HttpError(404, 'NO_REPORT', 'This appointment has no report yet');

    const procedures = await db('appointment_category as ac')
      .join('categories as k', 'k.id', 'ac.category_id')
      .where('ac.appointment_id', c.id)
      .orderBy('k.name')
      .pluck('k.name');
    const { appt } = c;
    const pdf = await renderVisitPdf(
      {
        clinic: await (async () => {
          const contact = await contactOverride(db); // contact details saved in Settings replace the clinic record's
          return { name: appt.c_name ?? 'Clinic', address: contact.address ?? appt.c_address ?? null, phone: contact.phone ?? appt.c_phone ?? null, email: contact.email ?? null };
        })(),
        patient: { name: `${appt.p_fname} ${appt.p_lname}`.trim(), number: appt.patient_identifier },
        doctor: { name: `${appt.d_fname} ${appt.d_lname}`.trim(), speciality: appt.speciality ?? null },
        date: appt.date,
        start: appt.time,
        end: fromMinutes(toMinutes(appt.time) + appt.duration_minutes),
        procedures,
        report: patientSafe(report),
      },
      { compress: env.NODE_ENV !== 'test' },
    );

    await audit(ctx, req, { userId: c.user.id, action: 'report.pdf', entity: 'appointment', entityId: c.id });
    res
      .status(200)
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="visit-${appt.date}-${appt.patient_identifier}.pdf"`,
        'Cache-Control': 'no-store', // health information
        'Content-Length': String(pdf.length),
      })
      .end(pdf);
  });

  return router;
}
