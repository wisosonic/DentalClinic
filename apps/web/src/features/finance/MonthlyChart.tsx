import { useId, useState } from 'react';
import { useTheme } from '@mui/material/styles';
import {
  Box, Button, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { FinanceSummaryDto } from '@aya/shared';
import { dateLocale } from '../../i18n';
import { formatMoney } from '../../lib/money';

type Month = FinanceSummaryDto['byMonth'][number];

// Two categorical slots, validated together (colour-blind safe, 3:1 against the surface) for each mode: the dark pair has its own steps.
const COLORS = {
  light: { payments: '#2a78d6', expenses: '#eb6834', grid: 'rgba(15, 100, 120, 0.14)', ink: '#10242b', inkSecondary: '#4f656b', surface: '#fff', shadow: '0 6px 24px rgba(10,61,77,0.22)', hover: 'rgba(15,100,120,0.06)' },
  dark: { payments: '#3f8ee6', expenses: '#dc6a38', grid: 'rgba(255, 255, 255, 0.16)', ink: '#e8f2f4', inkSecondary: '#9fb6bc', surface: '#1b343c', shadow: '0 6px 24px rgba(0,0,0,0.55)', hover: 'rgba(255,255,255,0.08)' },
} as const;

const H = 280;
const TOP = 16;
const BOTTOM = 44;
const LEFT = 64;
const BAND = 64; // width given to each month
const BAR = 20; // a column is at most 24px thick
const BAND_COMPACT = 44; // narrower months, for a chart that shares a row with others
const BAR_COMPACT = 14;
const GAP = 2; // the surface shows between the two columns of a month

/** A "nice" top for the axis, and the steps up to it: 0, 1,000, 2,000 rather than 0, 1,137, 2,274. */
function axis(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough)!;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

const compact = (n: number) => new Intl.NumberFormat(dateLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** A column with a rounded top (4px) and a square foot on the baseline. */
function column(x: number, w: number, y: number, h: number): string {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/**
 * What came in and what went out, month by month. Hover or focus a month for its figures; the same
 * numbers are in a table for anyone who prefers it. The picture keeps its left-to-right time axis in
 * every language.
 */
export function MonthlyChart({ months, showExpenses = true, title, narrow = false }: { months: Month[]; /** A doctor's chart has collections only. */ showExpenses?: boolean; title?: string; /** Narrower months, to fit one column of a grid. */ narrow?: boolean }) {
  const BAND_W = narrow ? BAND_COMPACT : BAND;
  const BAR_W = narrow ? BAR_COMPACT : BAR;
  const { t } = useTranslation();
  const k = COLORS[useTheme().palette.mode];
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const id = useId();

  const heading = title ?? t('Month by month');
  const label = (m: string, short = true) =>
    new Intl.DateTimeFormat(dateLocale(), { month: short ? 'short' : 'long', year: short ? '2-digit' : 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));

  if (months.length === 0) {
    return <Paper sx={{ p: 3, textAlign: 'center' }}><Typography color="text.secondary">{t('Nothing came in or went out in this period.')}</Typography></Paper>;
  }

  const { top, ticks } = axis(Math.max(...months.flatMap((m) => (showExpenses ? [m.payments, m.expenses] : [m.payments]))));
  const width = LEFT + months.length * BAND_W + 12;
  const plot = H - TOP - BOTTOM;
  const y = (v: number) => TOP + plot - (v / top) * plot;
  const net = (m: Month) => Math.round((m.payments - m.expenses) * 100) / 100;
  const shown = active === null ? null : months[active]!;
  const cx = (i: number) => LEFT + i * BAND_W + BAND_W / 2;

  return (
    <Paper sx={{ p: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1.5 }}>
        <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>{heading}</Typography>
        <Box sx={{ display: 'flex', gap: 2 }} aria-label={t('Legend')} role="group">
          {[{ color: k.payments, text: t('Payments') }, ...(showExpenses ? [{ color: k.expenses, text: t('Expenses') }] : [])].map((k) => (
            <Box key={k.text} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box aria-hidden sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: k.color }} />
              <Typography variant="body2" color="text.secondary">{k.text}</Typography>
            </Box>
          ))}
        </Box>
        <Button size="small" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>{asTable ? t('Show chart') : t('Show as table')}</Button>
      </Box>

      {asTable ? (
        <TableContainer>
          <Table size="small" aria-label={heading}>
            <TableHead>
              <TableRow>
                <TableCell>{t('Month')}</TableCell><TableCell align="right">{t('Payments')}</TableCell>
                {showExpenses && <TableCell align="right">{t('Expenses')}</TableCell>}{showExpenses && <TableCell align="right">{t('Net profit')}</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {months.map((m) => (
                <TableRow key={m.month}>
                  <TableCell>{label(m.month, false)}</TableCell>
                  <TableCell align="right">{formatMoney(m.payments)}</TableCell>
                  {showExpenses && <TableCell align="right">{formatMoney(m.expenses)}</TableCell>}
                  {showExpenses && <TableCell align="right" sx={{ fontWeight: 700 }}>{formatMoney(net(m))}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Box dir="ltr" sx={{ overflowX: 'auto', position: 'relative' }} onMouseLeave={() => setActive(null)}>
          <Box sx={{ position: 'relative', width: '100%', minWidth: width, maxWidth: months.length < 6 ? 640 : undefined }}>
            <svg viewBox={`0 0 ${width} ${H}`} width="100%" role="group" aria-labelledby={`${id}-title`} style={{ display: 'block' }}>
              <title id={`${id}-title`}>{showExpenses ? t('Payments and expenses for each month') : t('Payments for each month')}</title>
              {ticks.map((v) => (
                <g key={v}>
                  <line x1={LEFT} x2={width - 8} y1={y(v)} y2={y(v)} stroke={k.grid} strokeWidth={1} />
                  <text x={LEFT - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={k.inkSecondary}>{compact(v)}</text>
                </g>
              ))}
              {months.map((m, i) => (
                <g key={m.month}>
                  {m.payments > 0 && <path d={column(cx(i) - GAP / 2 - BAR_W, BAR_W, y(m.payments), plot + TOP - y(m.payments))} fill={k.payments} />}
                  {showExpenses && m.expenses > 0 && <path d={column(cx(i) + GAP / 2, BAR_W, y(m.expenses), plot + TOP - y(m.expenses))} fill={k.expenses} />}
                  <text x={cx(i)} y={H - BOTTOM + 18} textAnchor="middle" fontSize={11} fill={k.inkSecondary}>{label(m.month)}</text>
                  {/* a hit area much bigger than the columns, so a small value is as easy to reach as a big one */}
                  <rect
                    x={cx(i) - BAND_W / 2} y={TOP} width={BAND_W} height={H - TOP - BOTTOM + 24} fill={active === i ? k.hover : 'transparent'}
                    tabIndex={0} role="img" aria-label={`${label(m.month, false)}: ${t('Payments')} ${formatMoney(m.payments)}${showExpenses ? `, ${t('Expenses')} ${formatMoney(m.expenses)}` : ''}`}
                    onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                    style={{ outline: 'none' }}
                  />
                </g>
              ))}
              <line x1={LEFT} x2={width - 8} y1={y(0)} y2={y(0)} stroke={k.grid} strokeWidth={1} />
            </svg>
            {shown && active !== null && (
              <Box
                role="status"
                sx={{
                  position: 'absolute', top: 4, left: `${(cx(active) / width) * 100}%`, transform: cx(active) / width > 0.8 ? 'translateX(-100%)' : 'translateX(-30%)',
                  bgcolor: k.surface, color: k.ink, borderRadius: 1, boxShadow: k.shadow, px: 1.5, py: 1, pointerEvents: 'none', minWidth: 170, zIndex: 2,
                }}
              >
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{label(shown.month, false)}</Typography>
                {[{ color: k.payments, text: t('Payments'), v: shown.payments }, ...(showExpenses ? [{ color: k.expenses, text: t('Expenses'), v: shown.expenses }] : [])].map((r) => (
                  <Box key={r.text} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, justifyContent: 'space-between' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                      <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: r.color }} />
                      <Typography variant="body2" sx={{ color: k.inkSecondary }}>{r.text}</Typography>
                    </Box>
                    <Typography variant="body2" fontWeight={700}>{formatMoney(r.v)}</Typography>
                  </Box>
                ))}
                {showExpenses && <Box sx={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${k.grid}`, mt: 0.5, pt: 0.5 }}>
                  <Typography variant="body2" sx={{ color: k.inkSecondary }}>{t('Net profit')}</Typography>
                  <Typography variant="body2" fontWeight={800}>{formatMoney(net(shown))}</Typography>
                </Box>}
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Paper>
  );
}
