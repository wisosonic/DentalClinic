import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import { useTranslation } from 'react-i18next';
import { categoryInputSchema, type CategoryDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { PageHeader } from '../../components/PageHeader';
import { errorMessage } from '../../lib/baseQuery';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useCreateCategoryMutation, useDeleteCategoryMutation, useGetCategoriesQuery, useUpdateCategoryMutation } from '../clinical/clinicalApi';

interface Extra {
  key: number;
  name: string;
  price: string;
}
let extraKey = 0;

function ProcedureDialog({ open, category, onClose }: { open: boolean; category?: CategoryDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [extras, setExtras] = useState<Extra[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [create, createState] = useCreateCategoryMutation();
  const [update, updateState] = useUpdateCategoryMutation();
  const busy = createState.isLoading || updateState.isLoading;

  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? '');
    setPriceMin(category ? String(category.priceMin) : '');
    setPriceMax(category ? String(category.priceMax) : '');
    setExtras((category?.features ?? []).map((f, i) => ({ key: ++extraKey, name: f, price: String(category!.featurePrices[i] ?? '') })));
    setErrors({});
    createState.reset();
    updateState.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, category]);

  const submit = async () => {
    const { data, errors: found } = validate(categoryInputSchema, {
      name, priceMin, priceMax, features: extras.map((e) => e.name), featurePrices: extras.map((e) => (e.price === '' ? NaN : e.price)),
    });
    if (!data) return setErrors(found!);
    const result = category ? await update({ id: category.id, body: data }) : await create(data);
    if (!result.error) onClose();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{category ? t('Edit procedure') : t('Add procedure')}</DialogTitle>
      <DialogContent>
        {(createState.error ?? updateState.error) != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(createState.error ?? updateState.error)}</Alert>}
        <TextField label={t('Name')} value={name} onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: '' })); }} required autoFocus error={!!errors.name} helperText={errors.name} />
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 2 }}>
          <TextField label={t('Lowest price ($)')} type="number" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} required error={!!errors.priceMin} helperText={errors.priceMin} />
          <TextField label={t('Highest price ($)')} type="number" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} required error={!!errors.priceMax} helperText={errors.priceMax} />
        </Box>

        <Typography variant="subtitle2" sx={{ mt: 2 }}>{t('Priced extras (optional)')}</Typography>
        <Typography variant="caption" color="text.secondary">{t('For example "Large composite" adds $20.')}</Typography>
        <Stack spacing={1} sx={{ mt: 1 }}>
          {extras.map((x, i) => (
            <Box key={x.key} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <TextField size="small" label={t('Extra {{n}}', { n: i + 1 })} value={x.name} margin="none" onChange={(e) => setExtras((all) => all.map((y) => (y.key === x.key ? { ...y, name: e.target.value } : y)))} />
              <TextField size="small" label={t('Price ($)')} type="number" value={x.price} margin="none" onChange={(e) => setExtras((all) => all.map((y) => (y.key === x.key ? { ...y, price: e.target.value } : y)))} sx={{ maxWidth: 130 }} />
              <IconButton aria-label={t('Remove extra {{n}}', { n: i + 1 })} onClick={() => setExtras((all) => all.filter((y) => y.key !== x.key))}><DeleteOutlineIcon /></IconButton>
            </Box>
          ))}
        </Stack>
        {(errors.featurePrices || errors.features) && <Typography color="error" variant="caption">{errors.featurePrices || errors.features}</Typography>}
        <Button startIcon={<AddIcon />} onClick={() => setExtras((all) => [...all, { key: ++extraKey, name: '', price: '' }])} sx={{ mt: 1 }}>{t('Add extra')}</Button>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** The treatments the clinic offers, with their price range. Admin only. */
export function ProceduresPage() {
  const { t } = useTranslation();
  const { data: categories = [], error } = useGetCategoriesQuery();
  const [remove, removeState] = useDeleteCategoryMutation();
  const sort = useSort<'name' | 'price' | 'extras'>('name');
  const [editing, setEditing] = useState<CategoryDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);

  return (
    <>
      <PageHeader
        title={t('Procedures')} subtitle={t('The treatments you offer, with their price range')}
        actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>{t('Add procedure')}</Button>}
      />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {removeState.error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(removeState.error)}</Alert>}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead><TableRow><SortCell field="name" sort={sort}>{t('Name')}</SortCell><SortCell field="price" sort={sort}>{t('Price range')}</SortCell><SortCell field="extras" sort={sort}>{t('Extras')}</SortCell><TableCell align="right">{t('Actions')}</TableCell></TableRow></TableHead>
          <TableBody>
            {sortRows(categories, (c) => (sort.key === 'name' ? c.name : sort.key === 'price' ? c.priceMin : c.features.length), sort.order).map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.name}</TableCell>
                <TableCell>${c.priceMin}{c.priceMax !== c.priceMin ? ` – $${c.priceMax}` : ''}</TableCell>
                <TableCell>{c.features.length ? c.features.map((f, i) => `${f} (+$${c.featurePrices[i]})`).join(', ') : '—'}</TableCell>
                <TableCell align="right">
                  <Tooltip title={t('Edit')}><IconButton aria-label={t('Edit {{name}}', { name: c.name })} onClick={() => setEditing(c)}><EditIcon /></IconButton></Tooltip>
                  <Tooltip title={t('Delete')}><IconButton aria-label={t('Delete {{name}}', { name: c.name })} onClick={() => { removeState.reset(); setDeleting(c); }}><DeleteOutlineIcon /></IconButton></Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <ProcedureDialog open={!!editing} category={editing && editing !== 'new' ? editing : undefined} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete {{name}}?', { name: deleting?.name ?? '' })} message={t('A procedure that appointments use cannot be deleted.')}
        confirmLabel={t('Delete')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </>
  );
}
