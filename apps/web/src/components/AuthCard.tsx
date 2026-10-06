import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { LanguageSwitch } from '../i18n/LanguageSwitch';
import { BRAND } from '../theme';
import { BrandLogo } from './BrandLogo';

/** Sign-in layout: a brand panel beside the form on wide screens, just the form on phones. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.05fr 1fr' } }}>
      <Box
        aria-hidden
        sx={{
          display: { xs: 'none', md: 'flex' }, flexDirection: 'column', justifyContent: 'space-between', p: 6, color: '#fff',
          position: 'relative', overflow: 'hidden', background: BRAND.gradientDeep,
          '&::before': { content: '""', position: 'absolute', width: 520, height: 520, borderRadius: '50%', insetInlineEnd: -160, top: -140, background: 'radial-gradient(circle, rgba(64,191,185,0.55), transparent 65%)' },
          '&::after': { content: '""', position: 'absolute', width: 460, height: 460, borderRadius: '50%', insetInlineStart: -140, bottom: -160, background: 'radial-gradient(circle, rgba(255,255,255,0.14), transparent 65%)' },
        }}
      >
        <Box sx={{ position: 'relative' }}><BrandLogo size={44} onDark /></Box>
        <Box sx={{ position: 'relative', maxWidth: 460 }}>
          <Typography variant="h3" component="p" sx={{ fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1, mb: 2, fontSize: { md: '2.6rem', lg: '3rem' } }}>
            {t('Dental care, beautifully organised.')}
          </Typography>
          <Typography sx={{ opacity: 0.85, fontSize: '1.05rem' }}>
            {t('Appointments, patient records and visit reports in one calm place.')}
          </Typography>
        </Box>
        <Box sx={{ position: 'relative', height: 4, width: 64, borderRadius: 2, bgcolor: 'primary.light' }} />
      </Box>

      <Box sx={{ display: 'grid', placeItems: 'center', p: 2, background: { xs: (theme) => (theme.palette.mode === 'dark' ? 'linear-gradient(160deg, #10282d 0%, #0c1a1f 55%, #11262e 100%)' : 'linear-gradient(160deg, #dff3f2 0%, #eef4f6 55%, #d9e9ef 100%)'), md: 'transparent' } }}>
        <Paper elevation={0} sx={{ width: '100%', maxWidth: 440, p: { xs: 3, sm: 5 }, boxShadow: '0 20px 60px rgba(10,61,77,0.16)' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
            <Box sx={{ flexGrow: 1, minWidth: 0, display: { md: 'none' } }}><BrandLogo size={40} /></Box>
            <Box sx={{ flexGrow: 1, display: { xs: 'none', md: 'block' } }} />
            <LanguageSwitch color="primary" />
          </Box>
          <Typography variant="h5" component="h1" gutterBottom>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          )}
          {children}
        </Paper>
      </Box>
    </Box>
  );
}
