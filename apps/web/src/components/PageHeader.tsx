import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { BRAND } from '../theme';

/**
 * The title, an optional line under it and the page's buttons. By default the buttons sit beside the title and wrap
 * under it only when there is no room; `actionsBelow` always puts them on their own row under the title (for pages
 * whose title can be long, such as a patient's name, so the buttons never jump around).
 */
export function PageHeader({ title, subtitle, actions, actionsBelow = false }: { title: string; subtitle?: string; actions?: ReactNode; actionsBelow?: boolean }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: actionsBelow ? 'stretch' : 'center', flexDirection: actionsBelow ? 'column' : 'row', gap: 2, mb: 3.5 }}>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="h4" component="h1" sx={{ fontSize: { xs: '1.6rem', sm: '2rem' }, overflowWrap: 'anywhere' }}>
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
