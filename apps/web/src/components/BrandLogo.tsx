import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';

/**
 * The application logo (public/images/logo.png) with the clinic name beside it.
 * `onDark` puts the logo on a white tile and the name in white, for the dark sidebar and hero panels.
 */
export function BrandLogo({ size = 40, showName = true, onDark = false }: { size?: number; showName?: boolean; onDark?: boolean }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
      <Box
        sx={{
          width: size + 12, height: size + 12, borderRadius: '30%', display: 'grid', placeItems: 'center', flexShrink: 0,
          bgcolor: '#fff', boxShadow: onDark ? '0 6px 18px rgba(0,0,0,0.25)' : '0 4px 14px rgba(10,61,77,0.15)',
        }}
      >
        <Box component="img" src="/images/logo.png" alt={showName ? '' : t('Dental Clinic')} width={size} height={size} sx={{ display: 'block', objectFit: 'contain' }} />
      </Box>
      {showName && (
        <Typography variant="h6" component="span" noWrap sx={{ fontWeight: 800, color: onDark ? '#fff' : 'primary.dark', letterSpacing: '-0.02em' }}>
          {t('Dental Clinic')}
        </Typography>
      )}
    </Box>
  );
}
