import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, Paper, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useTranslation } from 'react-i18next';
import { offerInputSchema, type OfferDto, type PatientDto } from '@aya/shared';
import { PatientPicker } from '../../components/PatientPicker';
import { errorMessage } from '../../lib/baseQuery';
import { formatMoney } from '../../lib/money';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useGetCategoriesQuery, useGetTeethQuery } from '../clinical/clinicalApi';
import { useCreateOfferMutation, useSetOfferItemsMutation, useUpdateOfferMutation } from './offersApi';

interface ItemDraft {
  key: number;
  id?: number;
  description: string;
  categoryId: string;
  toothId: string;
  price: string;
  cost: string;
  /** Booked or done: it stays in the offer. */
  locked: boolean;
}

let nextKey = 1;
const blank = (): ItemDraft => ({ key: nextKey++, description: '', categoryId: '', toothId: '', price: '', cost: '', locked: false });

/**
 * A treatment offer: the title and the ordered list of work, each item with its price (and, for the clinic's own
 * records, its cost). The offer's price is the sum. Choosing a procedure suggests a description and its lowest listed
 * price; both can be changed. Items that already have a visit cannot be removed.
 */
export function OfferFormDialog({
  open, onClose, offer, patient: preset, onSaved,
}: { open: boolean; onClose: () => void; offer?: OfferDto; patient?: PatientDto | null; onSaved?: (offer: OfferDto) => void }) {
  const { t } = useTranslation();
  const editing = !!offer;
  const { data: categories = [] } = useGetCategoriesQuery(undefined, { skip: !open });
  const { data: teeth = [] } = useGetTeethQuery(undefined, { skip: !open });
  const [create, createState] = useCreateOfferMutation();
  const [update, updateState] = useUpdateOfferMutation();
  const [setItems, itemsState] = useSetOfferItemsMutation();
  const busy = createState.isLoading || updateState.isLoading || itemsState.isLoading;

  const [patient, setPatient] = useState<PatientDto | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setList] = useState<ItemDraft[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (!open) return;
    createState.reset();
    updateState.reset();
    itemsState.reset();
    setErrors({});
    setPatient(preset ?? null);
    setTitle(offer?.title ?? '');
    setDescription(offer?.description ?? '');
    setStartDate(offer?.startDate ?? '');
    setNotes(offer?.notes ?? '');
    setList(
      offer?.items?.length
        ? offer.items.map((i) => ({
          key: nextKey++, id: i.id, description: i.description, categoryId: i.category ? String(i.category.id) : '', toothId: i.tooth ? String(i.tooth.id) : '',
          price: String(i.price), cost: i.cost == null ? '' : String(i.cost), locked: i.status !== 'pending',
        }))
        : [blank()],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offer]);

  const patch = (key: number, changes: Partial<ItemDraft>) => setList((l) => l.map((i) => (i.key === key ? { ...i, ...changes } : i)));
  const move = (index: number, by: number) =>
    setList((l) => {
      const next = [...l];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return next;
    });

  const pickCategory = (item: ItemDraft, categoryId: string) => {
    const category = categories.find((c) => String(c.id) === categoryId);
    patch(item.key, {
      categoryId,
      ...(category && !item.description.trim() && { description: category.name }),
      ...(category && (!item.price || Number(item.price) === 0) && { price: String(category.priceMin) }),
    });
  };

  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0), 0);

  /** `asDraft`: keep it unfinished (no items needed); otherwise a new offer is final, the patient having agreed. */
  const submit = async (asDraft = false) => {
    const filled = items.filter((i) => i.description.trim() || i.price || i.cost || i.categoryId || i.toothId); // an empty row is not an item
    if (!offer && !asDraft && filled.length === 0) {
      setErrors({ items: t('Add at least one item first') });
      return;
    }
    const draft = {
      patientId: offer?.patientId ?? patient?.id, title, description, startDate, notes, ...(asDraft && { asDraft: true }),
      items: (offer ? items : filled).map((i) => ({
        id: i.id, description: i.description, categoryId: i.categoryId || null, toothId: i.toothId || null, price: i.price === '' ? 0 : i.price, cost: i.cost === '' ? null : i.cost,
      })),
    };
    const { data, errors: found } = validate(offerInputSchema, draft);
    if (!data) {
      const friendly = { ...found! };
      if (friendly.patientId) friendly.patientId = t('Choose a patient');
      return setErrors(friendly);
    }
    if (!offer) {
      const result = await create(data);
      if (result.data) { onSaved?.(result.data); onClose(); }
      return;
    }
    const changed = await update({ id: offer.id, body: { title: data.title, description: data.description ?? null, startDate: data.startDate ?? null, notes: data.notes ?? null } });
    if ('error' in changed && changed.error) return;
    const saved = await setItems({ id: offer.id, items: data.items });
    if (saved.data) { onSaved?.(saved.data); onClose(); }
  };

  const error = createState.error ?? updateState.error ?? itemsState.error;
  const problem = Object.values(errors).some(Boolean);
  const field = (key: string) => ({ error: !!errors[key], helperText: errors[key] || undefined });
  const clear = (key: string) => setErrors((x) => ({ ...x, [key]: '' }));

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{editing ? t('Edit treatment offer') : t('New treatment offer')}</DialogTitle>
      <DialogContent>
        {error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(error)}</Alert>}
        {editing ? (
          <TextField label={t('Patient')} value={`${offer!.patient.fname} ${offer!.patient.lname}`} disabled />
        ) : (
          <PatientPicker value={patient} onChange={(p) => { setPatient(p); clear('patientId'); }} error={!!errors.patientId} helperText={errors.patientId} autoFocus />
        )}
        <TextField label={t('Title')} value={title} required onChange={(e) => { setTitle(e.target.value); clear('title'); }} {...field('title')} />
        <TextField label={t('Description (optional)')} value={description} onChange={(e) => setDescription(e.target.value)} {...field('description')} />
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: 2 }}>
          <TextField label={t('Start date (optional)')} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} {...field('startDate')} />
        </Box>

        <Typography variant="subtitle1" sx={{ mt: 1, mb: 1, fontWeight: 700 }}>{t('Work to do, in order')}</Typography>
        {errors.items && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errors.items}</Alert>}
        <Stack spacing={1.5}>
          {items.map((item, index) => (
            <Paper key={item.key} variant="outlined" sx={{ p: 1.5 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.1fr 1.3fr 0.8fr 0.6fr 0.6fr' }, columnGap: 1.5 }}>
                <TextField
                  select label={t('Procedure')} value={item.categoryId} margin="dense" onChange={(e) => pickCategory(item, e.target.value)}
                  slotProps={{ htmlInput: { 'aria-label': t('Procedure of item {{n}}', { n: index + 1 }) } }}
                >
                  <MenuItem value="">{t('None')}</MenuItem>
                  {categories.map((c) => <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>)}
                </TextField>
                <TextField
                  label={t('Description')} value={item.description} required margin="dense"
                  onChange={(e) => { patch(item.key, { description: e.target.value }); clear(`items.${index}.description`); }}
                  error={!!errors[`items.${index}.description`]} helperText={errors[`items.${index}.description`] || undefined}
                  slotProps={{ htmlInput: { 'aria-label': t('Description of item {{n}}', { n: index + 1 }) } }}
                />
                <TextField
                  select label={t('Tooth')} value={item.toothId} margin="dense" onChange={(e) => patch(item.key, { toothId: e.target.value })}
                  slotProps={{ htmlInput: { 'aria-label': t('Tooth of item {{n}}', { n: index + 1 }) } }}
                >
                  <MenuItem value="">{t('None')}</MenuItem>
                  {teeth.map((x) => <MenuItem key={x.id} value={String(x.id)}>{x.index} · {x.name}</MenuItem>)}
                </TextField>
                <TextField
                  label={t('Price ($)')} type="number" value={item.price} margin="dense" required
                  onChange={(e) => { patch(item.key, { price: e.target.value }); clear(`items.${index}.price`); }}
                  error={!!errors[`items.${index}.price`]} helperText={errors[`items.${index}.price`] || undefined}
                  slotProps={{ htmlInput: { min: 0, step: '0.01', inputMode: 'decimal', dir: 'ltr', 'aria-label': t('Price of item {{n}}', { n: index + 1 }) } }}
                />
                <TextField
                  label={t('Cost ($)')} type="number" value={item.cost} margin="dense"
                  onChange={(e) => { patch(item.key, { cost: e.target.value }); clear(`items.${index}.cost`); }}
                  error={!!errors[`items.${index}.cost`]} helperText={errors[`items.${index}.cost`] || undefined}
                  slotProps={{ htmlInput: { min: 0, step: '0.01', inputMode: 'decimal', dir: 'ltr', 'aria-label': t('Cost of item {{n}}', { n: index + 1 }) } }}
                />
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
                {item.locked && <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>{t('Has a visit: it stays in the offer')}</Typography>}
                <Tooltip title={t('Move up')}><span><IconButton size="small" disabled={index === 0} aria-label={t('Move item {{n}} up', { n: index + 1 })} onClick={() => move(index, -1)}><ArrowUpwardIcon fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title={t('Move down')}><span><IconButton size="small" disabled={index === items.length - 1} aria-label={t('Move item {{n}} down', { n: index + 1 })} onClick={() => move(index, 1)}><ArrowDownwardIcon fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title={t('Remove')}><span><IconButton size="small" disabled={item.locked} aria-label={t('Remove item {{n}}', { n: index + 1 })} onClick={() => setList((l) => l.filter((x) => x.key !== item.key))}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
              </Box>
            </Paper>
          ))}
        </Stack>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <Button startIcon={<AddIcon />} onClick={() => setList((l) => [...l, blank()])}>{t('Add item')}</Button>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{t('Total')}: {formatMoney(Math.round(total * 100) / 100)}</Typography>
        </Box>

        <TextField label={t('Notes (optional)')} value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} sx={{ mt: 1 }} {...field('notes')} />
      </DialogContent>
      <DialogActions>
        {/* the Save buttons sit below a long form: say here that something above needs fixing, since it may be out of view */}
        {problem && <Typography role="alert" variant="body2" color="error" sx={{ flexGrow: 1, paddingInlineStart: 1 }}>{t('Something above needs fixing. Scroll up to see what.')}</Typography>}
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        {!editing && <Button onClick={() => submit(true)} disabled={busy}>{t('Save as draft')}</Button>}
        <Button variant="contained" onClick={() => submit(false)} disabled={busy}>{busy ? t('Saving…') : editing ? t('Save changes') : t('Create offer')}</Button>
      </DialogActions>
    </Dialog>
  );
}
