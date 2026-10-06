import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '@aya/shared';
import { useAppSelector } from '../app/store';
import { useGetMeQuery } from '../features/auth/authApi';

/**
 * Gate for signed-in pages. Redirects to /login when there is no session, and to
 * /change-password while the account is flagged for a forced change.
 * (The server enforces both too; this only avoids showing screens that would fail.)
 */
export function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { t } = useTranslation();
  const location = useLocation();
  const expired = useAppSelector((s) => s.auth.expired);
  const { data: user, isLoading, isError } = useGetMeQuery();

  if (isLoading) {
    return (
      <Box role="status" aria-label={t('Loading')} sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }
  if (isError || expired || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <Outlet />;
}
