import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { BRAND } from '../theme';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, mb: 3.5 }}>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="h4" component="h1" sx={{ fontSize: { xs: '1.6rem', sm: '2rem' } }}>
          {title}
        </Typography>
        <Box sx={{ width: 44, height: 4, borderRadius: 2, background: BRAND.gradient, mt: 0.75, mb: subtitle ? 1 : 0 }} />
        {subtitle && (
          <Typography color="text.secondary" variant="body2">
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions}
    </Box>
  );
}
