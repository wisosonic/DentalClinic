import { Alert, Snackbar, Stack } from '@mui/material';
import { useAppDispatch, useAppSelector } from '../../app/store';
import { toastClosed } from './toast';

/** Shows the latest confirmations at the bottom of the screen; each fades away on its own. */
export function Toaster() {
  const toasts = useAppSelector((s) => s.toast);
  const dispatch = useAppDispatch();
  return (
    <Stack
      aria-live="polite"
      sx={{ position: 'fixed', insetInline: 0, bottom: 16, alignItems: 'center', gap: 1, zIndex: (t) => t.zIndex.snackbar, pointerEvents: 'none' }}
    >
      {toasts.map((toast) => (
        <Snackbar
          key={toast.id} open autoHideDuration={3500} sx={{ position: 'static', transform: 'none', pointerEvents: 'auto' }}
          onClose={(_e, reason) => reason !== 'clickaway' && dispatch(toastClosed(toast.id))}
        >
          <Alert severity="success" variant="filled" role="status" onClose={() => dispatch(toastClosed(toast.id))} sx={{ boxShadow: 6, minWidth: 220 }}>
            {toast.message}
          </Alert>
        </Snackbar>
      ))}
    </Stack>
  );
}
