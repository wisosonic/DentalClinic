import { useState } from 'react';
import { Box, Button, Chip, Collapse, Paper, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { TimelineEntryDto } from '@aya/shared';
import { StatusChip } from '../../components/StatusChip';
import { formatDate, fullName } from '../../lib/format';
import { ReportView } from './ReportView';

interface Props {
  entries: TimelineEntryDto[];
  /** Staff open the appointment from its card; a patient's timeline has no such action. */
  onOpenAppointment?: (appointmentId: number) => void;
  emptyText?: string;
}

/**
 * Appointments as a history, newest first, each with its report (summary and prescription,
 * plus tooth notes for clinic viewers). The same component serves the patient portal later.
 */
export function Timeline({ entries, onOpenAppointment, emptyText = 'No appointments yet.' }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (entries.length === 0) return <Typography color="text.secondary">{t(emptyText)}</Typography>;

  return (
    <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, position: 'relative', '&::before': { content: '""', position: 'absolute', insetBlock: 8, insetInlineStart: 7, width: 2, bgcolor: 'divider' } }}>
      {entries.map((e) => {
        const a = e.appointment;
        const expanded = open.has(a.id);
        return (
          <Box component="li" key={a.id} sx={{ position: 'relative', paddingInlineStart: 4, pb: 2 }}>
            <Box
              aria-hidden
              sx={{
                position: 'absolute', insetInlineStart: 0, top: 8, width: 16, height: 16, borderRadius: '50%', border: 3, borderColor: 'background.default',
                bgcolor: e.hasReport ? 'primary.main' : a.status === 'cancelled' || a.status === 'no_show' ? 'grey.400' : 'grey.600',
              }}
            />
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography fontWeight={600}>{formatDate(a.date)}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    <bdi dir="ltr">{a.time}–{a.endTime}</bdi> · {t('Dr {{name}}', { name: fullName(a.doctor) })}
                  </Typography>
                </Box>
                <StatusChip status={a.status} />
              </Box>
              {a.categories.length > 0 && (
                <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                  {a.categories.map((c) => <Chip key={c} size="small" label={c} variant="outlined" />)}
                </Stack>
              )}

              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
                {e.report ? (
                  <Button size="small" aria-expanded={expanded} onClick={() => toggle(a.id)}>
                    {expanded ? t('Hide report') : t('Show report')}
                  </Button>
                ) : e.hasReport ? (
                  <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>{t("A report exists, but you can't open it.")}</Typography>
                ) : null}
                {onOpenAppointment && <Button size="small" onClick={() => onOpenAppointment(a.id)}>{t('Open appointment')}</Button>}
              </Stack>

              {e.report && (
                <Collapse in={expanded} unmountOnExit>
                  <Box sx={{ mt: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
                    <ReportView report={e.report} appointmentId={a.id} />
                  </Box>
                </Collapse>
              )}
            </Paper>
          </Box>
        );
      })}
    </Box>
  );
}
