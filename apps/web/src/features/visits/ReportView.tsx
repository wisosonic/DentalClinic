import { Box, Button, Stack, Typography } from '@mui/material';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { useTranslation } from 'react-i18next';
import { SURFACES, type PrescriptionDto, type ReportDto } from '@aya/shared';

/** "500 mg, 3 times per day". */
export const prescriptionText = (m: Pick<PrescriptionDto, 'dose' | 'frequency' | 'timeUnit'>) =>
  `${m.dose}, ${m.frequency} ${m.frequency === 1 ? 'time' : 'times'} per ${m.timeUnit}`;

/** A report, read-only. Per-tooth notes appear only when the server sent them (clinic viewers). */
export function ReportView({ report, appointmentId }: { report: ReportDto; appointmentId: number }) {
  const { t } = useTranslation();
  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="caption" color="text.secondary">{t('What was done')}</Typography>
        <Typography sx={{ whiteSpace: 'pre-wrap' }}>{report.summary?.trim() || t('No summary was written.')}</Typography>
      </Box>

      <Box>
        <Typography variant="caption" color="text.secondary">{t('Prescription')}</Typography>
        {report.medications.length === 0 ? (
          <Typography>{t('No medication prescribed.')}</Typography>
        ) : (
          <Stack component="ul" spacing={0.75} sx={{ m: 0, pl: 2.5 }}>
            {report.medications.map((m) => (
              <li key={m.id}>
                <strong>{m.name}</strong>{m.type ? ` (${m.type})` : ''}: {prescriptionText(m)}
                {m.notes && <Typography variant="body2" color="text.secondary">{m.notes}</Typography>}
              </li>
            ))}
          </Stack>
        )}
      </Box>

      {report.teeth && report.teeth.length > 0 && (
        <Box>
          <Typography variant="caption" color="text.secondary">{t('Tooth notes (clinic only)')}</Typography>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
            {report.teeth.map((rt) => (
              <li key={rt.toothId}>
                <strong>{t('Tooth {{index}}', { index: rt.index })}</strong>:{' '}
                {SURFACES.filter((s) => rt[s]).map((s) => `${s} – ${rt[s]}`).join('; ')}
              </li>
            ))}
          </Stack>
        </Box>
      )}

      <Box>
        <Button
          size="small" startIcon={<PictureAsPdfIcon />}
          component="a" href={`/api/v1/appointments/${appointmentId}/report/pdf`} target="_blank" rel="noopener"
        >
          {t('Visit summary (PDF)')}
        </Button>
      </Box>
    </Stack>
  );
}
