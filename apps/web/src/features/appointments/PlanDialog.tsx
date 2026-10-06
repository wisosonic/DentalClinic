import { useEffect, useState } from 'react';
import { Alert, Autocomplete, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { AppointmentDto } from '@aya/shared';
import { DentalPanorama } from '../../components/DentalPanorama';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import {
  useGetCategoriesQuery,
  useGetTeethQuery,
  useSetAppointmentCategoriesMutation,
  useSetAppointmentTeethMutation,
} from '../clinical/clinicalApi';

/**
 * Edits what an appointment is for: its procedures and, for doctors and admins, the teeth
 * involved (with a note for each). Staff can change the procedures only.
 */
export function PlanDialog({ open, onClose, appointment }: { open: boolean; onClose: () => void; appointment: AppointmentDto }) {
  const { t } = useTranslation();
  const { canComplete } = useRole(); // doctors and admins may also choose teeth
  const { data: categories = [] } = useGetCategoriesQuery(undefined, { skip: !open });
  const { data: teeth = [] } = useGetTeethQuery(undefined, { skip: !open });
  const [saveCategories, catState] = useSetAppointmentCategoriesMutation();
  const [saveTeeth, teethState] = useSetAppointmentTeethMutation();

  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const busy = catState.isLoading || teethState.isLoading;

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setCategoryIds(appointment.categories.map((c) => c.id));
    setChosen(Object.fromEntries((appointment.teeth ?? []).map((tooth) => [tooth.toothId, tooth.description ?? ''])));
  }, [open, appointment]);

  const toggle = (id: number) =>
    setChosen((c) => {
      const next = { ...c };
      if (id in next) delete next[id];
      else next[id] = '';
      return next;
    });

  const save = async () => {
    setProblem(null);
    const first = await saveCategories({ id: appointment.id, categoryIds });
    if (first.error) return setProblem(errorMessage(first.error));
    if (canComplete) {
      const second = await saveTeeth({
        id: appointment.id,
        teeth: Object.entries(chosen).map(([id, description]) => ({ toothId: Number(id), description: description.trim() || null })),
      });
      if (second.error) return setProblem(errorMessage(second.error));
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{canComplete ? t('Procedures and teeth') : t('Procedures')}</DialogTitle>
      <DialogContent dividers>
        {problem && <Alert severity="error" sx={{ mb: 2 }} role="alert">{problem}</Alert>}
        <Autocomplete
          multiple options={categories} value={categories.filter((c) => categoryIds.includes(c.id))} getOptionLabel={(c) => c.name}
          onChange={(_e, v) => setCategoryIds(v.map((c) => c.id))} renderInput={(params) => <TextField {...params} label={t('Procedures')} margin="none" />}
        />
        {canComplete && (
          <>
            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>{t('Teeth involved')}</Typography>
            <DentalPanorama teeth={teeth} selected={new Set(Object.keys(chosen).map(Number))} onToggle={toggle} />
            <Stack spacing={1} sx={{ mt: 1 }}>
              {Object.entries(chosen).map(([id, description]) => {
                const tooth = teeth.find((x) => x.id === Number(id));
                return (
                  <TextField
                    key={id} size="small" label={t('Tooth {{index}}: note', { index: tooth?.index ?? id })} value={description} margin="none"
                    onChange={(e) => setChosen((c) => ({ ...c, [id]: e.target.value }))}
                  />
                );
              })}
            </Stack>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}
