import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import LockResetIcon from '@mui/icons-material/LockReset';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { AuthCard } from '../components/AuthCard';

/** The clinic sends no email, so a forgotten password is fixed by an admin, who hands over a link. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  return (
    <AuthCard title={t('Forgot your password?')} subtitle={t('The clinic does not send emails, so an admin has to reset it for you.')}>
      <Alert severity="info" icon={<LockResetIcon />} sx={{ mt: 2 }}>
        <Typography variant="body2" component="div">
          {t('Ask the clinic to reset your password. They will give you a link or a temporary password in person or by phone.')}
        </Typography>
      </Alert>
      <Button component={RouterLink} to="/login" variant="contained" fullWidth sx={{ mt: 3 }}>
        {t('Back to sign in')}
      </Button>
    </AuthCard>
  );
}
