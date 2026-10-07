import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context';
import { errorHandler, notFoundHandler } from './middleware/error';
import { csrfProtection } from './middleware/csrf';
import { limiter } from './middleware/rateLimit';
import { auditRouter } from './modules/audit/router';
import { appointmentsRouter } from './modules/appointments/router';
import { authRouter } from './modules/auth/router';
import { clinicsRouter, doctorsRouter, unitsRouter } from './modules/clinics/router';
import { commissionRouter } from './modules/finance/commission';
import { directoryRouter, expensesRouter } from './modules/finance/expenses';
import { labOrdersRouter } from './modules/labs/router';
import { offersRouter } from './modules/offers/router';
import { documentRouters } from './modules/documents/router';
import { settingsRouter } from './modules/settings/tax';
import { appSettingsRouter, applyTimezone, publicSettingsRouter } from './modules/settings/app';
import { operatingSettingsRouter } from './modules/settings/operating';
import { taxRouter } from './modules/finance/tax';
import { dashboardRouter } from './modules/dashboard/router';
import { notificationsRouter } from './modules/notifications/router';
import { reportsRouter } from './modules/reports/router';
import { paymentsRouter } from './modules/finance/router';
import { summaryRouter } from './modules/finance/summary';
import { patientsRouter } from './modules/patients/router';
import { portalRouter } from './modules/portal/router';
import { waitingDisplayRouter, waitingRouter } from './modules/waiting/router';
import { referenceRouter } from './modules/reference/router';
import { categoriesRouter, medicationsRouter } from './modules/catalog/router';
import { visitReportRouter } from './modules/visits/router';
import { trashRouter } from './modules/trash/router';
import { usersRouter } from './modules/users/router';
import { loadPermissionOverrides, rolesRouter } from './modules/roles/router';

export function createApp(ctx: AppContext): Express {
  const { env, logger } = ctx;
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      quietReqLogger: true,
      autoLogging: env.NODE_ENV !== 'test',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    }),
  );
  app.use(helmet());
  // CORS_ORIGIN may list several origins, separated by commas.
  const origins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length === 1 ? origins[0] : origins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const api = express.Router();
  api.use(limiter(env, { windowMs: 60 * 1000, limit: 300 }));
  api.use(csrfProtection);
  // The saved timezone (Settings > General) is picked up once, on the first request after the server starts.
  let timezoneLoaded = false;
  api.use(async (_req, _res, next) => {
    if (!timezoneLoaded) {
      timezoneLoaded = true;
      try {
        await applyTimezone(ctx);
      } catch (err) {
        timezoneLoaded = false; // try again next time; the server's own timezone is used meanwhile
        ctx.logger.error({ err }, 'could not load the saved timezone');
      }
    }
    next();
  });
  // The admin's changes to what a role may do are loaded once too, and again whenever they are saved.
  let permissionsLoaded = false;
  api.use(async (_req, _res, next) => {
    if (!permissionsLoaded) {
      permissionsLoaded = true;
      try {
        await loadPermissionOverrides(ctx.db);
      } catch (err) {
        permissionsLoaded = false;
        ctx.logger.error({ err }, 'could not load the saved role permissions');
      }
    }
    next();
  });
  api.use(publicSettingsRouter(ctx));
  api.use('/auth', authRouter(ctx));
  api.use('/users', usersRouter(ctx));
  api.use('/roles', rolesRouter(ctx));
  api.use('/audit-log', auditRouter(ctx));
  api.use('/trash', trashRouter(ctx));
  api.use('/payments', paymentsRouter(ctx));
  api.use('/finance', summaryRouter(ctx));
  api.use('/finance', taxRouter(ctx));
  api.use('/settings', settingsRouter(ctx));
  api.use('/settings', appSettingsRouter(ctx));
  api.use('/settings', operatingSettingsRouter(ctx)); // after the others: its /:group takes whatever they left
  api.use('/commission', commissionRouter(ctx));
  api.use('/expenses', expensesRouter(ctx));
  api.use('/labs', directoryRouter(ctx, 'labs'));
  api.use('/suppliers', directoryRouter(ctx, 'suppliers'));
  api.use('/lab-orders', labOrdersRouter(ctx));
  api.use('/portal', portalRouter(ctx));
  api.use('/waiting-display', waitingDisplayRouter(ctx));
  api.use('/waiting-room', waitingRouter(ctx));
  api.use('/treatment-offers', offersRouter(ctx));
  api.use('/notifications', notificationsRouter(ctx));
  api.use('/reports', reportsRouter(ctx));
  api.use('/dashboard', dashboardRouter(ctx));
  // A patient's documents are mounted before the patients, which would not know their address.
  const documents = documentRouters(ctx);
  api.use('/patients/:id/documents', documents.forPatient);
  api.use('/documents', documents.byId);
  api.use('/patients', patientsRouter(ctx));
  api.use('/doctors', doctorsRouter(ctx));
  api.use('/clinics', clinicsRouter(ctx));
  api.use('/units', unitsRouter(ctx));
  // The visit report lives under an appointment, so it is mounted first.
  api.use('/appointments/:id/report', visitReportRouter(ctx));
  api.use('/appointments', appointmentsRouter(ctx));
  api.use('/medications', medicationsRouter(ctx));
  api.use('/categories', categoriesRouter(ctx));
  api.use('/', referenceRouter(ctx)); // /teeth, /categories, /config
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
