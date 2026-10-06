import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, FormControl, FormControlLabel, FormLabel, MenuItem, Paper, Radio, RadioGroup, Skeleton, Switch, TextField, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { TEXT_SIZE_PX, appearanceSettingsSchema, generalSettingsSchema, type ColorMode, type SettingsLanguage, type TextSize } from '@aya/shared';
import { errorMessage } from '../../lib/baseQuery';
import { validate, type FieldErrors } from '../../lib/zodForm';
import {
  useAppearanceSettingsQuery, useGeneralSettingsQuery, useSaveAppearanceSettingsMutation, useSaveGeneralSettingsMutation,
} from './settingsApi';

/** Every timezone the browser knows, for choosing from; a short list when it cannot say. */
const timezones = (): string[] => {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    if (all?.length) return all.includes('UTC') ? all : ['UTC', ...all];
  } catch {
    // fall through to the short list
  }
  return ['UTC', 'Asia/Beirut', 'Europe/Paris', 'America/New_York'];
};

/** General: the language people start in, the clinic's timezone and its contact details. */
export function GeneralSection() {
  const { t } = useTranslation();
  const { data, error } = useGeneralSettingsQuery();
  const [save, saveState] = useSaveGeneralSettingsMutation();
  const zones = useMemo(timezones, []);
  const [language, setLanguage] = useState<SettingsLanguage>('en');
  const [timezone, setTimezone] = useState('');
  const [values, setValues] = useState({ address: '', phone: '', email: '' });
  const [switches, setSwitches] = useState({ reminders: true, events: true });
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!data) return;
    setSwitches(data.notifications);
    setLanguage(data.language);
    setTimezone(data.timezone);
    setValues({ address: data.clinic.address ?? '', phone: data.clinic.phone ?? '', email: data.clinic.email ?? '' });
    setErrors({});
  }, [data]);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((x) => ({ ...x, [`clinic.${key}`]: '' }));
  };
  const field = (k: string) => ({ error: !!errors[k], helperText: errors[k] || undefined });

  const submit = async () => {
    const { data: parsed, errors: found } = validate(generalSettingsSchema, { language, timezone, clinic: values, notifications: switches });
    if (!parsed) return setErrors(found!);
    setErrors({});
    await save(parsed);
  };

  return (
    <Paper component="section" aria-label={t('General')} sx={{ p: 3, maxWidth: 860 }}>
      <Typography variant="h6" component="h2">{t('General')}</Typography>
      {error && <Alert severity="error" sx={{ my: 1 }}>{errorMessage(error)}</Alert>}
      {saveState.error != null && <Alert severity="error" sx={{ my: 1 }} role="alert">{errorMessage(saveState.error)}</Alert>}
      {!data ? (
        <Skeleton variant="rounded" height={220} sx={{ mt: 2 }} aria-label={t('Loading')} />
      ) : (
        <>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 2, mb: 0.5 }}>{t('Language and time')}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, columnGap: 2 }}>
            <TextField
              select label={t('Default language')} value={language} onChange={(e) => setLanguage(e.target.value as SettingsLanguage)}
              helperText={t('Used for people who have not chosen a language with the language button.')}
            >
              <MenuItem value="en">English</MenuItem>
              <MenuItem value="ar" lang="ar">العربية</MenuItem>
            </TextField>
            <Autocomplete
              options={zones} value={timezone || data.timezone} disableClearable onChange={(_e, v) => { setTimezone(v); setErrors((x) => ({ ...x, timezone: '' })); }}
              renderInput={(params) => (
                <TextField
                  {...params} label={t('Timezone')} error={!!errors.timezone}
                  helperText={errors.timezone || t('“Today” and every appointment time are worked out in this timezone.')}
                  slotProps={{ htmlInput: { ...params.inputProps, dir: 'ltr' } }}
                />
              )}
            />
          </Box>

          <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 2, mb: 0.5 }}>{t('Clinic contact details')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('Printed at the top of treatment offers, receipts and visit summaries. A detail left empty keeps the one on the clinic’s own page.')}
          </Typography>
          <TextField label={t('Address')} value={values.address} onChange={set('address')} {...field('clinic.address')} />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, columnGap: 2 }}>
            <TextField label={t('Phone')} value={values.phone} onChange={set('phone')} slotProps={{ htmlInput: { dir: 'ltr', inputMode: 'tel' } }} {...field('clinic.phone')} />
            <TextField label={t('Email')} type="email" value={values.email} onChange={set('email')} slotProps={{ htmlInput: { dir: 'ltr' } }} {...field('clinic.email')} />
          </Box>

          <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 2, mb: 0.5 }}>{t('Notifications')}</Typography>
          <Typography variant="body2" color="text.secondary">{t('Notifications appear in the app, on the bell in the top bar.')}</Typography>
          <FormControlLabel
            control={<Switch checked={switches.reminders} onChange={(e) => setSwitches((x) => ({ ...x, reminders: e.target.checked }))} />}
            label={t('Appointment reminders (2 hours before, to the doctor and the staff)')} sx={{ display: 'flex' }}
          />
          <FormControlLabel
            control={<Switch checked={switches.events} onChange={(e) => setSwitches((x) => ({ ...x, events: e.target.checked }))} />}
            label={t('Other events: bookings and cancellations, offers and payments, overdue lab orders')} sx={{ display: 'flex' }}
          />

          <Button variant="contained" onClick={submit} disabled={saveState.isLoading} sx={{ mt: 2 }}>
            {saveState.isLoading ? t('Saving…') : t('Save settings')}
          </Button>
        </>
      )}
    </Paper>
  );
}

const SIZE_LABEL: Record<TextSize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

/** Appearance: light or dark, and the text size, for the whole clinic. */
export function AppearanceSection() {
  const { t } = useTranslation();
  const { data, error } = useAppearanceSettingsQuery();
  const [save, saveState] = useSaveAppearanceSettingsMutation();
  const [mode, setMode] = useState<ColorMode>('light');
  const [textSize, setTextSize] = useState<TextSize>('medium');
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!data) return;
    setMode(data.mode);
    setTextSize(data.textSize);
  }, [data]);

  const submit = async () => {
    const { data: parsed, errors: found } = validate(appearanceSettingsSchema, { mode, textSize });
    if (!parsed) return setErrors(found!);
    setErrors({});
    await save(parsed);
  };

  return (
    <Paper component="section" aria-label={t('Appearance')} sx={{ p: 3, maxWidth: 860 }}>
      <Typography variant="h6" component="h2">{t('Appearance')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('These apply to everyone who uses the app, on every device.')}</Typography>
      {error && <Alert severity="error" sx={{ my: 1 }}>{errorMessage(error)}</Alert>}
      {saveState.error != null && <Alert severity="error" sx={{ my: 1 }} role="alert">{errorMessage(saveState.error)}</Alert>}
      {!data ? (
        <Skeleton variant="rounded" height={160} aria-label={t('Loading')} />
      ) : (
        <>
          <FormControl error={!!errors.mode} sx={{ display: 'block', mt: 1 }}>
            <FormLabel id="mode-label" sx={{ fontWeight: 700 }}>{t('Theme')}</FormLabel>
            <RadioGroup row aria-labelledby="mode-label" value={mode} onChange={(e) => setMode(e.target.value as ColorMode)}>
              <FormControlLabel value="light" control={<Radio />} label={t('Light')} />
              <FormControlLabel value="dark" control={<Radio />} label={t('Dark')} />
            </RadioGroup>
          </FormControl>

          <FormControl error={!!errors.textSize} sx={{ display: 'block', mt: 1 }}>
            <FormLabel id="size-label" sx={{ fontWeight: 700 }}>{t('Text size')}</FormLabel>
            <RadioGroup row aria-labelledby="size-label" value={textSize} onChange={(e) => setTextSize(e.target.value as TextSize)}>
              {(['small', 'medium', 'large'] as const).map((s) => (
                <FormControlLabel key={s} value={s} control={<Radio />} label={<span style={{ fontSize: TEXT_SIZE_PX[s] }}>{t(SIZE_LABEL[s])}</span>} />
              ))}
            </RadioGroup>
          </FormControl>

          <Button variant="contained" onClick={submit} disabled={saveState.isLoading} sx={{ mt: 2 }}>
            {saveState.isLoading ? t('Saving…') : t('Save settings')}
          </Button>
        </>
      )}
    </Paper>
  );
}
