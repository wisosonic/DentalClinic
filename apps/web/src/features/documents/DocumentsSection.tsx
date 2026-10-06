import { useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, Link, MenuItem, Paper, Skeleton, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import ImageIcon from '@mui/icons-material/Image';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { DOCUMENT_CATEGORIES, documentUpdateSchema, type PatientDocumentDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { formatBytes, formatDate } from '../../lib/format';
import { useDebounce } from '../../lib/useDebounce';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useDeleteDocumentMutation, useListDocumentsQuery, useUpdateDocumentMutation } from './documentsApi';
import { DOCUMENT_CATEGORY_LABEL } from './labels';
import { UploadDocumentsDialog } from './UploadDocumentsDialog';

type SortKey = 'title' | 'kind' | 'taken' | 'by' | 'size' | 'visit';

const fileUrl = (d: PatientDocumentDto) => `/api/v1/documents/${d.id}/file`;

function EditDocumentDialog({ doc, onClose }: { doc: PatientDocumentDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [update, state] = useUpdateDocumentMutation();
  const [title, setTitle] = useState(doc.title);
  const [category, setCategory] = useState<string>(doc.category);
  const [takenOn, setTakenOn] = useState(doc.takenOn ?? '');
  const [note, setNote] = useState(doc.note ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = async () => {
    const { data, errors: found } = validate(documentUpdateSchema, { title, category, takenOn, note });
    if (!data) return setErrors(found!);
    const result = await update({ id: doc.id, body: data });
    if (!('error' in result && result.error)) onClose();
  };
  const field = (key: string) => ({ error: !!errors[key], helperText: errors[key] || undefined });

  return (
    <Dialog open onClose={state.isLoading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('Edit document')}</DialogTitle>
      <DialogContent>
        {state.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(state.error)}</Alert>}
        <TextField label={t('Title')} value={title} required onChange={(e) => { setTitle(e.target.value); setErrors((x) => ({ ...x, title: '' })); }} {...field('title')} />
        <TextField select label={t('Kind')} value={category} onChange={(e) => setCategory(e.target.value)} {...field('category')}>
          {DOCUMENT_CATEGORIES.map((c) => <MenuItem key={c} value={c}>{t(DOCUMENT_CATEGORY_LABEL[c])}</MenuItem>)}
        </TextField>
        <TextField label={t('Taken on')} type="date" value={takenOn} onChange={(e) => setTakenOn(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} {...field('takenOn')} />
        <TextField label={t('Note (optional)')} value={note} onChange={(e) => setNote(e.target.value)} multiline minRows={2} {...field('note')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={state.isLoading}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={state.isLoading}>{state.isLoading ? t('Saving…') : t('Save changes')}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** A picture, larger, with the previous and next picture of the list. */
function ViewerDialog({ docs, index, onClose, onMove }: { docs: PatientDocumentDto[]; index: number; onClose: () => void; onMove: (index: number) => void }) {
  const { t } = useTranslation();
  const doc = docs[index]!;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>{doc.title}</Box>
        <Chip size="small" label={t(DOCUMENT_CATEGORY_LABEL[doc.category])} />
      </DialogTitle>
      <DialogContent sx={{ textAlign: 'center' }}>
        <Box component="img" src={fileUrl(doc)} alt={doc.title} sx={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
        {doc.note && <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>{doc.note}</Typography>}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button disabled={index === 0} onClick={() => onMove(index - 1)}>{t('Previous')}</Button>
        <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>{index + 1} / {docs.length}</Typography>
        <Button disabled={index === docs.length - 1} onClick={() => onMove(index + 1)}>{t('Next')}</Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button component="a" href={fileUrl(doc)} target="_blank" rel="noopener" startIcon={<OpenInNewIcon />}>{t('Open in a new tab')}</Button>
        <Button onClick={onClose}>{t('Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * A patient's documents (x-ray, panoramic, CBCT report, blood analysis, anything else): filter, open, add,
 * change and delete. Pictures open in a viewer, PDF files in a new tab. The uploader and admin change or delete.
 */
export function DocumentsSection({
  patientId, today, showTitle = true, adding: addingFromOutside, onAddingChange,
}: { patientId: number; today: string; showTitle?: boolean; adding?: boolean; onAddingChange?: (adding: boolean) => void }) {
  const { t } = useTranslation();
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim());
  const sort = useSort<SortKey>('taken', 'desc');
  const { data, error, isFetching } = useListDocumentsQuery({ patientId, category: category || undefined, q: q || undefined });
  const [remove, removeState] = useDeleteDocumentMutation();
  // The page may own the "Add documents" button (in its header, like Payments); on its own the section shows the button itself.
  const [addingInside, setAddingInside] = useState(false);
  const external = onAddingChange !== undefined;
  const adding = external ? !!addingFromOutside : addingInside;
  const setAdding = external ? onAddingChange : setAddingInside;
  const [editing, setEditing] = useState<PatientDocumentDto | null>(null);
  const [deleting, setDeleting] = useState<PatientDocumentDto | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  const value: Record<SortKey, (d: PatientDocumentDto) => string | number | null> = {
    title: (d) => d.title, kind: (d) => d.category, taken: (d) => d.takenOn, by: (d) => d.uploadedBy?.name ?? null, size: (d) => d.sizeBytes,
    visit: (d) => (d.appointment ? `${d.appointment.date} ${d.appointment.time}` : null),
  };
  const rows = sortRows(data?.data ?? [], value[sort.key], sort.order);
  const pictures = rows.filter((d) => d.isImage);

  return (
    <Box component="section" aria-label={t('Documents')} sx={{ mb: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
        {showTitle ? <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>{t('Documents')}</Typography> : <Box sx={{ flexGrow: 1 }} />}
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search documents')} margin="none" size="small" sx={{ maxWidth: 240 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }, htmlInput: { 'aria-label': t('Search documents') } }}
        />
        <TextField select label={t('Kind')} value={category} onChange={(e) => setCategory(e.target.value)} margin="none" size="small" sx={{ minWidth: 150 }}>
          <MenuItem value="">{t('All')}</MenuItem>
          {DOCUMENT_CATEGORIES.map((c) => <MenuItem key={c} value={c}>{t(DOCUMENT_CATEGORY_LABEL[c])}</MenuItem>)}
        </TextField>
        {!external && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>{t('Add documents')}</Button>}
      </Box>
      {error != null && <Alert severity="error" sx={{ mb: 1 }}>{errorMessage(error)}</Alert>}
      {removeState.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(removeState.error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={90} aria-label={t('Loading')} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}><Typography color="text.secondary">{category || q ? t('No documents match.') : t('No documents yet.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small" aria-label={t('Documents')}>
            <TableHead>
              <TableRow>
                <SortCell field="title" sort={sort}>{t('Title')}</SortCell>
                <SortCell field="kind" sort={sort}>{t('Kind')}</SortCell>
                <SortCell field="taken" sort={sort}>{t('Taken on')}</SortCell>
                <SortCell field="visit" sort={sort}>{t('Visit')}</SortCell>
                <SortCell field="by" sort={sort}>{t('Added by')}</SortCell>
                <SortCell field="size" sort={sort} align="right">{t('Size')}</SortCell>
                <TableCell align="right">{t('Actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id} hover>
                  <TableCell>
                    {d.isImage ? (
                      <Link component="button" type="button" underline="hover" onClick={() => setViewing(pictures.findIndex((p) => p.id === d.id))} sx={{ textAlign: 'start' }}>{d.title}</Link>
                    ) : (
                      <Link href={fileUrl(d)} target="_blank" rel="noopener" underline="hover">{d.title}</Link>
                    )}
                    {d.note && <Typography variant="caption" color="text.secondary" display="block">{d.note}</Typography>}
                  </TableCell>
                  <TableCell><Chip size="small" icon={d.isImage ? <ImageIcon /> : <PictureAsPdfIcon />} label={t(DOCUMENT_CATEGORY_LABEL[d.category])} /></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{d.takenOn ? formatDate(d.takenOn) : '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{d.appointment ? <>{formatDate(d.appointment.date)} <bdi dir="ltr">{d.appointment.time}</bdi></> : '—'}</TableCell>
                  <TableCell>{d.uploadedBy?.name || '—'}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}><bdi dir="ltr">{formatBytes(d.sizeBytes)}</bdi></TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title={t('Open')}>
                      <IconButton
                        size="small" aria-label={t('Open {{title}}', { title: d.title })}
                        {...(d.isImage ? { onClick: () => setViewing(pictures.findIndex((p) => p.id === d.id)) } : { component: 'a', href: fileUrl(d), target: '_blank', rel: 'noopener' })}
                      ><OpenInNewIcon fontSize="small" /></IconButton>
                    </Tooltip>
                    {d.canChange && (
                      <>
                        <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit {{title}}', { title: d.title })} onClick={() => setEditing(d)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete {{title}}', { title: d.title })} onClick={() => { removeState.reset(); setDeleting(d); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <UploadDocumentsDialog open={adding} onClose={() => setAdding(false)} patientId={patientId} today={today} />
      {editing && <EditDocumentDialog doc={editing} onClose={() => setEditing(null)} />}
      {viewing !== null && viewing >= 0 && pictures[viewing] && <ViewerDialog docs={pictures} index={viewing} onClose={() => setViewing(null)} onMove={setViewing} />}
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete this document?')}
        message={t('The document goes to the Trash. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete document')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </Box>
  );
}
