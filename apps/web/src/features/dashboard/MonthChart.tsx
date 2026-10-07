import { useId, useState, type ReactNode } from 'react';
import { useTheme } from '@mui/material/styles';
import { Box, Button, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { dateLocale } from '../../i18n';

/**
 * The colours, each set validated for its mode (colour-blind safe, 3:1 against the surface; the dark steps are their own).
 * Profit and loss are the blue and the orange of the payments-and-expenses chart (money in, money out); debts and the
 * count of appointments have colours of their own.
 */
export const COLORS = {
  light: { good: '#2a78d6', bad: '#eb6834', debt: '#7b1fa2', count: '#2a78d6', grid: 'rgba(15, 100, 120, 0.14)', ink: '#10242b', inkSecondary: '#4f656b', surface: '#fff', shadow: '0 6px 24px rgba(10,61,77,0.22)', hover: 'rgba(15, 100, 120, 0.08)' },
  dark: { good: '#3f8ee6', bad: '#dc6a38', debt: '#b86fc0', count: '#3f8ee6', grid: 'rgba(255, 255, 255, 0.16)', ink: '#e8f2f4', inkSecondary: '#9fb6bc', surface: '#1b343c', shadow: '0 6px 24px rgba(0,0,0,0.55)', hover: 'rgba(255, 255, 255, 0.07)' },
} as const;
export type Palette = (typeof COLORS)[keyof typeof COLORS];

export interface ChartSeries {
  id: string;
  name: string;
  /** One value for each month, in the order of the months. */
  values: number[];
  /** The colour of a column, which may depend on its value (a profit is blue, a loss orange). */
  color: (k: Palette, value: number) => string;
  /** How a figure is written in the tooltip, the table and the screen-reader text. */
  format: (value: number) => string;
}

const H = 240;
const TOP = 14;
const BOTTOM = 36;
const LEFT = 52;
const GAP = 2; // the surface shows between the columns of a month

/** A "nice" step for the axis: 1, 2, 2.5, 5 times a power of ten (whole numbers only for counts). */
function step(range: number, whole: boolean): number {
  const rough = Math.max(range, 1e-9) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 2.5, 5, 10, 20, 25, 50].map((m) => m * pow).filter((s) => !whole || Number.isInteger(s));
  return candidates.find((s) => s >= rough) ?? Math.ceil(rough);
}

/** The axis for values that may go below zero: the ticks, and the lowest and highest of them. */
function axis(min: number, max: number, whole: boolean): { lo: number; hi: number; ticks: number[] } {
  if (max <= 0 && min >= 0) return { lo: 0, hi: whole ? 4 : 1, ticks: whole ? [0, 1, 2, 3, 4] : [0, 1] };
  const s = step(Math.max(max, 0) - Math.min(min, 0), whole);
  const hi = Math.ceil(Math.max(max, 0) / s) * s;
  const lo = Math.floor(Math.min(min, 0) / s) * s;
  return { lo, hi, ticks: Array.from({ length: Math.round((hi - lo) / s) + 1 }, (_, i) => lo + i * s) };
}

const compact = (n: number) => new Intl.NumberFormat(dateLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** A column standing on the zero line, upward or downward, with its far end rounded (4px). */
function column(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  if (y1 < y0) return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`; // up
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`; // down
}

/**
 * Month by month, one column per figure: the profit, what patients owed, how many appointments. Hover or focus a
 * month for its figures; the same numbers are in a table for anyone who prefers it. The picture keeps its
 * left-to-right time axis in every language.
 */
export function MonthChart({ months, series, title, note, legend, whole = false }: {
  months: string[]; series: ChartSeries[]; title: string; note?: string;
  /** What the colours mean: left out (empty) for a chart with a single colour, which its title already names. */
  legend: (k: Palette) => { color: string; text: string }[];
  /** Whole numbers on the axis (counts). */
  whole?: boolean;
}) {
  const { t } = useTranslation();
  const k = COLORS[useTheme().palette.mode];
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const label = (m: string, short = true) =>
    new Intl.DateTimeFormat(dateLocale(), { month: short ? 'short' : 'long', year: short ? '2-digit' : 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));

  const all = series.flatMap((s) => s.values);
  const { lo, hi, ticks } = axis(Math.min(...all, 0), Math.max(...all, 0), whole);
  const BAR = series.length === 1 ? 22 : 14; // a column is at most 24px thick
  const BAND = series.length === 1 ? 46 : 2 * BAR + GAP + 14;
  const width = LEFT + months.length * BAND + 12;
  const plot = H - TOP - BOTTOM;
  const y = (v: number) => TOP + plot - ((v - lo) / (hi - lo)) * plot;
  const cx = (i: number) => LEFT + i * BAND + BAND / 2;
  /** The left edge of a series' column inside its month. */
  const left = (i: number, n: number) => cx(i) - (series.length * BAR + (series.length - 1) * GAP) / 2 + n * (BAR + GAP);

  return (
    <Paper component="section" aria-label={title} sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6" component="h3">{title}</Typography>
          {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
        </Box>
        <Button size="small" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>{asTable ? t('Show chart') : t('Show as table')}</Button>
      </Box>
      {legend(k).length > 0 && <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }} aria-label={t('Legend')} role="group">
        {legend(k).map((l) => (
          <Box key={l.text} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: l.color }} />
            <Typography variant="body2" color="text.secondary">{l.text}</Typography>
          </Box>
        ))}
      </Box>}

      {asTable ? (
        <TableContainer>
          <Table size="small" aria-label={title}>
            <TableHead>
              <TableRow><TableCell>{t('Month')}</TableCell>{series.map((s) => <TableCell key={s.id} align="right">{s.name}</TableCell>)}</TableRow>
            </TableHead>
            <TableBody>
              {months.map((m, i) => (
                <TableRow key={m}>
                  <TableCell>{label(m, false)}</TableCell>
                  {series.map((s) => <TableCell key={s.id} align="right" sx={{ fontWeight: 700 }}>{s.format(s.values[i]!)}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Box dir="ltr" sx={{ overflowX: 'auto', position: 'relative' }} onMouseLeave={() => setActive(null)}>
          <Box sx={{ position: 'relative', width: '100%', minWidth: width }}>
            <svg viewBox={`0 0 ${width} ${H}`} width="100%" role="group" aria-labelledby={`${id}-title`} style={{ display: 'block' }}>
              <title id={`${id}-title`}>{title}</title>
              {ticks.map((v) => (
                <g key={v}>
                  <line x1={LEFT} x2={width - 8} y1={y(v)} y2={y(v)} stroke={k.grid} strokeWidth={v === 0 ? 1.5 : 1} />
                  <text x={LEFT - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={k.inkSecondary}>{compact(v)}</text>
                </g>
              ))}
              {months.map((m, i) => (
                <g key={m}>
                  {series.map((s, n) => s.values[i] !== 0 && <path key={s.id} d={column(left(i, n), BAR, y(0), y(s.values[i]!))} fill={s.color(k, s.values[i]!)} />)}
                  <text x={cx(i)} y={H - BOTTOM + 18} textAnchor="middle" fontSize={11} fill={k.inkSecondary}>{label(m)}</text>
                  {/* a hit area much bigger than the columns, so a small value is as easy to reach as a big one */}
                  <rect
                    x={cx(i) - BAND / 2} y={TOP} width={BAND} height={H - TOP - BOTTOM + 24} fill={active === i ? k.hover : 'transparent'}
                    tabIndex={0} role="img" aria-label={`${label(m, false)}: ${series.map((s) => `${s.name} ${s.format(s.values[i]!)}`).join(', ')}`}
                    onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                    style={{ outline: 'none' }}
                  />
                </g>
              ))}
            </svg>
            {active !== null && (
              <Box
                role="status"
                sx={{
                  position: 'absolute', top: 4, left: `${(cx(active) / width) * 100}%`, transform: cx(active) / width > 0.7 ? 'translateX(-100%)' : 'translateX(-30%)',
                  bgcolor: k.surface, color: k.ink, borderRadius: 1, boxShadow: k.shadow, px: 1.5, py: 1, pointerEvents: 'none', minWidth: 160, zIndex: 2,
                }}
              >
                <Typography variant="subtitle2" sx={{ mb: 0.25 }}>{label(months[active]!, false)}</Typography>
                {series.map((s) => {
                  const v = s.values[active]!;
                  return (
                    <Row key={s.id} color={s.color(k, v)} name={s.name} value={s.format(v)} inkSecondary={k.inkSecondary} />
                  );
                })}
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Paper>
  );
}

function Row({ color, name, value, inkSecondary }: { color: string; name: ReactNode; value: string; inkSecondary: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, justifyContent: 'space-between' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: color }} />
        <Typography variant="body2" sx={{ color: inkSecondary }}>{name}</Typography>
      </Box>
      <Typography variant="body2" fontWeight={700}>{value}</Typography>
    </Box>
  );
}
