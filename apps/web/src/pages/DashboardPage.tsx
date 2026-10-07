import { Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Button, Chip, Paper, Skeleton, Stack, Typography } from '@mui/material';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import PeopleIcon from '@mui/icons-material/People';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { StatusChip } from '../components/StatusChip';
import { useRole } from '../components/useRole';
import { useAppointmentDialogs } from '../features/appointments/AppointmentDialogs';
import { useGetMeQuery } from '../features/auth/authApi';
import { useGetConfigQuery, useListAppointmentsQuery } from '../features/clinical/clinicalApi';
import { errorMessage } from '../lib/baseQuery';
import { STATUS_HEX, formatDate, fullName } from '../lib/format';
import { BRAND } from '../theme';
import { PortalHome } from '../features/portal/PortalHome';
import { useTimeFormat } from '../lib/useTime';

// The charts load on demand so the dashboard opens fast.
const InsightsSection = lazy(() => import('../features/dashboard/InsightsSection'));

function StatTile({ icon, label, value, color }: { icon: ReactNode; label: string; value: number | null; color: string }) {
  return (
    <Paper sx={{ p: 2.5, display: 'flex', alignItems: 'center', gap: 2, flex: '1 1 200px' }}>
      <Box sx={{ width: 48, height: 48, borderRadius: 1, display: 'grid', placeItems: 'center', color: '#fff', background: color, boxShadow: `0 8px 18px ${color}55` }}>
        {icon}
      </Box>
      <Box>
        <Typography variant="h5" component="p" sx={{ lineHeight: 1.1 }}>{value ?? '–'}</Typography>
        <Typography variant="body2" color="text.secondary">{label}</Typography>
      </Box>
    </Paper>
  );
}

function Today() {
  const fmtTime = useTimeFormat();
  const { t } = useTranslation();
  const { data: config } = useGetConfigQuery();
  const today = config?.today;
  const { data, isLoading, error } = useListAppointmentsQuery(
    today ? { from: today, to: today, status: 'pending,confirmed,completed', pageSize: 100 } : undefined,
    { skip: !today },
  );
  const { dialogs, openDetail } = useAppointmentDialogs();
  const list = data?.data;
  const count = (...s: string[]) => (list ? list.filter((a) => s.includes(a.status)).length : null);

  return (
    <>
      <Stack direction="row" gap={2} flexWrap="wrap" sx={{ mb: 4 }}>
        <StatTile icon={<EventAvailableIcon />} label={t('Booked today')} value={list ? list.length : null} color={BRAND.teal} />
        <StatTile icon={<HourglassTopIcon />} label={t('Awaiting confirmation')} value={count('pending')} color="#ed6c02" />
        <StatTile icon={<TaskAltIcon />} label={t('Done so far')} value={count('completed')} color="#2e7d32" />
      </Stack>

      <Typography variant="h6" component="h2" gutterBottom>
        {t('Today')}{today ? ` · ${formatDate(today)}` : ''}
      </Typography>
      {error && <Alert severity="error">{errorMessage(error)}</Alert>}
      {isLoading || !today ? (
        <Skeleton variant="rounded" height={72} />
      ) : list?.length ? (
        <Stack spacing={1.5}>
          {list.map((a) => (
            <Paper
              key={a.id} component="button" type="button" onClick={() => openDetail(a.id)}
              sx={{
                display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', width: '100%', textAlign: 'start', border: 0, font: 'inherit', color: 'inherit',
                cursor: 'pointer', p: 2, minHeight: 64, borderInlineStart: `6px solid ${STATUS_HEX[a.status]}`,
                transition: 'transform .15s, box-shadow .15s', '&:hover, &:focus-visible': { transform: 'translateY(-2px)', boxShadow: '0 12px 30px rgba(10,61,77,0.16)' },
              }}
            >
              <Typography fontWeight={800} sx={{ minWidth: 110, color: 'primary.dark' }} dir="ltr">{fmtTime(a.time)}–{fmtTime(a.endTime)}</Typography>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography fontWeight={600}>{fullName(a.patient)}</Typography>
                <Typography variant="body2" color="text.secondary">{t('Dr {{name}}', { name: fullName(a.doctor) })}</Typography>
              </Box>
              <StatusChip status={a.status} />
            </Paper>
          ))}
        </Stack>
      ) : (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">{t('No appointments today.')}</Typography>
        </Paper>
      )}
      {dialogs}
    </>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { data: user } = useGetMeQuery();
  const { unlinkedDoctor } = useRole();
  const staff = user && user.role !== 'patient';
  // Admins and doctors are the clinic's doctors: greet them as "Dr." (unless the name already says so).
  const greetingName = user && (user.role === 'doctor' || user.role === 'admin') && !/^dr[.\s]/i.test(user.name) ? t('Dr. {{name}}', { name: user.name }) : (user?.name ?? '');

  return (
    <>
      <Box
        sx={{
          position: 'relative', overflow: 'hidden', color: '#fff', borderRadius: 1, p: { xs: 3, md: 4 }, mb: 3.5, background: BRAND.gradient,
          boxShadow: '0 18px 44px rgba(11,122,117,0.30)',
          '&::after': { content: '""', position: 'absolute', width: 340, height: 340, borderRadius: '50%', insetInlineEnd: -90, top: -140, background: 'radial-gradient(circle, rgba(255,255,255,0.28), transparent 65%)' },
        }}
      >
        <Box sx={{ position: 'relative', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="h4" component="h1" sx={{ fontSize: { xs: '1.6rem', sm: '1.9rem' } }}>
              {t('Welcome, {{name}}', { name: greetingName })}
            </Typography>
            {user && <Chip label={t(user.role)} size="small" sx={{ mt: 1, color: '#fff', bgcolor: 'rgba(255,255,255,0.22)', textTransform: 'capitalize' }} />}
          </Box>
          {staff && (
            <Stack direction="row" gap={1} flexWrap="wrap">
              <Button component={RouterLink} to="/appointments" variant="contained" startIcon={<CalendarMonthIcon />}
                sx={{ background: '#fff', color: 'primary.dark', boxShadow: 'none', '&:hover': { background: '#fff', filter: 'brightness(0.95)' } }}>
                {t('Appointments')}
              </Button>
              <Button component={RouterLink} to="/patients" variant="outlined" startIcon={<PeopleIcon />}
                sx={{ color: '#fff', borderColor: 'rgba(255,255,255,0.7)', '&:hover': { borderColor: '#fff', bgcolor: 'rgba(255,255,255,0.12)' } }}>
                {t('Patients')}
              </Button>
            </Stack>
          )}
        </Box>
      </Box>

      {unlinkedDoctor && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {t("Your login is not linked to a doctor profile yet, so you can't see patients or appointments. Ask an admin to link it.")}
        </Alert>
      )}
      {staff ? (
        <>
          <Today />
          {!unlinkedDoctor && <Suspense fallback={null}><InsightsSection /></Suspense>}
        </>
      ) : (
        <PortalHome />
      )}
    </>
  );
}
