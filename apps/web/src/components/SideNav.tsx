import { useEffect, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import AssessmentIcon from '@mui/icons-material/Assessment';
import EventNoteIcon from '@mui/icons-material/EventNote';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import FolderIcon from '@mui/icons-material/Folder';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import AssignmentIcon from '@mui/icons-material/Assignment';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import BadgeIcon from '@mui/icons-material/Badge';
import BusinessIcon from '@mui/icons-material/Business';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOffIcon from '@mui/icons-material/FolderOff';
import GroupsIcon from '@mui/icons-material/Groups';
import HandshakeIcon from '@mui/icons-material/Handshake';
import HealthAndSafetyIcon from '@mui/icons-material/HealthAndSafety';
import HistoryIcon from '@mui/icons-material/History';
import InsightsIcon from '@mui/icons-material/Insights';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import ListAltIcon from '@mui/icons-material/ListAlt';
import LockPersonIcon from '@mui/icons-material/LockPerson';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import MedicationIcon from '@mui/icons-material/Medication';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import PaymentsIcon from '@mui/icons-material/Payments';
import PeopleIcon from '@mui/icons-material/People';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import SavingsIcon from '@mui/icons-material/Savings';
import CalculateIcon from '@mui/icons-material/Calculate';
import ScienceIcon from '@mui/icons-material/Science';
import BiotechIcon from '@mui/icons-material/Biotech';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import type { Role } from '@aya/shared';

const STAFF: Role[] = ['admin', 'doctor', 'staff'];

/** `can`: the page is shown only if the person holds at least one of these permissions (when the server has told us theirs). */
interface Item { to: string; label: string; icon: ReactNode; roles?: Role[]; notForSpecialists?: boolean; can?: string[] }
interface Group { id: string; label: string; icon: ReactNode; accent: string; items: Item[] }

/** Related pages together. A group with nothing the person may open is not shown at all. */
const GROUPS: Group[] = [
  {
    // A patient's own pages (the patient portal): view only.
    id: 'my', label: 'My care', icon: <FavoriteBorderIcon fontSize="small" />, accent: '#40bfb9',
    items: [
      { to: '/my/appointments', label: 'My appointments', icon: <EventNoteIcon />, roles: ['patient'] },
      { to: '/my/treatment', label: 'My treatment', icon: <AssignmentIcon />, roles: ['patient'] },
      { to: '/my/payments', label: 'My payments', icon: <PaymentsIcon />, roles: ['patient'] },
      { to: '/my/documents', label: 'My documents', icon: <FolderIcon />, roles: ['patient'] },
      { to: '/my/profile', label: 'My profile', icon: <PersonOutlineIcon />, roles: ['patient'] },
    ],
  },
  {
    id: 'clinic', label: 'Clinic', icon: <HealthAndSafetyIcon fontSize="small" />, accent: '#40bfb9',
    items: [
      { to: '/appointments', label: 'Appointments', icon: <CalendarMonthIcon />, roles: STAFF, can: ['appointments:read'] },
      { to: '/patients', label: 'Patients', icon: <PeopleIcon />, roles: STAFF, can: ['patients:read'] },
      { to: '/treatment-offers', label: 'Treatment offers', icon: <AssignmentIcon />, roles: STAFF, can: ['offers:read'] },
      { to: '/lab-orders', label: 'Lab orders', icon: <ScienceIcon />, roles: STAFF, can: ['labs:read'] },
      { to: '/reports', label: 'Reports', icon: <AssessmentIcon />, roles: STAFF, can: ['reports:read'] },
      // External specialists don't manage the clinic's doctors.
      { to: '/settings/doctors', label: 'Doctors', icon: <BadgeIcon />, roles: ['admin', 'doctor'], notForSpecialists: true, can: ['doctors:read'] },
      { to: '/settings/clinics', label: 'Clinics', icon: <BusinessIcon />, roles: ['admin'], can: ['clinics:read'] },
    ],
  },
  {
    id: 'finance', label: 'Finance', icon: <SavingsIcon fontSize="small" />, accent: '#f5b94a',
    items: [
      { to: '/summary', label: 'Summary', icon: <InsightsIcon />, roles: ['admin'] },
      { to: '/income-tax', label: 'Income tax', icon: <CalculateIcon />, roles: ['admin'] },
      { to: '/by-doctor', label: 'By doctor', icon: <GroupsIcon />, roles: ['admin', 'doctor'] },
      { to: '/payments', label: 'Payments', icon: <PaymentsIcon />, roles: STAFF, can: ['payments:read', 'payments:create'] },
      { to: '/expenses', label: 'Expenses', icon: <ReceiptLongIcon />, roles: ['admin', 'staff'], can: ['expenses:read'] },
      { to: '/commission', label: 'Commission', icon: <HandshakeIcon />, roles: ['admin', 'doctor'], can: ['payments:read'] },
    ],
  },
  {
    id: 'catalog', label: 'Catalog', icon: <MenuBookIcon fontSize="small" />, accent: '#7fb6ff',
    items: [
      { to: '/medications', label: 'Medications', icon: <MedicationIcon />, roles: ['admin', 'doctor'], can: ['medications:read'] },
      { to: '/settings/procedures', label: 'Procedures', icon: <ListAltIcon />, roles: ['admin'], can: ['categories:read'] },
      { to: '/labs', label: 'Labs', icon: <BiotechIcon />, roles: ['admin', 'staff'], can: ['labs:read'] },
      { to: '/suppliers', label: 'Suppliers', icon: <LocalShippingIcon />, roles: ['admin', 'staff'], can: ['suppliers:read'] },
    ],
  },
  {
    id: 'admin', label: 'Administration', icon: <AdminPanelSettingsIcon fontSize="small" />, accent: '#c79bff',
    items: [
      { to: '/settings/deleted-clinics', label: 'Deleted clinics’ data', icon: <FolderOffIcon />, roles: ['admin'] },
      { to: '/settings/users', label: 'Users', icon: <ManageAccountsIcon />, roles: ['admin'] },
      { to: '/settings/roles', label: 'Roles', icon: <LockPersonIcon />, roles: ['admin'] },
      { to: '/settings/trash', label: 'Trash', icon: <DeleteSweepIcon />, roles: ['admin'] },
      { to: '/settings/audit', label: 'Activity log', icon: <HistoryIcon />, roles: ['admin'] },
    ],
  },
];

const STORAGE_KEY = 'aya.nav.collapsed';

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return []; // storage can be blocked or hold something else; start with everything open
  }
}

const EXACT = ['/'];
const isActive = (to: string, pathname: string) => (EXACT.includes(to) ? pathname === to : pathname === to || pathname.startsWith(`${to}/`));

const itemSx = {
  minHeight: 38, color: 'rgba(255,255,255,0.78)', borderRadius: 2.5, my: 0.25, transition: 'background .15s, color .15s',
  '&:hover': { bgcolor: 'rgba(255,255,255,0.10)', color: '#fff' },
  '&.Mui-selected': { bgcolor: 'rgba(255,255,255,0.18)', color: '#fff', boxShadow: 'inset 3px 0 0 #40bfb9', '[dir=rtl] &': { boxShadow: 'inset -3px 0 0 #40bfb9' } },
  '&.Mui-selected:hover': { bgcolor: 'rgba(255,255,255,0.24)' },
  '& .MuiListItemText-primary': { fontWeight: 600, fontSize: '0.92rem' },
  '& .MuiListItemIcon-root': { minWidth: 36 },
} as const;

/**
 * The side menu: the dashboard on its own, then groups of related pages. Each group has a coloured
 * header that folds it away (remembered in this browser); the group of the page you are on opens by itself.
 */
export function SideNav({ role, permissions, specialist, pathname, onNavigate }: { role: Role | undefined; permissions?: string[]; specialist: boolean; pathname: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);

  const visible = GROUPS.map((g) => ({
    ...g, items: g.items.filter((i) => (!i.roles || (role && i.roles.includes(role))) && !(i.notForSpecialists && specialist) && (!i.can || !permissions || i.can.some((p) => permissions.includes(p)))),
  })).filter((g) => g.items.length > 0);

  // Going to a page inside a folded group opens that group.
  const current = visible.find((g) => g.items.some((i) => isActive(i.to, pathname)))?.id;
  useEffect(() => {
    if (current) setCollapsed((c) => (c.includes(current) ? c.filter((x) => x !== current) : c));
  }, [current]);

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // not remembering the choice is fine
      }
      return next;
    });

  return (
    <List sx={{ pt: 1, px: 1.5 }}>
      <ListItemButton component={RouterLink} to="/" selected={isActive('/', pathname)} onClick={onNavigate} sx={itemSx}>
        <ListItemIcon sx={{ color: 'inherit' }}><DashboardIcon /></ListItemIcon>
        <ListItemText primary={t('Dashboard')} />
      </ListItemButton>

      {visible.map((g) => {
        const open = !collapsed.includes(g.id);
        const hasCurrent = g.id === current;
        return (
          <Box key={g.id} sx={{ mt: 1.5 }}>
            <ListItemButton
              onClick={() => toggle(g.id)} aria-expanded={open} aria-controls={`nav-${g.id}`}
              sx={{ minHeight: 34, px: 1, borderRadius: 2, color: 'rgba(255,255,255,0.72)', '&:hover': { bgcolor: 'rgba(255,255,255,0.07)', color: '#fff' } }}
            >
              <Box sx={{ width: 24, height: 24, borderRadius: 1.5, display: 'grid', placeItems: 'center', color: '#10242b', bgcolor: g.accent, flexShrink: 0, marginInlineEnd: 1.5, opacity: open || hasCurrent ? 1 : 0.7 }}>
                {g.icon}
              </Box>
              <Typography component="span" sx={{ flexGrow: 1, fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase' }}>
                {t(g.label)}
              </Typography>
              <ExpandMoreIcon fontSize="small" sx={{ transition: 'transform .2s', transform: open ? 'none' : 'rotate(-90deg)', '[dir=rtl] &': { transform: open ? 'none' : 'rotate(90deg)' } }} />
            </ListItemButton>
            <Collapse in={open} timeout="auto">
              <List
                id={`nav-${g.id}`} component="div" disablePadding aria-label={t(g.label)}
                sx={{ marginInlineStart: 2, paddingInlineStart: 1, mt: 0.25, borderInlineStart: `2px solid ${g.accent}55` }}
              >
                {g.items.map((item) => (
                  <ListItemButton key={item.to} component={RouterLink} to={item.to} selected={isActive(item.to, pathname)} onClick={onNavigate} sx={itemSx}>
                    <ListItemIcon sx={{ color: 'inherit' }}>{item.icon}</ListItemIcon>
                    <ListItemText primary={t(item.label)} />
                  </ListItemButton>
                ))}
              </List>
            </Collapse>
          </Box>
        );
      })}
    </List>
  );
}
