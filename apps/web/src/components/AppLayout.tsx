import { useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import SettingsIcon from '@mui/icons-material/Settings';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useGetMeQuery, useLogoutMutation } from '../features/auth/authApi';
import { AppBreadcrumbs } from './AppBreadcrumbs';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { BrandLogo } from './BrandLogo';
import { SideNav } from './SideNav';
import { LanguageSwitch } from '../i18n/LanguageSwitch';
import { BRAND } from '../theme';

const DRAWER_WIDTH = 240;
/** Where the gear in the header leads: the sections of the settings page (not the other pages under /settings/). */
const SETTINGS_PATHS = ['/settings/general', '/settings/appearance', '/settings/taxes'];

export function AppLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const desktop = useMediaQuery(theme.breakpoints.up('md'));
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { data: user } = useGetMeQuery();
  const [logout] = useLogoutMutation();
  const specialist = user?.role === 'doctor' && user.doctor?.kind === 'external';

  const nav = (
    <Box role="navigation" aria-label={t('Main')}>
      <Toolbar sx={{ minHeight: { xs: 64 }, mt: 0.5 }}>
        <BrandLogo size={30} onDark />
      </Toolbar>
      <SideNav role={user?.role} permissions={user?.permissions} specialist={!!specialist} pathname={pathname} onNavigate={() => setOpen(false)} />
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh' }}>
      <AppBar position="fixed" color="inherit" elevation={0} sx={{ ml: { md: `${DRAWER_WIDTH}px` }, width: { md: `calc(100% - ${DRAWER_WIDTH}px)` } }}>
        <Toolbar>
          {!desktop && (
            <IconButton edge="start" aria-label={t('Open menu')} onClick={() => setOpen(true)} sx={{ marginInlineEnd: 1 }}>
              <MenuIcon />
            </IconButton>
          )}
          {!desktop && <BrandLogo size={32} showName={false} />}
          <Box sx={{ flexGrow: 1 }} />
          {user && user.role !== 'patient' && <NotificationBell />}
          <LanguageSwitch />
          {user?.role === 'admin' && (
            <Tooltip title={t('Settings')}>
              <IconButton component={RouterLink} to="/settings" aria-label={t('Settings')} color={SETTINGS_PATHS.some((p) => pathname.startsWith(p)) ? 'primary' : 'inherit'}>
                <SettingsIcon />
              </IconButton>
            </Tooltip>
          )}
          <IconButton aria-label={t('Account menu')} onClick={(e) => setAnchor(e.currentTarget)}>
            <Avatar sx={{ width: 36, height: 36, background: BRAND.gradient, fontSize: 15, fontWeight: 700, boxShadow: '0 4px 12px rgba(11,122,117,0.35)' }}>
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </Avatar>
          </IconButton>
          <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
            <Box sx={{ px: 2, py: 1 }}>
              <Typography variant="subtitle2">{user?.name}</Typography>
              <Typography variant="caption" color="text.secondary" dir="ltr" display="block">
                {user?.email}
              </Typography>
            </Box>
            <Divider />
            <MenuItem
              onClick={() => {
                setAnchor(null);
                navigate('/change-password');
              }}
            >
              {t('Change password')}
            </MenuItem>
            <MenuItem
              onClick={async () => {
                setAnchor(null);
                await logout();
                navigate('/login', { replace: true });
              }}
            >
              {t('Sign out')}
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Drawer
        variant={desktop ? 'permanent' : 'temporary'}
        open={desktop || open}
        onClose={() => setOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{ width: { md: DRAWER_WIDTH }, flexShrink: 0, '& .MuiDrawer-paper': { width: DRAWER_WIDTH, background: BRAND.gradientDeep, color: '#fff', border: 0 } }}
      >
        {nav}
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, md: 3 }, maxWidth: 1400 }}>
        <Toolbar />
        <AppBreadcrumbs />
        <Outlet />
      </Box>
    </Box>
  );
}
