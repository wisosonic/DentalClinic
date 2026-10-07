import { useState } from 'react';
import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { errorMessage } from '../../lib/baseQuery';
import { useGetWaitingScreenQuery, useResetWaitingScreenMutation } from './waitingApi';

/** Settings > Waiting room: the address to open on the screen in the waiting room. */
export function WaitingScreenSection() {
  const { t } = useTranslation();
  const { data, error } = useGetWaitingScreenQuery();
  const [make, state] = useResetWaitingScreenMutation();
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = data?.path ? `${window.location.origin}${data.path}` : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false); // the address is in the box: it can be copied by hand
    }
  };

  return (
    <Paper component="section" aria-label={t('Waiting room')} sx={{ p: 3, maxWidth: 860 }}>
      <Typography variant="h6" component="h2">{t('Waiting room screen')}</Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        {t('Open this address in the browser of the screen in the waiting room. It shows the numbers being called and the dental unit to go to, never a name. Nobody has to sign in on it, so keep the address to yourselves.')}
      </Typography>
      {error != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {state.error != null && <Alert severity="error" role="alert" sx={{ mb: 2 }}>{errorMessage(state.error)}</Alert>}
      {data && !data.path ? (
        <>
          <Alert severity="info" sx={{ mb: 2 }}>{t('There is no address yet.')}</Alert>
          <Button variant="contained" disabled={state.isLoading} onClick={() => make()}>{t('Make the address')}</Button>
        </>
      ) : data ? (
        <>
          <TextField label={t('Screen address')} value={url} slotProps={{ input: { readOnly: true }, htmlInput: { dir: 'ltr', onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select() } }} />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
            <Button variant="contained" startIcon={<ContentCopyIcon />} onClick={copy}>{copied ? t('Copied') : t('Copy the address')}</Button>
            <Button component="a" href={data.path ?? '#'} target="_blank" rel="noopener" startIcon={<OpenInNewIcon />}>{t('Open the screen')}</Button>
            <Box sx={{ flexGrow: 1 }} />
            <Button color="error" disabled={state.isLoading} onClick={() => setAsking(true)}>{t('Make a new address')}</Button>
          </Box>
        </>
      ) : null}
      <ConfirmDialog
        open={asking} destructive title={t('Make a new address?')}
        message={t('The screen now showing the numbers will stop working until you open the new address on it.')}
        confirmLabel={t('Make a new address')} busy={state.isLoading} onClose={() => setAsking(false)}
        onConfirm={async () => { await make(); setAsking(false); setCopied(false); }}
      />
    </Paper>
  );
}
