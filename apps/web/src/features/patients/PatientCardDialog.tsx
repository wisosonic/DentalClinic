import { useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useTranslation } from 'react-i18next';
import type { PatientDto } from '@aya/shared';
import { useAppDispatch } from '../../app/store';
import { errorMessage, readCookie } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { api } from '../auth/authApi';

/**
 * The patient card: the patient's details, their username and a first password to sign in with, which they must
 * change at the first sign-in. The first time it creates the patient's login; while the patient has not changed
 * the first password it makes a new one (the earlier card stops working); once the patient has chosen their own it
 * needs a confirmation, because it replaces that password and signs them out.
 *
 * The PDF is fetched here and kept in this component only (never in the app's store, which would keep the
 * password in memory longer), and is dropped when the dialog closes: the password cannot be shown again.
 */
export function PatientCardDialog({ open, onClose, patient }: { open: boolean; onClose: () => void; patient: PatientDto }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [card, setCard] = useState<{ url: string; name: string } | null>(null);
  const state = patient.loginState ?? 'none';

  // A new or reopened dialog starts clean, and an old card's address is released.
  useEffect(() => {
    if (open) { setConfirmed(false); setProblem(null); }
    return () => setCard((c) => { if (c) URL.revokeObjectURL(c.url); return null; });
  }, [open]);

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(new Request(`${window.location.origin}/api/v1/patients/${patient.id}/card`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': readCookie('csrf_token') ?? '' },
        body: JSON.stringify(state === 'active' ? { reset: true } : {}),
      }));
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setProblem(errorMessage({ status: response.status, data: body }));
        return;
      }
      const blob = await response.blob();
      setCard({ url: URL.createObjectURL(blob), name: `patient-card-${patient.patientIdentifier}.pdf` });
      dispatch(api.util.invalidateTags(['Patient'])); // the page now shows that the patient has a login
    } catch {
      setProblem(errorMessage({ status: 'FETCH_ERROR' }));
    } finally {
      setBusy(false);
    }
  };

  const close = () => { if (!busy) onClose(); };
  const mustConfirm = state === 'active' && !confirmed;

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <DialogTitle>{t('Patient card')}</DialogTitle>
      <DialogContent>
        <Typography sx={{ mb: 1 }}>{fullName(patient)} · <bdi dir="ltr">{patient.patientIdentifier}</bdi></Typography>
        <Typography variant="caption" color="text.secondary" display="block">{t('Username')}</Typography>
        <Typography sx={{ mb: 2, fontFamily: 'monospace', fontWeight: 700 }} dir="ltr">{patient.username ?? t('Made when the card is created')}</Typography>

        {problem && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{problem}</Alert>}

        {card ? (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>
              {t('The card is ready. Its first password is printed on it only and cannot be shown again: hand the card to the patient.')}
            </Alert>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button variant="contained" component="a" href={card.url} target="_blank" rel="noopener" startIcon={<OpenInNewIcon />}>{t('Open the card')}</Button>
              <Button component="a" href={card.url} download={card.name} startIcon={<DownloadIcon />}>{t('Download')}</Button>
            </Box>
          </>
        ) : (
          <>
            {state === 'none' && <Typography>{t('This creates the patient’s login: their username and a first password, printed on the card. They must change the password the first time they sign in.')}</Typography>}
            {state === 'waiting' && (
              <Alert severity="info">{t('The patient has not changed the first password yet. A new card makes a new first password, and the one on the earlier card stops working.')}</Alert>
            )}
            {state === 'active' && (
              <>
                <Alert severity="warning" sx={{ mb: 1 }}>
                  {t('The patient has already chosen their own password. A new card replaces it with a new first password and signs the patient out everywhere.')}
                </Alert>
                <FormControlLabel control={<Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />} label={t('I understand: replace the patient’s password')} />
              </>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>{card ? t('Close') : t('Cancel')}</Button>
        {!card && (
          <Button variant="contained" onClick={create} disabled={busy || mustConfirm}>
            {busy ? t('Making the card…') : state === 'none' ? t('Create the card') : t('Make a new card')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
