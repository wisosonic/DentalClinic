import { Alert, Box, Chip, Link, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { useGetMedicalAlertsQuery } from './medicalApi';

/**
 * The warning that goes with a patient wherever the clinic works on them: current allergies (the severe ones filled in),
 * current conditions and pregnancy, with a way to the full history. Says so when nothing has been recorded yet. It shows
 * nothing at all for someone who may not see the history (the server answers an error) and while loading.
 */
export function MedicalAlertBanner({ patientId, onNavigate, compact = false }: { patientId: number | undefined; onNavigate?: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const { data } = useGetMedicalAlertsQuery(patientId as number, { skip: !patientId });
  if (!patientId || !data) return null;
  const link = (
    <Link component={RouterLink} to={`/patients/${patientId}/medical`} onClick={onNavigate} underline="hover" sx={{ fontWeight: 600 }}>{t('Medical history')}</Link>
  );
  if (!data.recorded) {
    return <Alert severity="info" icon={false} sx={{ mb: compact ? 1.5 : 2 }}>{t('No medical history has been recorded for this patient yet.')} {link}</Alert>;
  }
  if (data.allergies.length === 0 && data.conditions.length === 0 && !data.pregnant) return null;

  return (
    <Alert severity={data.allergies.some((a) => a.severity === 'severe') ? 'error' : 'warning'} sx={{ mb: compact ? 1.5 : 2 }} role="region" aria-label={t('Medical alerts')}>
      <Box sx={{ display: 'grid', gap: 0.75 }}>
        {data.allergies.length > 0 && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography variant="body2" fontWeight={700}>{t('Allergies')}:</Typography>
            {data.allergies.map((a) => (
              <Chip key={a.name} size="small" color="error" variant={a.severity === 'severe' ? 'filled' : 'outlined'} label={a.severity ? `${a.name} (${t(a.severity)})` : a.name} />
            ))}
          </Box>
        )}
        {(data.conditions.length > 0 || data.pregnant) && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            <Typography variant="body2" fontWeight={700}>{t('Medical conditions')}:</Typography>
            {data.pregnant && <Chip size="small" color="warning" label={t('Pregnant')} />}
            {data.conditions.map((c) => <Chip key={c} size="small" color="warning" variant="outlined" label={c} />)}
          </Box>
        )}
        <Typography variant="caption">{link}</Typography>
      </Box>
    </Alert>
  );
}
