import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

export interface BarItem {
  key: string | number;
  label: ReactNode;
  value: number;
  /** What is shown at the end of the row; the number by default. */
  display?: ReactNode;
  color?: string;
}

/** A colour for each mode: the dark step is its own, chosen against the dark surface, not the light one turned over. */
export interface ModeColor { light: string; dark: string }

/** Each set validated (colour-blind safe, 3:1 against its surface). Debts keep the purple they have in the month chart. */
export const BAR_COLORS = {
  blue: { light: '#2a78d6', dark: '#3f8ee6' },
  debt: { light: '#7b1fa2', dark: '#b86fc0' },
} as const satisfies Record<string, ModeColor>;

/**
 * Ranked horizontal bars: a label, a bar as long as its value compared with the biggest, and the value as
 * text. The list is real text first (the bars are decoration), so it reads the same to a screen reader, and
 * it keeps its left-to-right bars in every language.
 */
export function BarList({ items, label, color = BAR_COLORS.blue }: { items: BarItem[]; label: string; color?: ModeColor | string }) {
  const mode = useTheme().palette.mode;
  const base = typeof color === 'string' ? color : color[mode];
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <Box component="ul" aria-label={label} sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1.75 }}>
      {items.map((item) => {
        const fill = item.color ?? base;
        return (
          <Box component="li" key={item.key} sx={{ display: 'grid', gap: 0.75 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'baseline' }}>
              <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{item.label}</Typography>
              <Typography variant="body2" fontWeight={800} dir="ltr" sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{item.display ?? item.value}</Typography>
            </Box>
            {/* a visible track, and a bar a little thicker than before, with a soft fade towards its start */}
            <Box dir="ltr" aria-hidden sx={{ height: 12, borderRadius: 6, bgcolor: mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(15,100,120,0.10)', overflow: 'hidden' }}>
              <Box
                data-bar-color={fill}
                sx={{
                  height: '100%', width: `${(item.value / max) * 100}%`, minWidth: item.value > 0 ? 6 : 0, borderRadius: 6, bgcolor: fill,
                  backgroundImage: `linear-gradient(90deg, rgba(255,255,255,${mode === 'dark' ? 0.0 : 0.18}) 0%, rgba(255,255,255,0) 60%)`,
                }}
              />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
