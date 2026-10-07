import { Breadcrumbs, Link, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import HomeRoundedIcon from '@mui/icons-material/HomeRounded';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom';
import { useGetPatientQuery } from '../features/clinical/clinicalApi';
import { useGetOfferQuery } from '../features/offers/offersApi';
import { fullName } from '../lib/format';

/** Section pages, by path. The label is the English text of the menu item. */
const SECTIONS: Record<string, string> = {
  '/appointments': 'Appointments',
  '/waiting-room': 'Waiting room',
  '/patients': 'Patients',
  '/treatment-offers': 'Treatment offers',
  '/lab-orders': 'Lab orders',
  '/reports': 'Reports',
  '/labs': 'Labs',
  '/suppliers': 'Suppliers',
  '/summary': 'Summary',
  '/income-tax': 'Income tax',
  '/by-doctor': 'By doctor',
  '/payments': 'Payments',
  '/expenses': 'Expenses',
  '/commission': 'Commission',
  '/medications': 'Medications',
  '/settings/doctors': 'Doctors',
  '/settings/clinics': 'Clinics',
  '/settings/deleted-clinics': 'Deleted clinics’ data',
  '/settings/users': 'Users',
  '/settings/roles': 'Roles',
  '/settings/audit': 'Activity log',
  '/settings/trash': 'Trash',
  '/settings/procedures': 'Procedures',
  '/my/appointments': 'My appointments',
  '/my/treatment': 'My treatment',
  '/my/payments': 'My payments',
  '/my/documents': 'My documents',
  '/my/profile': 'My profile',
};

/** Lists that the patient page opens filtered to one patient (`?patientId=`): their trail runs through the patient. */
const PATIENT_LISTS = ['/payments', '/treatment-offers', '/lab-orders'];

/** The sections of the settings page, by path. */
const SETTINGS_SECTION_LABEL: Record<string, string> = { '/settings/general': 'General', '/settings/appearance': 'Appearance', '/settings/taxes': 'Taxes', '/settings/waiting-room': 'Waiting room', '/settings/display': 'Date and time', '/settings/appointments': 'Appointments', '/settings/portal': 'Patient portal', '/settings/security': 'Security', '/settings/uploads': 'Uploads', '/settings/trash-and-log': 'Trash and activity log' };

/**
 * Where you are, with a link back to each level: Dashboard > Section > (a patient's name).
 * Hidden on the dashboard itself, which has nothing above it.
 */
export function AppBreadcrumbs() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const patientMatch = /^\/patients\/(\d+)(?:\/(appointments|documents))?\/?$/.exec(pathname);
  const [search] = useSearchParams();
  const section = pathname.replace(/\/$/, '');
  // a patient's own pages, or a list filtered to the patient it was opened from
  const filteredId = PATIENT_LISTS.includes(section) ? Number(search.get('patientId')) || undefined : undefined;
  const patientId = patientMatch?.[1] ?? (filteredId ? String(filteredId) : undefined);
  const patientPage = patientMatch?.[2];
  const settingsSection = SETTINGS_SECTION_LABEL[pathname.replace(/\/$/, '')];
  const offerId = /^\/treatment-offers\/(\d+)\/?$/.exec(pathname)?.[1];
  const { data: offer } = useGetOfferQuery(Number(offerId), { skip: !offerId });
  const { data: patient } = useGetPatientQuery(Number(patientId), { skip: !patientId });

  const trail: { label: string; to?: string }[] = [];
  if (patientId) {
    const name = patient ? fullName(patient) : t('Patient');
    const deeper = patientPage || filteredId;
    trail.push({ label: t('Patients'), to: '/patients' }, deeper ? { label: name, to: `/patients/${patientId}` } : { label: name });
    if (patientPage) trail.push({ label: patientPage === 'documents' ? t('Documents') : t('Appointments and reports') });
    else if (filteredId) trail.push({ label: t(SECTIONS[section]!) });
  } else if (settingsSection) {
    trail.push({ label: t('Settings'), to: '/settings' }, { label: t(settingsSection) });
  } else if (offerId) {
    trail.push({ label: t('Treatment offers'), to: '/treatment-offers' }, { label: offer ? offer.title : t('Treatment offer') });
  } else {
    const label = SECTIONS[section];
    if (label) trail.push({ label: t(label) });
  }
  if (!trail.length) return null;

  return (
    <Breadcrumbs
      aria-label={t('Breadcrumb')}
      separator={<ChevronRightIcon fontSize="small" sx={{ '[dir=rtl] &': { transform: 'scaleX(-1)' } }} />}
      sx={{ mb: 2, '& .MuiBreadcrumbs-ol': { rowGap: 0.5 } }}
    >
      <Link component={RouterLink} to="/" underline="hover" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontWeight: 600, minHeight: 32 }}>
        <HomeRoundedIcon fontSize="small" />
        {t('Dashboard')}
      </Link>
      {trail.map((crumb) =>
        crumb.to ? (
          <Link key={crumb.label} component={RouterLink} to={crumb.to} underline="hover" color="text.secondary" sx={{ fontWeight: 600, minHeight: 32, display: 'inline-flex', alignItems: 'center' }}>
            {crumb.label}
          </Link>
        ) : (
          <Typography key={crumb.label} aria-current="page" color="primary.dark" sx={{ fontWeight: 700 }}>
            {crumb.label}
          </Typography>
        ),
      )}
    </Breadcrumbs>
  );
}
