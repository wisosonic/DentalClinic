import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, InputAdornment, Link, MenuItem, Paper, Skeleton, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import EditIcon from '@mui/icons-material/Edit';
import ImageIcon from '@mui/icons-material/Image';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import SearchIcon from '@mui/icons-material/Search';
import VisibilityIcon from '@mui/icons-material/Visibility';
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
import { DocumentViewerDialog } from './DocumentViewer';
import { UploadDocumentsDialog } from './UploadDocumentsDialog';
import { TimeText } from '../../lib/useTime';

type SortKey = 'title' | 'kind' | 'taken' | 'by' | 'size' | 'visit';

const fileUrl = (d: PatientDocumentDto) => `/api/v1/documents/${d.id}/file`;
const thumbUrl = (d: PatientDocumentDto) => `/api/v1/documents/${d.id}/thumbnail`;

/** A small picture of a picture (or an icon for a PDF, or when no preview could be made). */
function Preview({ doc, onOpen }: { doc: PatientDocumentDto; onOpen: () => void }) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const box = { width: 48, height: 48, flexShrink: 0, borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.hover', overflow: 'hidden' } as const;
  if (!doc.isImage) return <Box sx={box} aria-hidden><PictureAsPdfIcon color="action" /></Box>;
  if (broken) return <Box sx={box} aria-hidden><ImageIcon color="action" /></Box>;
  return (
    <Box component="button" type="button" onClick={onOpen} aria-label={t('Open {{title}}', { title: doc.title })} sx={{ ...box, p: 0, border: 0, cursor: 'pointer' }}>
      <Box component="img" src={thumbUrl(doc)} alt="" loading="lazy" onError={() => setBroken(true)} sx={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </Box>
  );
}

function EditDocumentDialog({ doc, onClose }: { doc: PatientDocumentDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [update, state] = useUpdateDocumentMutation();
  const [title, setTitle] = useState(doc.title);
  const [category, setCategory] = useState<string>(doc.category);
  const [takenOn, setTakenOn] = useState(doc.takenOn ?? '');
  const [note, setNote] = useState(doc.note ?? '');
  const [patientVisible, setPatientVisible] = useState(doc.patientVisible);
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = async () => {
    const { data, errors: found } = validate(documentUpdateSchema, { title, category, takenOn, note, patientVisible });
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
        <FormControlLabel
          control={<Checkbox checked={patientVisible} onChange={(e) => setPatientVisible(e.target.checked)} />}
          label={t('Visible to the patient')}
        />
        <Typography variant="caption" color="text.secondary" display="block">{t('Patients will see the documents marked this way in their portal, which is not available yet.')}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={state.isLoading}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={state.isLoading}>{state.isLoading ? t('Saving…') : t('Save changes')}</Button>
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
  const [tag, setTag] = useState('');
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const q = useDebounce(search.trim());
  const sort = useSort<SortKey>('taken', 'desc');
  const { data, error, isFetching } = useListDocumentsQuery({ patientId, category: category || undefined, q: q || undefined, tag: tag || undefined });
  const [remove, removeState] = useDeleteDocumentMutation();
  // The page may own the "Add documents" button (in its header, like Payments); on its own the section shows the button itself.
  const [addingInside, setAddingInside] = useState(false);
  const external = onAddingChange !== undefined;
  const adding = external ? !!addingFromOutside : addingInside;
  const setAdding = external ? onAddingChange : setAddingInside;
  const [editing, setEditing] = useState<PatientDocumentDto | null>(null);
  const [deleting, setDeleting] = useState<PatientDocumentDto | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  // The tags seen so far, so the filter still lists them while it is narrowing the list.
  useEffect(() => {
    const seen = (data?.data ?? []).flatMap((d) => d.tags);
    if (seen.length) setKnownTags((known) => [...new Set([...known, ...seen])].sort((x, y) => x.localeCompare(y)));
  }, [data]);

  const value: Record<SortKey, (d: PatientDocumentDto) => string | number | null> = {
    title: (d) => d.title, kind: (d) => d.category, taken: (d) => d.takenOn, by: (d) => d.uploadedBy?.name ?? null, size: (d) => d.sizeBytes,
    visit: (d) => (d.appointment ? `${d.appointment.date} ${d.appointment.time}` : null),
  };
  const rows = sortRows(data?.data ?? [], value[sort.key], sort.order);
  const openAt = (d: PatientDocumentDto) => setViewing(rows.findIndex((r) => r.id === d.id));

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
        {knownTags.length > 0 && (
          <TextField select label={t('Tag')} value={tag} onChange={(e) => setTag(e.target.value)} margin="none" size="small" sx={{ minWidth: 140 }}>
            <MenuItem value="">{t('All')}</MenuItem>
            {knownTags.map((x) => <MenuItem key={x} value={x}>{x}</MenuItem>)}
          </TextField>
        )}
        {!external && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>{t('Add documents')}</Button>}
      </Box>
      {error != null && <Alert severity="error" sx={{ mb: 1 }}>{errorMessage(error)}</Alert>}
      {removeState.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(removeState.error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={90} aria-label={t('Loading')} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}><Typography color="text.secondary">{category || q || tag ? t('No documents match.') : t('No documents yet.')}</Typography></Paper>
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
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <Preview doc={d} onOpen={() => openAt(d)} />
                    <Box sx={{ minWidth: 0 }}>
                    {d.isImage ? (
                      <Link component="button" type="button" underline="hover" onClick={() => openAt(d)} sx={{ textAlign: 'start' }}>{d.title}</Link>
                    ) : (
                      <Link href={fileUrl(d)} target="_blank" rel="noopener" underline="hover">{d.title}</Link>
                    )}
                    {d.note && <Typography variant="caption" color="text.secondary" display="block">{d.note}</Typography>}
                    {(d.tags.length > 0 || d.commentCount > 0 || d.annotationCount > 0) && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                        {d.tags.map((x) => <Chip key={x} size="small" variant="outlined" label={x} onClick={() => setTag(x)} />)}
                        {d.annotationCount > 0 && <Chip size="small" variant="outlined" icon={<PlaceOutlinedIcon />} label={d.annotationCount} aria-label={t('{{n}} marks on the picture', { n: d.annotationCount })} />}
                        {d.commentCount > 0 && <Chip size="small" variant="outlined" icon={<ChatBubbleOutlineIcon />} label={d.commentCount} aria-label={t('{{n}} comments', { n: d.commentCount })} />}
                      </Box>
                    )}
                    {d.patientVisible && <Chip size="small" icon={<VisibilityIcon />} label={t('Visible to the patient')} sx={{ mt: 0.5 }} />}
                    </Box>
                    </Box>
                  </TableCell>
                  <TableCell><Chip size="small" icon={d.isImage ? <ImageIcon /> : <PictureAsPdfIcon />} label={t(DOCUMENT_CATEGORY_LABEL[d.category])} /></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{d.takenOn ? formatDate(d.takenOn) : '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{d.appointment ? <>{formatDate(d.appointment.date)} <TimeText value={d.appointment.time} /></> : '—'}</TableCell>
                  <TableCell>{d.uploadedBy?.name || '—'}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}><bdi dir="ltr">{formatBytes(d.sizeBytes)}</bdi></TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title={t('Comments, tags and marks')}>
                      <IconButton size="small" aria-label={t('Comments, tags and marks of {{title}}', { title: d.title })} onClick={() => openAt(d)}><ChatBubbleOutlineIcon fontSize="small" /></IconButton>
                    </Tooltip>
                    <Tooltip title={t('Open')}>
                      <IconButton
                        size="small" aria-label={t('Open {{title}}', { title: d.title })}
                        {...(d.isImage ? { onClick: () => openAt(d) } : { component: 'a', href: fileUrl(d), target: '_blank', rel: 'noopener' })}
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
      {viewing !== null && viewing >= 0 && rows[viewing] && <DocumentViewerDialog docs={rows} index={viewing} onClose={() => setViewing(null)} onMove={setViewing} />}
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete this document?')}
        message={t('The document goes to the Trash. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete document')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </Box>
  );
}
