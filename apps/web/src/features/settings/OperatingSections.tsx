import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Paper, Skeleton, Switch, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { OPERATING_SCHEMAS, WEEK_STARTS, TIME_FORMATS, type OperatingGroup, type OperatingSettings } from '@aya/shared';
import { errorMessage } from '../../lib/baseQuery';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { EmptySection } from './SettingsLayout';
import { useOperatingSettingsQuery, useSaveOperatingSettingsMutation } from './operatingApi';

type Field =
  | { key: string; label: string; help?: string; kind: 'number'; unit?: string; step?: number }
  | { key: string; label: string; help?: string; kind: 'switch' }
  | { key: string; label: string; help?: string; kind: 'select'; options: { value: string; label: string }[] };

/**
 * One page of operating settings: its fields come down from the server with their current values, are checked here with
 * the same rules the server applies, and are saved together. The values are the clinic's own choice; the server's
 * environment only supplies where they start.
 */
export function OperatingForm<G extends OperatingGroup>({ group, title, intro, fields, children }: {
  group: G; title: string; intro?: string; fields: Field[]; children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { data, error, isLoading } = useOperatingSettingsQuery(group);
  const [save, state] = useSaveOperatingSettingsMutation();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  // Start again from what the server says whenever it changes.
  useEffect(() => {
    if (data) setValues(Object.fromEntries(Object.entries(data as unknown as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)])));
  }, [data]);

  const submit = async () => {
    setSaved(false);
    const { data: ok, errors: found } = validate(OPERATING_SCHEMAS[group], values);
    if (!ok) return setErrors(found!);
    setErrors({});
    const result = await save({ group, body: ok as Partial<OperatingSettings[G]> });
    if (result.data) setSaved(true);
  };
  const set = (key: string, value: string | boolean) => { setValues((v) => ({ ...v, [key]: value })); setErrors((e) => ({ ...e, [key]: '' })); setSaved(false); };

  return (
    <Paper component="section" aria-label={title} sx={{ p: 3, maxWidth: 860 }}>
      <Typography variant="h6" component="h2">{title}</Typography>
      {intro && <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>{intro}</Typography>}
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {state.error != null && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{errorMessage(state.error)}</Alert>}
      {isLoading || !data ? <Skeleton variant="rounded" height={140} aria-label={t('Loading')} /> : (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, columnGap: 3, rowGap: 0.5 }}>
            {fields.map((f) => f.kind === 'switch' ? (
              <Box key={f.key} sx={{ gridColumn: '1 / -1', mb: 1 }}>
                <FormControlLabel
                  control={<Switch checked={Boolean(values[f.key])} onChange={(e) => set(f.key, e.target.checked)} />}
                  label={f.label}
                />
                {f.help && <Typography variant="caption" color="text.secondary" display="block" sx={{ marginInlineStart: 6 }}>{f.help}</Typography>}
              </Box>
            ) : f.kind === 'select' ? (
              <TextField key={f.key} select label={f.label} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} error={!!errors[f.key]} helperText={errors[f.key] || f.help}>
                {f.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
              </TextField>
            ) : (
              <TextField
                key={f.key} type="number" label={f.label} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}
                error={!!errors[f.key]} helperText={errors[f.key] || f.help}
                slotProps={{ htmlInput: { inputMode: 'numeric', step: f.step ?? 1, dir: 'ltr' }, input: f.unit ? { endAdornment: <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{f.unit}</Typography> } : undefined }}
              />
            ))}
          </Box>
          {children}
          <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
            <Button variant="contained" onClick={submit} disabled={state.isLoading}>{state.isLoading ? t('Saving…') : t('Save')}</Button>
            {saved && <Typography role="status" color="success.main">{t('Saved')}</Typography>}
          </Box>
        </>
      )}
    </Paper>
  );
}

export function AppointmentsSection() {
  const { t } = useTranslation();
  return (
    <OperatingForm
      group="appointments" title={t('Appointments')} intro={t('How long a visit lasts, how late a patient may cancel online, and when reminders go out.')}
      fields={[
        { key: 'defaultDuration', kind: 'number', label: t('Default length of an appointment'), unit: t('minutes'), step: 15, help: t('In steps of 15 minutes. The booking form starts with this length.') },
        { key: 'cancelMinHours', kind: 'number', label: t('Notice to cancel online'), unit: t('hours'), help: t('A patient can cancel online only this long before the appointment. Inside it, they phone the clinic.') },
        { key: 'staffReminderMinutes', kind: 'number', label: t('Reminder for the doctor and the staff'), unit: t('minutes before'), help: t('For a confirmed appointment.') },
        { key: 'patientReminderHours', kind: 'number', label: t('Reminder for the patient'), unit: t('hours before'), help: t('Shown in the patient’s notifications.') },
      ]}
    />
  );
}

export function SecuritySection() {
  const { t } = useTranslation();
  return (
    <OperatingForm
      group="security" title={t('Security')} intro={t('Signing in and passwords. These apply to everyone who signs in, from the next time they do.')}
      fields={[
        { key: 'maxFailedLogins', kind: 'number', label: t('Failed sign-ins before an account locks'), help: t('Between 3 and 20.') },
        { key: 'lockoutMinutes', kind: 'number', label: t('How long an account stays locked'), unit: t('minutes') },
        { key: 'passwordMinLength', kind: 'number', label: t('Shortest password'), unit: t('characters'), help: t('Between 8 and 32. Existing passwords are not affected until changed.') },
        { key: 'rememberDays', kind: 'number', label: t('"Keep me signed in" lasts'), unit: t('days'), help: t('Without it, a sign-in lasts a week.') },
      ]}
    />
  );
}

export function PortalSection() {
  const { t } = useTranslation();
  return (
    <OperatingForm
      group="portal" title={t('Patient portal')} intro={t('What patients can see and do when they sign in with their patient card.')}
      fields={[
        { key: 'enabled', kind: 'switch', label: t('The patient portal is on'), help: t('Off: patients can sign in, but see only a notice, and cannot cancel online.') },
        { key: 'showPayments', kind: 'switch', label: t('Show patients their payments, receipts and balance'), help: t('Off: they see their treatment and its prices, but no money paid or owed.') },
        { key: 'documentsVisibleByDefault', kind: 'switch', label: t('Share new documents with the patient unless told otherwise'), help: t('What the "Visible to the patient" box starts as when a document is added. The person adding it can always change it.') },
      ]}
    />
  );
}

export function UploadsSection() {
  const { t } = useTranslation();
  return (
    <OperatingForm
      group="uploads" title={t('Uploads')} intro={t('Limits for the documents added to a patient (x-rays, reports, tests).')}
      fields={[
        { key: 'maxDocumentMb', kind: 'number', label: t('Biggest document'), unit: t('MB'), help: t('Between 1 and 100.') },
        { key: 'maxDocumentsPerPatient', kind: 'number', label: t('Most documents for one patient'), help: t('Between 1 and 1000.') },
      ]}
    />
  );
}

export function DisplaySection() {
  const { t } = useTranslation();
  const week: Record<(typeof WEEK_STARTS)[number], string> = { monday: 'Monday', sunday: 'Sunday', saturday: 'Saturday' };
  const time: Record<(typeof TIME_FORMATS)[number], string> = { '24h': '24-hour (14:30)', '12h': '12-hour (2:30 PM)' };
  return (
    <OperatingForm
      group="display" title={t('Date and time')} intro={t('How the calendar and times are shown on the screens. Printed documents are not affected.')}
      fields={[
        { key: 'weekStart', kind: 'select', label: t('The week starts on'), options: WEEK_STARTS.map((w) => ({ value: w, label: t(week[w]) })) },
        { key: 'timeFormat', kind: 'select', label: t('Times are shown as'), options: TIME_FORMATS.map((f) => ({ value: f, label: t(time[f]) })) },
      ]}
    />
  );
}

/** Nothing to set yet: the page exists so the settings have a place for it. */
export function TrashAuditSection() {
  const { t } = useTranslation();
  return <EmptySection title={t('Trash and activity log')} />;
}
