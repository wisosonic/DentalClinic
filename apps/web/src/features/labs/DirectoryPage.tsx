import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, Paper, Skeleton, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { directoryInputSchema, type DirectoryDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { validate, type FieldErrors } from '../../lib/zodForm';
import {
  useCreateDirectoryEntryMutation, useDeleteDirectoryEntryMutation, useListDirectoryQuery, useUpdateDirectoryEntryMutation, type DirectoryKind,
} from './labsApi';

type SortKey = 'name' | 'contact' | 'phone' | 'address';

/** The wording of each directory; English text is the translation key. */
const WORDS = {
  labs: {
    title: 'Labs', add: 'New lab', addTitle: 'New lab', editTitle: 'Edit lab', search: 'Search labs', none: 'No labs yet.', noMatch: 'No labs match.',
    deleteTitle: 'Delete this lab?', deleteMessage: 'The lab is removed from the list. A lab that has orders or expenses cannot be deleted.', deleteLabel: 'Delete lab',
    add_: 'Add lab', blurb: 'The dental laboratories the clinic sends work to.',
  },
  suppliers: {
    title: 'Suppliers', add: 'New supplier', addTitle: 'New supplier', editTitle: 'Edit supplier', search: 'Search suppliers', none: 'No suppliers yet.', noMatch: 'No suppliers match.',
    deleteTitle: 'Delete this supplier?', deleteMessage: 'The supplier is removed from the list. A supplier that has expenses cannot be deleted.', deleteLabel: 'Delete supplier',
    add_: 'Add supplier', blurb: 'The companies the clinic buys materials and equipment from.',
  },
} as const;

function FormDialog({ kind, open, onClose, entry }: { kind: DirectoryKind; open: boolean; onClose: () => void; entry?: DirectoryDto }) {
  const { t } = useTranslation();
  const w = WORDS[kind];
  const [create, createState] = useCreateDirectoryEntryMutation();
  const [update, updateState] = useUpdateDirectoryEntryMutation();
  const busy = createState.isLoading || updateState.isLoading;
  const [values, setValues] = useState({ name: '', contact: '', phone: '', address: '', description: '' });
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!open) return;
    createState.reset();
    updateState.reset();
    setErrors({});
    setValues({ name: entry?.name ?? '', contact: entry?.contact ?? '', phone: entry?.phone ?? '', address: entry?.address ?? '', description: entry?.description ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry]);

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((x) => ({ ...x, [key]: '' }));
  };
  const field = (key: string) => ({ error: !!errors[key], helperText: errors[key] || undefined });

  const submit = async () => {
    const { data, errors: found } = validate(directoryInputSchema, values);
    if (!data) return setErrors(found!);
    const result = entry ? await update({ kind, id: entry.id, body: data }) : await create({ kind, body: data });
    if (!('error' in result && result.error)) onClose();
  };
  const error = createState.error ?? updateState.error;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t(entry ? w.editTitle : w.addTitle)}</DialogTitle>
      <DialogContent>
        {error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(error)}</Alert>}
        <TextField label={t('Name')} value={values.name} onChange={set('name')} required autoFocus {...field('name')} />
        <TextField label={t('Contact person (optional)')} value={values.contact} onChange={set('contact')} {...field('contact')} />
        <TextField label={t('Phone')} value={values.phone} onChange={set('phone')} required slotProps={{ htmlInput: { dir: 'ltr', inputMode: 'tel' } }} {...field('phone')} />
        <TextField label={t('Address (optional)')} value={values.address} onChange={set('address')} {...field('address')} />
        <TextField label={t('Notes (optional)')} value={values.description} onChange={set('description')} multiline minRows={2} {...field('description')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : entry ? t('Save changes') : t(w.add_)}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** The labs, or the suppliers: who they are and how to reach them. Staff and admins manage both. */
export function DirectoryPage({ kind }: { kind: DirectoryKind }) {
  const { t } = useTranslation();
  const w = WORDS[kind];
  const sort = useSort<SortKey>('name');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<'new' | DirectoryDto | null>(null);
  const [deleting, setDeleting] = useState<DirectoryDto | null>(null);
  const { data, isFetching, error } = useListDirectoryQuery(kind);
  const [remove, removeState] = useDeleteDirectoryEntryMutation();

  const needle = search.trim().toLowerCase();
  const filtered = (data ?? []).filter((r) => !needle || [r.name, r.contact, r.phone, r.address].some((v) => v?.toLowerCase().includes(needle)));
  const rows = sortRows(filtered, (r) => (sort.key === 'name' ? r.name : sort.key === 'contact' ? r.contact : sort.key === 'phone' ? r.phone : r.address), sort.order);

  return (
    <>
      <PageHeader
        title={t(w.title)} subtitle={t(w.blurb)}
        actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setForm('new')}>{t(w.add)}</Button>}
      />
      <Box sx={{ mb: 2 }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search by name, contact or phone')} margin="none" sx={{ maxWidth: 340 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t(w.search) } }}
        />
      </Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {removeState.error != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(removeState.error)}</Alert>}

      {!data && isFetching ? (
        <Skeleton variant="rounded" height={140} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t(data?.length ? w.noMatch : w.none)}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="name" sort={sort}>{t('Name')}</SortCell>
                <SortCell field="contact" sort={sort}>{t('Contact person')}</SortCell>
                <SortCell field="phone" sort={sort}>{t('Phone')}</SortCell>
                <SortCell field="address" sort={sort}>{t('Address')}</SortCell>
                <TableCell align="right">{t('Actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell sx={{ fontWeight: 600 }}>{r.name}</TableCell>
                  <TableCell>{r.contact || '—'}</TableCell>
                  <TableCell><bdi dir="ltr">{r.phone}</bdi></TableCell>
                  <TableCell>{r.address || '—'}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit {{name}}', { name: r.name })} onClick={() => setForm(r)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete {{name}}', { name: r.name })} onClick={() => { removeState.reset(); setDeleting(r); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <FormDialog kind={kind} open={!!form} onClose={() => setForm(null)} entry={form && form !== 'new' ? form : undefined} />
      <ConfirmDialog
        open={!!deleting} destructive title={t(w.deleteTitle)} message={t(w.deleteMessage)} confirmLabel={t(w.deleteLabel)}
        busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove({ kind, id: deleting!.id }); setDeleting(null); }}
      />
    </>
  );
}

export const LabsPage = () => <DirectoryPage kind="labs" />;
export const SuppliersPage = () => <DirectoryPage kind="suppliers" />;
