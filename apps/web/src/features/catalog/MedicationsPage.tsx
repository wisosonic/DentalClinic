import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, Paper, Table,
  TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { medicationInputSchema, type MedicationDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { PageHeader } from '../../components/PageHeader';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { validate, type FieldErrors } from '../../lib/zodForm';
import {
  useCreateMedicationMutation, useDeleteMedicationMutation, useGetMedicationsQuery, useUpdateMedicationMutation,
} from '../clinical/clinicalApi';

const TYPES = ['tablet', 'capsule', 'syrup', 'injection', 'cream', 'gel', 'mouthwash', 'drops'];

function MedicationDialog({ open, medication, onClose }: { open: boolean; medication?: MedicationDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, createState] = useCreateMedicationMutation();
  const [update, updateState] = useUpdateMedicationMutation();
  const busy = createState.isLoading || updateState.isLoading;

  useEffect(() => {
    if (!open) return;
    setName(medication?.name ?? '');
    setType(medication?.type ?? '');
    setErrors({});
    createState.reset();
    updateState.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, medication]);

  const submit = async () => {
    const { data, errors: found } = validate(medicationInputSchema, { name, type });
    if (!data) return setErrors(found!);
    const result = medication ? await update({ id: medication.id, body: data }) : await create(data);
    if (!result.error) onClose();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{medication ? t('Edit medication') : t('Add medication')}</DialogTitle>
      <DialogContent>
        {(createState.error ?? updateState.error) != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(createState.error ?? updateState.error)}</Alert>}
        <TextField
          label={t('Name')} value={name} onChange={(e) => { setName(e.target.value); setErrors({}); }} autoFocus required
          error={!!errors.name} helperText={errors.name || t('For example Amoxicillin 500 mg')}
        />
        <Autocomplete
          freeSolo options={TYPES} inputValue={type} onInputChange={(_e, v) => setType(v)}
          renderInput={(params) => <TextField {...params} label={t('Form (optional)')} helperText={t('Tablet, capsule, syrup...')} />}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** The list doctors prescribe from. Names only: this is not a stock list. */
export function MedicationsPage() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  const { data: medications = [], isLoading, error } = useGetMedicationsQuery();
  const [remove, removeState] = useDeleteMedicationMutation();
  const sort = useSort<'name' | 'form'>('name');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<MedicationDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MedicationDto | null>(null);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const found = q ? medications.filter((m) => m.name.toLowerCase().includes(q) || (m.type ?? '').toLowerCase().includes(q)) : medications;
    return sortRows(found, (m) => (sort.key === 'name' ? m.name : m.type), sort.order);
  }, [medications, search, sort.key, sort.order]);

  return (
    <>
      <PageHeader
        title={t('Medications')}
        subtitle={t('The list doctors prescribe from')}
        actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>{t('Add medication')}</Button>}
      />
      <TextField
        value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search medications')} margin="none" sx={{ mb: 2, maxWidth: 420 }} fullWidth
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t('Search medications') } }}
      />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {removeState.error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(removeState.error)}</Alert>}

      {!isLoading && shown.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography>{search ? t('No medication matches your search.') : t('No medications yet. Add the ones you prescribe.')}</Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead><TableRow><SortCell field="name" sort={sort}>{t('Name')}</SortCell><SortCell field="form" sort={sort}>{t('Form')}</SortCell><TableCell align="right">{t('Actions')}</TableCell></TableRow></TableHead>
            <TableBody>
              {shown.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.name}</TableCell>
                  <TableCell>{m.type ?? '—'}</TableCell>
                  <TableCell align="right">
                    <Tooltip title={t('Edit')}><IconButton aria-label={t('Edit {{name}}', { name: m.name })} onClick={() => setEditing(m)}><EditIcon /></IconButton></Tooltip>
                    {isAdmin && <Tooltip title={t('Delete')}><IconButton aria-label={t('Delete {{name}}', { name: m.name })} onClick={() => { removeState.reset(); setDeleting(m); }}><DeleteOutlineIcon /></IconButton></Tooltip>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Box sx={{ mt: 1 }}><Typography variant="caption" color="text.secondary">{medications.length === 1 ? t('1 medication') : t('{{n}} medications', { n: medications.length })}</Typography></Box>

      <MedicationDialog open={!!editing} medication={editing && editing !== 'new' ? editing : undefined} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete {{name}}?', { name: deleting?.name ?? '' })}
        message={t('A medication that appears in a prescription cannot be deleted.')}
        confirmLabel={t('Delete')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </>
  );
}
