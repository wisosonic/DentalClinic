import { Suspense, lazy } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Toaster } from './features/toast/Toaster';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { DashboardPage } from './pages/DashboardPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LoginPage } from './pages/LoginPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';

// Each area loads on demand, so signing in stays fast.
const PatientsPage = lazy(() => import('./features/patients/PatientsPage').then((m) => ({ default: m.PatientsPage })));
const PatientDocumentsPage = lazy(() => import('./features/patients/PatientSubPages').then((m) => ({ default: m.PatientDocumentsPage })));
const PatientAppointmentsPage = lazy(() => import('./features/patients/PatientSubPages').then((m) => ({ default: m.PatientAppointmentsPage })));
const PatientDetailPage = lazy(() => import('./features/patients/PatientDetailPage').then((m) => ({ default: m.PatientDetailPage })));
const AppointmentsPage = lazy(() => import('./features/appointments/AppointmentsPage').then((m) => ({ default: m.AppointmentsPage })));
const MedicationsPage = lazy(() => import('./features/catalog/MedicationsPage').then((m) => ({ default: m.MedicationsPage })));
const ProceduresPage = lazy(() => import('./features/catalog/ProceduresPage').then((m) => ({ default: m.ProceduresPage })));
const DoctorsPage = lazy(() => import('./features/clinic/ClinicSettingsPage').then((m) => ({ default: m.DoctorsPage })));
const RolesPage = lazy(() => import('./features/roles/RolesPage').then((m) => ({ default: m.RolesPage })));
const UsersPage = lazy(() => import('./features/users/UsersPage').then((m) => ({ default: m.UsersPage })));
const AuditPage = lazy(() => import('./features/audit/AuditPage').then((m) => ({ default: m.AuditPage })));
const TrashPage = lazy(() => import('./features/trash/TrashPage').then((m) => ({ default: m.TrashPage })));
const PaymentsPage = lazy(() => import('./features/finance/PaymentsPage').then((m) => ({ default: m.PaymentsPage })));
const ExpensesPage = lazy(() => import('./features/finance/ExpensesPage').then((m) => ({ default: m.ExpensesPage })));
const CommissionPage = lazy(() => import('./features/finance/CommissionPage').then((m) => ({ default: m.CommissionPage })));
const SummaryPage = lazy(() => import('./features/finance/SummaryPage').then((m) => ({ default: m.SummaryPage })));
const DoctorFiguresPage = lazy(() => import('./features/finance/DoctorFiguresPage').then((m) => ({ default: m.DoctorFiguresPage })));
const OffersPage = lazy(() => import('./features/offers/OffersPage').then((m) => ({ default: m.OffersPage })));
const OfferDetailPage = lazy(() => import('./features/offers/OfferDetailPage').then((m) => ({ default: m.OfferDetailPage })));
const LabOrdersPage = lazy(() => import('./features/labs/LabOrdersPage').then((m) => ({ default: m.LabOrdersPage })));
const LabsPage = lazy(() => import('./features/labs/DirectoryPage').then((m) => ({ default: m.LabsPage })));
const SuppliersPage = lazy(() => import('./features/labs/DirectoryPage').then((m) => ({ default: m.SuppliersPage })));
const IncomeTaxPage = lazy(() => import('./features/tax/IncomeTaxPage').then((m) => ({ default: m.IncomeTaxPage })));
const SettingsLayout = lazy(() => import('./features/settings/SettingsLayout').then((m) => ({ default: m.SettingsLayout })));
const GeneralSection = lazy(() => import('./features/settings/Sections').then((m) => ({ default: m.GeneralSection })));
const AppearanceSection = lazy(() => import('./features/settings/Sections').then((m) => ({ default: m.AppearanceSection })));
const TaxesSection = lazy(() => import('./features/tax/SettingsPage').then((m) => ({ default: m.TaxesSection })));
const ReportsPage = lazy(() => import('./features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const DeletedClinicsPage = lazy(() => import('./features/clinic/DeletedClinicsPage').then((m) => ({ default: m.DeletedClinicsPage })));
const PortalAppointmentsPage = lazy(() => import('./features/portal/PortalPages').then((m) => ({ default: m.PortalAppointmentsPage })));
const PortalTreatmentPage = lazy(() => import('./features/portal/PortalPages').then((m) => ({ default: m.PortalTreatmentPage })));
const PortalPaymentsPage = lazy(() => import('./features/portal/PortalPages').then((m) => ({ default: m.PortalPaymentsPage })));
const PortalDocumentsPage = lazy(() => import('./features/portal/PortalPages').then((m) => ({ default: m.PortalDocumentsPage })));
const PortalProfilePage = lazy(() => import('./features/portal/PortalPages').then((m) => ({ default: m.PortalProfilePage })));
const ClinicsPage = lazy(() => import('./features/clinic/ClinicSettingsPage').then((m) => ({ default: m.ClinicsPage })));

function Fallback() {
  const { t } = useTranslation();
  return (
    <Box role="status" aria-label={t('Loading')} sx={{ p: 4, display: 'grid', placeItems: 'center' }}>
      <CircularProgress />
    </Box>
  );
}
const fallback = <Fallback />;

export function App() {
  return (
    <>
      <Toaster />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />

        <Route element={<ProtectedRoute />}>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />

            <Route element={<ProtectedRoute roles={['patient']} />}>
              <Route path="/my/appointments" element={<Suspense fallback={fallback}><PortalAppointmentsPage /></Suspense>} />
              <Route path="/my/treatment" element={<Suspense fallback={fallback}><PortalTreatmentPage /></Suspense>} />
              <Route path="/my/payments" element={<Suspense fallback={fallback}><PortalPaymentsPage /></Suspense>} />
              <Route path="/my/documents" element={<Suspense fallback={fallback}><PortalDocumentsPage /></Suspense>} />
              <Route path="/my/profile" element={<Suspense fallback={fallback}><PortalProfilePage /></Suspense>} />
            </Route>

            <Route element={<ProtectedRoute roles={['admin', 'doctor', 'staff']} />}>
              <Route path="/patients" element={<Suspense fallback={fallback}><PatientsPage /></Suspense>} />
              <Route path="/patients/:id" element={<Suspense fallback={fallback}><PatientDetailPage /></Suspense>} />
              <Route path="/patients/:id/appointments" element={<Suspense fallback={fallback}><PatientAppointmentsPage /></Suspense>} />
              <Route path="/patients/:id/documents" element={<Suspense fallback={fallback}><PatientDocumentsPage /></Suspense>} />
              <Route path="/payments" element={<Suspense fallback={fallback}><PaymentsPage /></Suspense>} />
            <Route path="/appointments" element={<Suspense fallback={fallback}><AppointmentsPage /></Suspense>} />
              <Route path="/treatment-offers" element={<Suspense fallback={fallback}><OffersPage /></Suspense>} />
              <Route path="/treatment-offers/:id" element={<Suspense fallback={fallback}><OfferDetailPage /></Suspense>} />
              <Route path="/treatment-plans/*" element={<Navigate to="/treatment-offers" replace />} />
              <Route path="/quotes" element={<Navigate to="/treatment-offers" replace />} />
              <Route path="/lab-orders" element={<Suspense fallback={fallback}><LabOrdersPage /></Suspense>} />
              <Route path="/reports" element={<Suspense fallback={fallback}><ReportsPage /></Suspense>} />
            </Route>

            <Route element={<ProtectedRoute roles={['admin', 'staff']} />}>
            <Route path="/expenses" element={<Suspense fallback={fallback}><ExpensesPage /></Suspense>} />
            <Route path="/labs" element={<Suspense fallback={fallback}><LabsPage /></Suspense>} />
            <Route path="/suppliers" element={<Suspense fallback={fallback}><SuppliersPage /></Suspense>} />
          </Route>

          <Route element={<ProtectedRoute roles={['admin', 'doctor']} />}>
            <Route path="/by-doctor" element={<Suspense fallback={fallback}><DoctorFiguresPage /></Suspense>} />
            <Route path="/commission" element={<Suspense fallback={fallback}><CommissionPage /></Suspense>} />
            <Route path="/medications" element={<Suspense fallback={fallback}><MedicationsPage /></Suspense>} />
              <Route path="/settings/doctors" element={<Suspense fallback={fallback}><DoctorsPage /></Suspense>} />
              <Route path="/settings/clinic" element={<Navigate to="/settings/doctors" replace />} />
            </Route>

            <Route element={<ProtectedRoute roles={['admin']} />}>
              <Route path="/summary" element={<Suspense fallback={fallback}><SummaryPage /></Suspense>} />
              <Route path="/income-tax" element={<Suspense fallback={fallback}><IncomeTaxPage /></Suspense>} />
              <Route path="/settings" element={<Suspense fallback={fallback}><SettingsLayout /></Suspense>}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="general" element={<Suspense fallback={fallback}><GeneralSection /></Suspense>} />
                <Route path="appearance" element={<Suspense fallback={fallback}><AppearanceSection /></Suspense>} />
                <Route path="taxes" element={<Suspense fallback={fallback}><TaxesSection /></Suspense>} />
              </Route>
            <Route path="/settings/clinics" element={<Suspense fallback={fallback}><ClinicsPage /></Suspense>} />
            <Route path="/settings/deleted-clinics" element={<Suspense fallback={fallback}><DeletedClinicsPage /></Suspense>} />
              <Route path="/settings/trash" element={<Suspense fallback={fallback}><TrashPage /></Suspense>} />
              <Route path="/settings/audit" element={<Suspense fallback={fallback}><AuditPage /></Suspense>} />
              <Route path="/settings/roles" element={<Suspense fallback={fallback}><RolesPage /></Suspense>} />
              <Route path="/settings/users" element={<Suspense fallback={fallback}><UsersPage /></Suspense>} />
              <Route path="/settings/procedures" element={<Suspense fallback={fallback}><ProceduresPage /></Suspense>} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
    </>
  );
}
