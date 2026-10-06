import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { ToothDto } from '@aya/shared';
import { GUMS, PANORAMA, ZONES, toothPath } from '../lib/panoramaZones';

interface Props {
  teeth: ToothDto[];
  /** Teeth that have history for this patient: drawn highlighted. */
  marked?: ReadonlySet<number>;
  /** Teeth chosen right now (for example in a report). */
  selected?: ReadonlySet<number>;
  onToggle?: (toothId: number) => void;
  /** 'all': every tooth can be clicked (choosing teeth). 'marked': only teeth with history can (reading history). */
  clickable?: 'all' | 'marked';
}

const TEAL = '#0b7a75';
const AMBER = '#f59e0b';
const GUM = '#f3b8b8';

/**
 * The shared dental panorama: one flat illustration of all 32 teeth, the same for every patient, with
 * the patient's teeth history drawn over it. Each tooth is a real button for keyboard and screen-reader
 * users. The picture keeps its orientation in every language (it is a picture of a mouth, not text),
 * and on a phone it scrolls sideways at a size large enough to tap.
 */
export function DentalPanorama({ teeth, marked, selected, onToggle, clickable = 'all' }: Props) {
  const { t } = useTranslation();
  const byIndex = new Map(teeth.map((x) => [x.index, x]));

  return (
    <Box dir="ltr" sx={{ width: '100%', overflowX: 'auto' }}>
      <Box
        component="svg"
        viewBox={`0 0 ${PANORAMA.width} ${PANORAMA.height}`}
        role="group"
        aria-label={t('Dental chart')}
        sx={{
          display: 'block', width: '100%', maxWidth: 780, mx: 'auto', height: 'auto', minWidth: 640, borderRadius: 3, bgcolor: '#f4fafa',
          '& g[role="button"]:focus-visible .tooth, & g[role="button"]:hover .tooth': { stroke: '#000', strokeWidth: 4 },
          userSelect: 'none',
        }}
      >
        <rect x={20} y={GUMS.upper.y} width={PANORAMA.width - 40} height={GUMS.upper.h} rx={38} fill={GUM} />
        <rect x={20} y={GUMS.lower.y} width={PANORAMA.width - 40} height={GUMS.lower.h} rx={38} fill={GUM} />
        <line x1={PANORAMA.midline} x2={PANORAMA.midline} y1={GUMS.upper.y} y2={GUMS.lower.y + GUMS.lower.h} stroke="#e2a3a3" strokeWidth={2} strokeDasharray="6 8" />

        {ZONES.map((zone) => {
          const tooth = byIndex.get(zone.index);
          const isSelected = !!tooth && !!selected?.has(tooth.id);
          const isMarked = !!tooth && !!marked?.has(tooth.id);
          const interactive = !!tooth && !!onToggle && (clickable === 'all' || isMarked);
          const label = `${t('Tooth {{index}}', { index: zone.index })}${tooth ? `, ${tooth.name}` : ''}${isMarked ? `, ${t('has notes')}` : ''}${isSelected ? `, ${t('selected')}` : ''}`;
          const upper = zone.jaw === 'upper';
          const labelY = upper ? GUMS.upperLabelY : GUMS.lowerLabelY;
          return (
            <g
              key={zone.index}
              role={interactive ? 'button' : 'img'}
              aria-label={label}
              aria-pressed={interactive && selected ? isSelected : undefined}
              tabIndex={interactive ? 0 : undefined}
              style={{ cursor: interactive ? 'pointer' : 'default', outline: 'none' }}
              onClick={() => interactive && onToggle!(tooth!.id)}
              onKeyDown={(e) => {
                if (interactive && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onToggle!(tooth!.id);
                }
              }}
            >
              <title>{label}</title>
              {/* a generous invisible target around the tooth and its number */}
              <rect x={zone.x - 2} y={upper ? GUMS.upper.y : zone.y} width={zone.w + 4} height={upper ? zone.y + zone.h - GUMS.upper.y : GUMS.lower.y + GUMS.lower.h - zone.y} fill="transparent" />
              <path
                className="tooth" data-tooth={zone.index} d={toothPath(zone)} strokeLinejoin="round"
                fill={isSelected ? TEAL : isMarked ? AMBER : '#ffffff'}
                stroke={isSelected ? '#075e5a' : isMarked ? '#c77d05' : '#9db4b8'}
                strokeWidth={isSelected || isMarked ? 4 : 2.5}
              />
              <text
                x={zone.x + zone.w / 2} y={labelY} textAnchor="middle" fontSize={22} fontWeight={700}
                fill={isSelected ? '#075e5a' : '#6b2d2d'}
              >
                {zone.index}
              </text>
            </g>
          );
        })}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{t('Right')}</span>
        <span>{t('Left')}</span>
      </Typography>
    </Box>
  );
}
