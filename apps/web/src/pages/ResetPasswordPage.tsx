import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { makePasswordSchema } from '@aya/shared';
import { z } from 'zod';
import { AuthCard } from '../components/AuthCard';
import { useResetPasswordMutation } from '../features/auth/authApi';
import { errorMessage } from '../lib/baseQuery';
import { usePublicSettingsQuery } from '../features/settings/settingsApi';

const makeSchema = (minLength: number) =>
  z
    .object({ password: makePasswordSchema(minLength), confirm: z.string() })
    .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Values = z.infer<ReturnType<typeof makeSchema>>;

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const [reset, { isLoading, isSuccess, error }] = useResetPasswordMutation();
  const minLength = usePublicSettingsQuery().data?.passwordMinLength ?? 10; // the clinic's rule, known before anyone signs in
  const schema = useMemo(() => makeSchema(minLength), [minLength]);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: '', confirm: '' } });

  return (
    <AuthCard title={t('Choose a new password')}>
      {isSuccess ? (
        <>
          <Alert severity="success" sx={{ mt: 2 }}>
            {t('Password updated. You can now sign in.')}
          </Alert>
          <Button component={RouterLink} to="/login" variant="contained" fullWidth sx={{ mt: 2 }}>
            {t('Go to sign in')}
          </Button>
        </>
      ) : (
        <form onSubmit={handleSubmit((v) => reset({ token, password: v.password }))} noValidate>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }} role="alert">
              {errorMessage(error)}
            </Alert>
          )}
          <TextField
            label={t('New password')}
            type="password"
            autoComplete="new-password"
            autoFocus
            error={!!errors.password}
            helperText={errors.password?.message ? t(errors.password.message) : t('At least 10 characters')}
            slotProps={{ htmlInput: { dir: 'ltr' } }}
            {...register('password')}
          />
          <TextField
            label={t('Confirm new password')}
            type="password"
            autoComplete="new-password"
            error={!!errors.confirm}
            helperText={errors.confirm?.message ? t(errors.confirm.message) : undefined}
            slotProps={{ htmlInput: { dir: 'ltr' } }}
            {...register('confirm')}
          />
          <Button type="submit" variant="contained" fullWidth disabled={isLoading} sx={{ mt: 1 }}>
            {isLoading ? t('Saving…') : t('Update password')}
          </Button>
          <Link component={RouterLink} to="/forgot-password" variant="body2" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
            {t('Request a new link')}
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
