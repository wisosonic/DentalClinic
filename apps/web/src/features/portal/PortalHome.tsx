import { Box, Button, LinearProgress, Paper, Skeleton, Stack, Typography } from '@mui/material';
import EventNoteIcon from '@mui/icons-material/EventNote';
import FolderIcon from '@mui/icons-material/Folder';
import PaymentsIcon from '@mui/icons-material/Payments';
import AssignmentIcon from '@mui/icons-material/Assignment';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { errorMessage } from '../../lib/baseQuery';
import { formatMoney } from '../../lib/money';
import { AppointmentCard } from './AppointmentCard';
import { useGetPortalOverviewQuery } from './portalApi';

/** What a patient sees first: the next appointment, what is still to pay, and the way into the rest. View only. */
export function PortalHome() {
  const { t } = useTranslation();
  const { data, error, isLoading } = useGetPortalOverviewQuery();

  if (isLoading) return <Skeleton variant="rounded" height={160} aria-label={t('Loading')} />;
  if (error || !data) return <Paper sx={{ p: 3, maxWidth: 560 }}><Typography color="error">{errorMessage(error)}</Typography></Paper>;
  const { balance } = data;
  const paidPercent = balance.price > 0 ? Math.min(100, Math.round((balance.paid / balance.price) * 100)) : 0;

  const tile = (to: string, icon: React.ReactNode, label: string, note?: string) => (
    <Paper component={RouterLink} to={to} sx={{ p: 2, textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: 1.5, minHeight: 64, '&:hover': { boxShadow: 6 } }}>
      <Box sx={{ color: 'primary.main', display: 'grid' }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography fontWeight={700}>{label}</Typography>
        {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
      </Box>
    </Paper>
  );

  return (
    <Stack spacing={3}>
      <Box component="section" aria-label={t('Your next appointment')}>
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>{t('Your next appointment')}</Typography>
        {data.next ? (
          <AppointmentCard appointment={data.next} cancelMinHours={data.cancelMinHours} />
        ) : (
          <Paper sx={{ p: 2.5 }}>
            <Typography color="text.secondary">{t('You have no appointment coming up. To book one, please call the clinic.')}</Typography>
          </Paper>
        )}
        {data.upcomingCount > 1 && (
          <Button component={RouterLink} to="/my/appointments" sx={{ mt: 1 }}>{t('See all {{n}} upcoming appointments', { n: data.upcomingCount })}</Button>
        )}
      </Box>

      <Box component="section" aria-label={t('Your treatment balance')}>
        <Typography variant="h6" component="h2" sx={{ mb: 1 }}>{t('Your treatment balance')}</Typography>
        <Paper sx={{ p: 2.5 }}>
          {balance.price === 0 ? (
            <Typography color="text.secondary">{t('You have no treatment plan with a price yet.')}</Typography>
          ) : (
            <>
              <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mb: 1.5 }}>
                <Box><Typography variant="caption" color="text.secondary">{t('Total')}</Typography><Typography variant="h6">{formatMoney(balance.price)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">{t('Paid')}</Typography><Typography variant="h6">{formatMoney(balance.paid)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">{t('Still to pay')}</Typography><Typography variant="h6" color={balance.remaining > 0 ? 'warning.main' : 'success.main'}>{formatMoney(balance.remaining)}</Typography></Box>
              </Box>
              <LinearProgress variant="determinate" value={paidPercent} aria-label={t('Share of the total that is paid')} sx={{ height: 8 }} />
            </>
          )}
          <Button component={RouterLink} to="/my/treatment" sx={{ mt: 1.5 }}>{t('See my treatment')}</Button>
        </Paper>
      </Box>

      <Box component="nav" aria-label={t('My care')} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2 }}>
        {tile('/my/appointments', <EventNoteIcon />, t('My appointments'), t('Upcoming visits and your visit history'))}
        {tile('/my/treatment', <AssignmentIcon />, t('My treatment'), t('What is planned, and how far it has got'))}
        {tile('/my/payments', <PaymentsIcon />, t('My payments'), t('Payments and receipts'))}
        {tile('/my/documents', <FolderIcon />, t('My documents'), data.documentsCount > 0 ? t('{{n}} shared with you', { n: data.documentsCount }) : t('Nothing shared with you yet'))}
      </Box>
    </Stack>
  );
}
