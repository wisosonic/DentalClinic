import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';

export interface BarItem {
  key: string | number;
  label: ReactNode;
  value: number;
  /** What is shown at the end of the row; the number by default. */
  display?: ReactNode;
  color?: string;
}


/**
 * Ranked horizontal bars: a label, a bar as long as its value compared with the biggest, and the value as
 * text. The list is real text first (the bars are decoration), so it reads the same to a screen reader, and
 * it keeps its left-to-right bars in every language.
 */
export function BarList({ items, label, color = '#0b7a75' }: { items: BarItem[]; label: string; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <Box component="ul" aria-label={label} sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1.25 }}>
      {items.map((item) => (
        <Box component="li" key={item.key} sx={{ display: 'grid', gap: 0.5 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'baseline' }}>
            <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.label}</Typography>
            <Typography variant="body2" fontWeight={700} dir="ltr" sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{item.display ?? item.value}</Typography>
          </Box>
          <Box dir="ltr" aria-hidden sx={{ height: 8, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden' }}>
            <Box sx={{ height: '100%', width: `${(item.value / max) * 100}%`, minWidth: item.value > 0 ? 4 : 0, borderRadius: 4, bgcolor: item.color ?? color }} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

