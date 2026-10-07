import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { loginSchema } from '@aya/shared';
import { z } from 'zod';
import { AuthCard } from '../components/AuthCard';
import { useAppSelector } from '../app/store';
import { useGetMeQuery, useLoginMutation } from '../features/auth/authApi';
import { errorMessage } from '../lib/baseQuery';

// The form uses the shared schema's shape; `remember` is always present as a checkbox value.
type FormValues = z.input<typeof loginSchema>;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const expired = useAppSelector((s) => s.auth.expired);
  const { data: existing } = useGetMeQuery();
  const [login, { isLoading, error }] = useLoginMutation();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { identifier: '', password: '', remember: false },
  });

  // Already signed in (e.g. opened /login in a second tab).
  if (existing && !expired) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    const result = await login({ ...values, remember: values.remember ?? false });
    if (result.data) {
      navigate(result.data.mustChangePassword ? '/change-password' : from, { replace: true });
    }
  });

  return (
    <AuthCard title={t('Sign in')} subtitle={t('Use your clinic account to continue.')}>
      <form onSubmit={onSubmit} noValidate>
        {expired && !error && (
          <Alert severity="info" sx={{ mt: 2 }}>
            {t('Your session has ended. Please sign in again.')}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }} role="alert">
            {errorMessage(error)}
          </Alert>
        )}
        <TextField
          label={t('Email or username')}
          autoComplete="username"
          autoFocus
          error={!!errors.identifier}
          helperText={errors.identifier && t('Enter your email or username')}
          slotProps={{ htmlInput: { dir: 'ltr', autoCapitalize: 'none', spellCheck: false } }}
          {...register('identifier')}
        />
        <TextField
          label={t('Password')}
          type="password"
          autoComplete="current-password"
          error={!!errors.password}
          helperText={errors.password && t('Enter your password')}
          slotProps={{ htmlInput: { dir: 'ltr' } }}
          {...register('password')}
        />
        <FormControlLabel control={<Checkbox {...register('remember')} />} label={t('Keep me signed in on this device')} />
        <Button type="submit" variant="contained" fullWidth disabled={isLoading} sx={{ mt: 1 }}>
          {isLoading ? t('Signing in…') : t('Sign in')}
        </Button>
        <Link component={RouterLink} to="/forgot-password" variant="body2" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
          {t('Forgot your password?')}
        </Link>
      </form>
    </AuthCard>
  );
}
