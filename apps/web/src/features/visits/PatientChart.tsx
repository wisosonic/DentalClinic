import { useMemo, useState } from 'react';
import { Alert, Box, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { SURFACES } from '@aya/shared';
import { DentalPanorama } from '../../components/DentalPanorama';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { useGetChartQuery, useGetTeethQuery } from '../clinical/clinicalApi';

/** A patient's dental chart: teeth with recorded notes are highlighted; click one for its history. */
export function PatientChart({ patientId }: { patientId: number }) {
  const { t } = useTranslation();
  const { data: teeth = [], isLoading: loadingTeeth } = useGetTeethQuery();
  const { data: chart = [], isLoading, error } = useGetChartQuery(patientId);
  const [chosen, setChosen] = useState<number | null>(null);

  const marked = useMemo(() => new Set(chart.map((c) => c.toothId)), [chart]);
  const history = chart.find((c) => c.toothId === chosen);
  const tooth = teeth.find((x) => x.id === chosen);

  if (isLoading || loadingTeeth) return <Skeleton variant="rounded" height={120} />;
  if (error) return <Alert severity="info">{errorMessage(error, t('The dental chart is not available to you.'))}</Alert>;

  return (
    <Box>
      <DentalPanorama clickable="marked" teeth={teeth} marked={marked} selected={chosen ? new Set([chosen]) : undefined} onToggle={(id) => setChosen((c) => (c === id ? null : id))} />
      {chart.length === 0 && <Typography color="text.secondary" variant="body2" sx={{ mt: 1 }}>{t('No tooth notes have been recorded yet.')}</Typography>}
      {chosen && (
        <Paper variant="outlined" sx={{ p: 2, mt: 1 }}>
          <Typography variant="subtitle2" gutterBottom>{t('Tooth {{index}}', { index: tooth?.index })}{tooth ? `, ${tooth.name}` : ''}</Typography>
          {!history ? (
            <Typography color="text.secondary" variant="body2">{t('Nothing recorded for this tooth.')}</Typography>
          ) : (
            <Stack spacing={1.5}>
              {history.entries.map((e) => (
                <Box key={`${e.appointmentId}`}>
                  <Typography variant="body2" fontWeight={600}>{formatDate(e.date)} · {t('Dr {{name}}', { name: fullName(e.doctor) })}</Typography>
                  <Stack component="ul" sx={{ m: 0, pl: 2.5 }}>
                    {SURFACES.filter((s) => e[s]).map((s) => (
                      <li key={s}><span style={{ textTransform: 'capitalize' }}>{s}</span>: {e[s]}</li>
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          )}
        </Paper>
      )}
    </Box>
  );
}
