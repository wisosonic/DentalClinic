import { useRef, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, MenuItem, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useTranslation } from 'react-i18next';
import { DOCUMENT_CATEGORIES, DOCUMENT_MIME_TYPES, type DocumentCategory } from '@aya/shared';
import { useGetConfigQuery } from '../clinical/clinicalApi';
import { errorMessage } from '../../lib/baseQuery';
import { formatBytes } from '../../lib/format';
import { DOCUMENT_CATEGORY_LABEL } from './labels';
import { useUploadDocumentMutation } from './documentsApi';

interface Draft {
  key: number;
  file: File;
  category: DocumentCategory;
  title: string;
  takenOn: string;
  note: string;
  patientVisible: boolean;
  state: 'ready' | 'sending' | 'done' | 'failed';
  problem?: string;
  duplicate?: boolean;
}

let nextKey = 1;
const stem = (name: string) => name.replace(/\.[^.]+$/, '').slice(0, 120);

/**
 * Adds one or more files to a patient: each with its own kind, title and date, sent one after another. The type and
 * size are checked here for a quick answer; the server checks them again from the file itself.
 */
export function UploadDocumentsDialog({ open, onClose, patientId, today }: { open: boolean; onClose: () => void; patientId: number; today: string }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [upload] = useUploadDocumentMutation();
  const { data: config } = useGetConfigQuery();
  const maxMb = config?.documents?.maxMb ?? 25; // the clinic's limit (Settings > Uploads)
  const sharedByDefault = config?.documents?.visibleByDefault ?? false; // Settings > Patient portal
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const reset = () => { setDrafts([]); setRejected([]); };
  const close = () => { if (!busy) { reset(); onClose(); } };
  const patch = (key: number, changes: Partial<Draft>) => setDrafts((l) => l.map((d) => (d.key === key ? { ...d, ...changes } : d)));

  const choose = (files: FileList | null) => {
    if (!files) return;
    const bad: string[] = [];
    const good: Draft[] = [];
    for (const file of Array.from(files)) {
      if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)) bad.push(t('{{name}}: only PNG, JPEG, WebP and PDF files can be added', { name: file.name }));
      else if (file.size > maxMb * 1024 * 1024) bad.push(t('{{name}}: the file must be smaller than {{mb}} MB', { name: file.name, mb: maxMb }));
      else good.push({ key: nextKey++, file, category: file.type === 'application/pdf' ? 'other' : 'xray', title: stem(file.name), takenOn: today, note: '', patientVisible: sharedByDefault, state: 'ready' });
    }
    setRejected(bad);
    setDrafts((l) => [...l, ...good]);
    if (input.current) input.current.value = '';
  };

  const send = async (d: Draft, allowDuplicate = false) => {
    patch(d.key, { state: 'sending', problem: undefined, duplicate: false });
    const result = await upload({ patientId, file: d.file, category: d.category, title: d.title.trim(), takenOn: d.takenOn || undefined, note: d.note.trim() || undefined, patientVisible: d.patientVisible, allowDuplicate });
    if ('error' in result && result.error) {
      const code = (result.error as { data?: { error?: { code?: string } } }).data?.error?.code;
      patch(d.key, { state: 'failed', problem: errorMessage(result.error), duplicate: code === 'DUPLICATE_DOCUMENT' });
    } else patch(d.key, { state: 'done' });
  };

  const sendAll = async () => {
    setBusy(true);
    for (const d of drafts.filter((x) => x.state === 'ready' || x.state === 'failed')) {
      if (!d.title.trim()) { patch(d.key, { state: 'failed', problem: t('Give the document a title') }); continue; }
      await send(d); // one after another, so a slow connection is never asked for everything at once
    }
    setBusy(false);
  };

  const pending = drafts.filter((d) => d.state !== 'done').length;
  const allDone = drafts.length > 0 && pending === 0;

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="md">
      <DialogTitle>{t('Add documents')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {t('Pictures (PNG, JPEG, WebP) and PDF files, up to {{mb}} MB each. For a CBCT study, add its report as a PDF or screenshots of it.', { mb: maxMb })}
        </Typography>
        <input
          ref={input} type="file" multiple accept={DOCUMENT_MIME_TYPES.join(',')} hidden aria-label={t('Document files')}
          onChange={(e) => choose(e.target.files)}
        />
        <Button variant="outlined" startIcon={<CloudUploadIcon />} onClick={() => input.current?.click()} disabled={busy}>{t('Choose files')}</Button>
        {rejected.map((r) => <Alert key={r} severity="warning" sx={{ mt: 1 }}>{r}</Alert>)}

        <Stack spacing={1.5} sx={{ mt: 2 }}>
          {drafts.map((d, i) => (
            <Paper key={d.key} variant="outlined" sx={{ p: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
                <Typography variant="subtitle2" sx={{ flexGrow: 1, wordBreak: 'break-all' }}>{d.file.name} · {formatBytes(d.file.size)}</Typography>
                {d.state === 'sending' && <CircularProgress size={18} aria-label={t('Sending')} />}
                {d.state === 'done' && <Chip size="small" color="success" label={t('Added')} />}
                {d.state !== 'sending' && d.state !== 'done' && (
                  <Tooltip title={t('Remove')}><span><IconButton size="small" disabled={busy} aria-label={t('Remove {{name}}', { name: d.file.name })} onClick={() => setDrafts((l) => l.filter((x) => x.key !== d.key))}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
                )}
              </Box>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1.4fr 0.9fr' }, columnGap: 1.5 }}>
                <TextField
                  select label={t('Kind')} value={d.category} margin="dense" disabled={d.state === 'sending' || d.state === 'done'}
                  onChange={(e) => patch(d.key, { category: e.target.value as DocumentCategory })} slotProps={{ htmlInput: { 'aria-label': t('Kind of file {{n}}', { n: i + 1 }) } }}
                >
                  {DOCUMENT_CATEGORIES.map((c) => <MenuItem key={c} value={c}>{t(DOCUMENT_CATEGORY_LABEL[c])}</MenuItem>)}
                </TextField>
                <TextField
                  label={t('Title')} value={d.title} required margin="dense" disabled={d.state === 'sending' || d.state === 'done'}
                  onChange={(e) => patch(d.key, { title: e.target.value })} slotProps={{ htmlInput: { maxLength: 120, 'aria-label': t('Title of file {{n}}', { n: i + 1 }) } }}
                />
                <TextField
                  label={t('Taken on')} type="date" value={d.takenOn} margin="dense" disabled={d.state === 'sending' || d.state === 'done'}
                  onChange={(e) => patch(d.key, { takenOn: e.target.value })} slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'aria-label': t('Date of file {{n}}', { n: i + 1 }) } }}
                />
              </Box>
              <TextField
                label={t('Note (optional)')} value={d.note} margin="dense" size="small" disabled={d.state === 'sending' || d.state === 'done'}
                onChange={(e) => patch(d.key, { note: e.target.value })} slotProps={{ htmlInput: { maxLength: 500, 'aria-label': t('Note of file {{n}}', { n: i + 1 }) } }}
              />
              <FormControlLabel
                sx={{ display: 'flex' }} disabled={d.state === 'sending' || d.state === 'done'}
                control={<Checkbox size="small" checked={d.patientVisible} onChange={(e) => patch(d.key, { patientVisible: e.target.checked })} slotProps={{ input: { 'aria-label': t('Visible to the patient, file {{n}}', { n: i + 1 }) } }} />}
                label={<Typography variant="body2">{t('Visible to the patient')}</Typography>}
              />
              {d.state === 'failed' && (
                <Alert severity="error" role="alert" sx={{ mt: 0.5 }} action={d.duplicate ? <Button color="inherit" size="small" onClick={() => send(d, true)}>{t('Add it anyway')}</Button> : undefined}>
                  {d.problem}
                </Alert>
              )}
            </Paper>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>{allDone ? t('Close') : t('Cancel')}</Button>
        <Button variant="contained" onClick={sendAll} disabled={busy || pending === 0}>
          {busy ? t('Sending…') : drafts.length > 1 ? t('Add {{n}} documents', { n: pending }) : t('Add document')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
