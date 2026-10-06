import { zodResolver } from '@hookform/resolvers/zod';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { passwordSchema } from '@aya/shared';
import { z } from 'zod';
import { AuthCard } from '../components/AuthCard';
import { useChangePasswordMutation, useGetMeQuery, useLogoutMutation } from '../features/auth/authApi';
import { errorMessage } from '../lib/baseQuery';

const schema = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password'), newPassword: passwordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Values = z.infer<typeof schema>;

export function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: user } = useGetMeQuery();
  const [change, { isLoading, error }] = useChangePasswordMutation();
  const [logout] = useLogoutMutation();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { currentPassword: '', newPassword: '', confirm: '' } });

  const forced = user?.mustChangePassword;

  const onSubmit = handleSubmit(async (v) => {
    const result = await change({ currentPassword: v.currentPassword, newPassword: v.newPassword });
    if (result.data) navigate('/', { replace: true });
  });

  return (
    <AuthCard
      title={t('Change password')}
      subtitle={forced ? undefined : t('Other devices will be signed out when you change it.')}
    >
      {forced && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          {t('You must set a new password before continuing.')}
        </Alert>
      )}
      <form onSubmit={onSubmit} noValidate>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }} role="alert">
            {errorMessage(error)}
          </Alert>
        )}
        <TextField
          label={t('Current password')}
          type="password"
          autoComplete="current-password"
          autoFocus
          error={!!errors.currentPassword}
          helperText={errors.currentPassword?.message ? t(errors.currentPassword.message) : undefined}
          slotProps={{ htmlInput: { dir: 'ltr' } }}
          {...register('currentPassword')}
        />
        <TextField
          label={t('New password')}
          type="password"
          autoComplete="new-password"
          error={!!errors.newPassword}
          helperText={errors.newPassword?.message ? t(errors.newPassword.message) : t('At least 10 characters')}
          slotProps={{ htmlInput: { dir: 'ltr' } }}
          {...register('newPassword')}
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
          {isLoading ? t('Saving…') : t('Change password')}
        </Button>
        <Button
          fullWidth
          sx={{ mt: 1 }}
          onClick={async () => {
            if (!forced) return navigate('/');
            await logout();
            navigate('/login', { replace: true });
          }}
        >
          {forced ? t('Sign out') : t('Cancel')}
        </Button>
      </form>
    </AuthCard>
  );
}
