import { Button } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';

/** The way back to the patient, the same on every page the patient page opens (its own pages and the filtered lists). */
export function BackToPatientButton({ patientId }: { patientId: number }) {
  const { t } = useTranslation();
  return (
    <Button component={RouterLink} to={`/patients/${patientId}`} startIcon={<ArrowBackIcon sx={{ '[dir=rtl] &': { transform: 'scaleX(-1)' } }} />}>
      {t('Back to the patient')}
    </Button>
  );
}
