import type { ReactNode } from 'react';
import { Box, List, ListItemButton, ListItemIcon, ListItemText, Paper, Typography } from '@mui/material';
import CalculateIcon from '@mui/icons-material/Calculate';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import EventIcon from '@mui/icons-material/Event';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import ScheduleIcon from '@mui/icons-material/Schedule';
import PaletteIcon from '@mui/icons-material/Palette';
import TuneIcon from '@mui/icons-material/Tune';
import TvIcon from '@mui/icons-material/Tv';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';

/** The sections of the settings page. A new one is a new entry here and a new route in `App.tsx`. */
export const SETTINGS_SECTIONS: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/settings/general', label: 'General', icon: <TuneIcon /> },
  { to: '/settings/appearance', label: 'Appearance', icon: <PaletteIcon /> },
  { to: '/settings/display', label: 'Date and time', icon: <ScheduleIcon /> },
  { to: '/settings/appointments', label: 'Appointments', icon: <EventIcon /> },
  { to: '/settings/waiting-room', label: 'Waiting room', icon: <TvIcon /> },
  { to: '/settings/portal', label: 'Patient portal', icon: <FavoriteBorderIcon /> },
  { to: '/settings/security', label: 'Security', icon: <LockOutlinedIcon /> },
  { to: '/settings/uploads', label: 'Uploads', icon: <CloudUploadIcon /> },
  { to: '/settings/trash-and-log', label: 'Trash and activity log', icon: <DeleteSweepIcon /> },
  { to: '/settings/taxes', label: 'Taxes', icon: <CalculateIcon /> },
];

/** The page of a section nobody has put anything in yet. */
export function EmptySection({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <Paper component="section" aria-label={title} sx={{ p: 3, maxWidth: 860 }}>
      <Typography variant="h6" component="h2">{title}</Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5 }}>{t('There is nothing to set here yet. Settings added later will appear on this page.')}</Typography>
    </Paper>
  );
}

/**
 * Settings: a vertical list of sections on the side (a row you can scroll on a phone) and the chosen
 * section beside it. Admin only.
 */
export function SettingsLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <>
      <PageHeader title={t('Settings')} subtitle={t('Values the clinic’s calculations use. Only an admin can change them.')} />
      <Box sx={{ display: 'flex', gap: 3, flexDirection: { xs: 'column', md: 'row' }, alignItems: { md: 'flex-start' } }}>
        <Paper component="nav" aria-label={t('Settings sections')} sx={{ p: 1, flexShrink: 0, width: { xs: '100%', md: 220 }, overflowX: 'auto' }}>
          <List disablePadding sx={{ display: 'flex', flexDirection: { xs: 'row', md: 'column' }, gap: 0.5 }}>
            {SETTINGS_SECTIONS.map((s) => (
              <ListItemButton
                key={s.to} component={RouterLink} to={s.to} selected={pathname === s.to}
                aria-current={pathname === s.to ? 'page' : undefined}
                sx={{ borderRadius: 1, minHeight: 44, flexShrink: 0, '&.Mui-selected': { bgcolor: 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' } } }}
              >
                <ListItemIcon sx={{ minWidth: 36, color: 'inherit' }}>{s.icon}</ListItemIcon>
                <ListItemText primary={t(s.label)} slotProps={{ primary: { fontWeight: 600, noWrap: true } }} />
              </ListItemButton>
            ))}
          </List>
        </Paper>
        <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
          <Outlet />
        </Box>
      </Box>
    </>
  );
}
