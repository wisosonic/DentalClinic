import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { STAFF_ROLES, type PatientCountsDto } from '@aya/shared';
import type { AppContext } from '../../context';
import { notFound } from '../../lib/errors';
import { can } from '../../lib/permissions';
import { doctorScope, ownsPatient } from '../../lib/scope';
import { requirePermission, requireRole, requireUser } from '../../middleware/auth';
import { appointmentQuery } from '../appointments/service';
import { limitToScope, moneyScope, paymentQuery } from '../finance/service';
import { offerQuery, offerScope } from '../offers/service';
import { familyCount } from './family';

const idParam = z.coerce.number().int().positive();

/**
 * `GET /patients/:id/counts`: how many appointments, family members, payments, treatment offers and documents the
 * patient has, for the badges on the patient page's buttons. Each figure counts what the person could open from that
 * section (the same scope as its own list), and is null where they have no such section (staff cannot browse payments).
 * Clinic staff only; a patient the person may not open answers 404, like the profile.
 */
export function patientCountsRouter(ctx: AppContext): Router {
  const { db } = ctx;
  const router = Router({ mergeParams: true });
  router.use(requireRole(...STAFF_ROLES));

  const total = async (qb: Knex.QueryBuilder) => Number(((await qb.clearSelect().count({ n: '*' }).first()) as { n?: number | string } | undefined)?.n ?? 0);

  router.get('/', requirePermission('patients:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const scope = await doctorScope(db, user);
    const patient = await db('patients').where({ id }).whereNull('deleted_at').first('id', 'doctor_id');
    if (!patient || !ownsPatient(scope, patient.doctor_id)) throw notFound('Patient not found');

    const money = await moneyScope(db, user);
    const offerAccess = await offerScope(db, user);
    const counts: PatientCountsDto = {
      appointments: can(user.role, 'appointments:read') ? await total(appointmentQuery(db).where('a.patient_id', id)) : 0,
      family: await familyCount(ctx, scope, id),
      payments: null,
      offers: null,
      documents: null,
    };
    if (user.role !== 'staff' && can(user.role, 'payments:read')) {
      counts.payments = await total(paymentQuery(db).where('q.patient_id', id).modify((qb) => limitToScope(qb, money)));
    }
    if (can(user.role, 'offers:read')) counts.offers = await total(offerQuery(db).where('q.patient_id', id).modify((qb) => limitToScope(qb, offerAccess)));
    if (can(user.role, 'documents:read')) {
      counts.documents = Number((await db('patient_documents').where({ patient_id: id }).whereNull('deleted_at').count({ n: '*' }).first())?.n ?? 0);
    }
    res.json(counts);
  });

  return router;
}
