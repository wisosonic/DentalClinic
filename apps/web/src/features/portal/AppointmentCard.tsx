import { useState } from 'react';
import { Alert, Box, Button, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import EventIcon from '@mui/icons-material/Event';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import { useTranslation } from 'react-i18next';
import type { PortalAppointmentDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, statusLabel } from '../../lib/format';
import { useAppointmentActionMutation } from '../clinical/clinicalApi';
import { TimeText } from '../../lib/useTime';

/**
 * One upcoming appointment, with its details and a way to cancel it while there is still enough notice. A patient
 * cannot book or move one: that is a phone call to the clinic, which the card says when cancelling is too late.
 */
export function AppointmentCard({ appointment: a, cancelMinHours }: { appointment: PortalAppointmentDto; cancelMinHours: number }) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const [cancel, state] = useAppointmentActionMutation();

  const confirm = async () => {
    await cancel({ id: a.id, action: 'cancel' });
    setCancelling(false); // on a refusal the card shows why
  };

  return (
    <Paper sx={{ p: 2.5, borderInlineStart: 4, borderInlineStartStyle: 'solid', borderInlineStartColor: a.status === 'confirmed' ? 'primary.main' : 'warning.main' }}>
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" sx={{ mb: 0.5 }}>
        <EventIcon color="primary" fontSize="small" />
        <Typography variant="h6" component="h3" sx={{ flexGrow: 1 }}>
          {formatDate(a.date)} · <TimeText value={a.time} />
        </Typography>
        <Chip size="small" color={a.status === 'confirmed' ? 'primary' : 'warning'} label={statusLabel(a.status)} />
      </Stack>
      <Typography>{t('With Dr. {{name}}', { name: `${a.doctor.fname} ${a.doctor.lname}` })} · {t('{{n}} minutes', { n: a.durationMinutes })}</Typography>
      {a.clinic && (
        <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-start', mt: 0.5 }}>
          <PlaceOutlinedIcon fontSize="small" />
          <span>
            {a.clinic.name}{a.clinic.address ? `, ${a.clinic.address}` : ''}
            {a.clinic.phone && <> · <Link href={`tel:${a.clinic.phone}`} underline="hover"><bdi dir="ltr">{a.clinic.phone}</bdi></Link></>}
          </span>
        </Typography>
      )}
      {a.procedures.length > 0 && (
        <Stack direction="row" gap={0.75} flexWrap="wrap" sx={{ mt: 1 }}>
          {a.procedures.map((p) => <Chip key={p} size="small" variant="outlined" label={p} />)}
        </Stack>
      )}

      <Box sx={{ mt: 1.5 }}>
        {state.error != null && <Alert severity="error" role="alert" sx={{ mb: 1 }}>{errorMessage(state.error)}</Alert>}
        {a.canCancel ? (
          <Button color="error" variant="outlined" onClick={() => { state.reset(); setCancelling(true); }}>{t('Cancel appointment')}</Button>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t('It is less than {{hours}} hours away, so it can only be changed by phone.', { hours: cancelMinHours })}
            {a.clinic?.phone && <> <Link href={`tel:${a.clinic.phone}`} underline="hover"><bdi dir="ltr">{a.clinic.phone}</bdi></Link></>}
          </Typography>
        )}
        {a.canCancel && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            {t('You can cancel it online until {{when}}.', { when: `${formatDate(a.cancelUntil.slice(0, 10))} ${a.cancelUntil.slice(11)}` })}
          </Typography>
        )}
      </Box>

      <ConfirmDialog
        open={cancelling} destructive title={t('Cancel this appointment?')}
        message={t('The clinic will be told. To book another time, please call the clinic.')}
        confirmLabel={t('Cancel appointment')} busy={state.isLoading} onClose={() => setCancelling(false)} onConfirm={confirm}
      />
    </Paper>
  );
}
