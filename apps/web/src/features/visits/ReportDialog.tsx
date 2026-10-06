import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, MenuItem,
  Paper, Stack, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useTranslation } from 'react-i18next';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { MEDICATION_TIME_UNITS, SURFACES, prescriptionSchema, type MedicationDto, type ReportDto, type Surface } from '@aya/shared';
import { DentalPanorama } from '../../components/DentalPanorama';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { validate } from '../../lib/zodForm';
import {
  useGetMedicationsQuery,
  useGetTeethQuery,
  useSaveReportMedicationsMutation,
  useSaveReportSummaryMutation,
  useSaveReportTeethMutation,
} from '../clinical/clinicalApi';

interface Props {
  open: boolean;
  onClose: () => void;
  appointment: { id: number; date: string; patient: { fname: string; lname: string } };
  report: ReportDto | null;
}

type Notes = Record<number, Record<Surface, string>>;
interface Row {
  key: number;
  medication: MedicationDto | null;
  dose: string;
  frequency: string;
  timeUnit: string;
  notes: string;
  error?: string;
}

const blank = (): Record<Surface, string> => Object.fromEntries(SURFACES.map((s) => [s, ''])) as Record<Surface, string>;
let rowKey = 0;
const newRow = (): Row => ({ key: ++rowKey, medication: null, dose: '', frequency: '3', timeUnit: 'day', notes: '' });

export function ReportDialog({ open, onClose, appointment, report }: Props) {
  const { t } = useTranslation();
  const { data: teeth = [] } = useGetTeethQuery(undefined, { skip: !open });
  const { data: medications = [] } = useGetMedicationsQuery(undefined, { skip: !open });
  const [saveSummary, summaryState] = useSaveReportSummaryMutation();
  const [saveTeeth, teethState] = useSaveReportTeethMutation();
  const [saveMeds, medsState] = useSaveReportMedicationsMutation();

  const [summary, setSummary] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState<Notes>({});
  const [tooth, setTooth] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = summaryState.isLoading || teethState.isLoading || medsState.isLoading;

  // Start from what is saved each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setTooth(null);
    setSummary(report?.summary ?? '');
    setNotes(
      Object.fromEntries(
        (report?.teeth ?? []).map((rt) => [rt.toothId, Object.fromEntries(SURFACES.map((s) => [s, rt[s] ?? ''])) as Record<Surface, string>]),
      ),
    );
    setRows(
      (report?.medications ?? []).map((m) => ({
        key: ++rowKey, medication: { id: m.medicationId, name: m.name, type: m.type }, dose: m.dose,
        frequency: String(m.frequency), timeUnit: m.timeUnit, notes: m.notes ?? '',
      })),
    );
     
  }, [open, report]);

  const marked = useMemo(
    () => new Set(Object.entries(notes).filter(([, n]) => SURFACES.some((s) => n[s].trim())).map(([id]) => Number(id))),
    [notes],
  );
  const current = tooth ? (notes[tooth] ?? blank()) : null;
  const toothInfo = teeth.find((x) => x.id === tooth);

  const setRow = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch, error: undefined } : r)));

  const save = async () => {
    setProblem(null);

    // Check every prescription line before anything is sent.
    let invalid = false;
    const checked = rows.map((r) => {
      const { data, errors } = validate(prescriptionSchema, {
        medicationId: r.medication?.id, dose: r.dose, frequency: r.frequency, timeUnit: r.timeUnit, notes: r.notes,
      });
      if (data) return { row: r, data };
      invalid = true;
      return { row: r, data: null, error: errors!.medicationId ? t('Choose a medication') : errors!.dose ?? errors!.frequency ?? errors!.timeUnit ?? t('Check this line') };
    });
    if (invalid) {
      setRows(checked.map((c) => ({ ...c.row, error: c.data ? undefined : (c as { error?: string }).error })));
      return setProblem(t('Some prescription lines are incomplete.'));
    }

    const teethPayload = Object.entries(notes)
      .filter(([, n]) => SURFACES.some((s) => n[s].trim()))
      .map(([id, n]) => ({ toothId: Number(id), ...Object.fromEntries(SURFACES.map((s) => [s, n[s].trim() || null])) }));

    // Three small saves; each replaces its own part, so retrying after a failure is safe.
    const steps = [
      () => saveSummary({ appointmentId: appointment.id, summary }),
      () => saveTeeth({ appointmentId: appointment.id, teeth: teethPayload }),
      () => saveMeds({ appointmentId: appointment.id, medications: checked.map((c) => c.data!) }),
    ];
    for (const step of steps) {
      const result = await step();
      if ('error' in result && result.error) return setProblem(errorMessage(result.error));
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>
        {t('Visit report')}
        <Typography variant="body2" color="text.secondary">{fullName(appointment.patient)} · {formatDate(appointment.date)}</Typography>
      </DialogTitle>
      <DialogContent dividers>
        {problem && <Alert severity="error" sx={{ mb: 2 }} role="alert">{problem}</Alert>}

        <Typography variant="subtitle1" component="h3" gutterBottom>{t('Summary')}</Typography>
        <TextField
          label={t('What was done')} value={summary} onChange={(e) => setSummary(e.target.value)} multiline minRows={3} margin="none"
          helperText={t('The patient sees this and the prescription, nothing else from the report')}
        />

        <Divider sx={{ my: 3 }} />
        <Typography variant="subtitle1" component="h3" gutterBottom>{t('Prescription')}</Typography>
        {rows.length === 0 && <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>{t('No medication prescribed.')}</Typography>}
        <Stack spacing={1.5}>
          {rows.map((r, i) => (
            <Paper key={r.key} variant="outlined" sx={{ p: 1.5 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', columnGap: 1.5 }}>
                <Autocomplete
                  options={medications} value={r.medication} getOptionLabel={(m) => m.name} isOptionEqualToValue={(a, b) => a.id === b.id}
                  onChange={(_e, v) => setRow(r.key, { medication: v })}
                  renderInput={(params) => <TextField {...params} label={t('Medication')} margin="dense" required inputProps={{ ...params.inputProps, 'aria-label': t('Medication {{n}}', { n: i + 1 }) }} />}
                />
                <TextField label={t('Dose')} value={r.dose} onChange={(e) => setRow(r.key, { dose: e.target.value })} margin="dense" required placeholder="500 mg" inputProps={{ 'aria-label': t('Dose {{n}}', { n: i + 1 }) }} />
                <TextField label={t('Times')} type="number" value={r.frequency} onChange={(e) => setRow(r.key, { frequency: e.target.value })} margin="dense" required inputProps={{ min: 1, max: 24, 'aria-label': t('Times {{n}}', { n: i + 1 }) }} />
                <TextField select label={t('Per')} value={r.timeUnit} onChange={(e) => setRow(r.key, { timeUnit: e.target.value })} margin="dense" inputProps={{ 'aria-label': t('Per {{n}}', { n: i + 1 }) }}>
                  {MEDICATION_TIME_UNITS.map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
                </TextField>
              </Box>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <TextField label={t('Instructions (optional)')} value={r.notes} onChange={(e) => setRow(r.key, { notes: e.target.value })} margin="dense" inputProps={{ 'aria-label': t('Instructions {{n}}', { n: i + 1 }) }} />
                <IconButton aria-label={t('Remove medication {{n}}', { n: i + 1 })} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))} sx={{ mt: 1 }}>
                  <DeleteOutlineIcon />
                </IconButton>
              </Box>
              {r.error && <Typography color="error" variant="caption">{r.error}</Typography>}
            </Paper>
          ))}
        </Stack>
        <Button startIcon={<AddIcon />} onClick={() => setRows((all) => [...all, newRow()])} sx={{ mt: 1 }}>{t('Add medication')}</Button>
        {medications.length === 0 && <Typography variant="caption" color="text.secondary" display="block">{t('The medication list is empty. Add medications under Medications first.')}</Typography>}

        <Divider sx={{ my: 3 }} />
        <Typography variant="subtitle1" component="h3" gutterBottom>{t('Tooth notes (clinic only)')}</Typography>
        <DentalPanorama teeth={teeth} marked={marked} selected={tooth ? new Set([tooth]) : undefined} onToggle={(id) => setTooth((c) => (c === id ? null : id))} />
        {current && toothInfo ? (
          <Paper variant="outlined" sx={{ p: 2, mt: 1 }}>
            <Typography variant="subtitle2" gutterBottom>{t('Tooth {{index}}', { index: toothInfo.index })}, {toothInfo.name}</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', columnGap: 1.5 }}>
              {SURFACES.map((s) => (
                <TextField
                  key={s} label={s[0]!.toUpperCase() + s.slice(1)} value={current[s]} margin="dense" multiline
                  onChange={(e) => setNotes((all) => ({ ...all, [tooth!]: { ...(all[tooth!] ?? blank()), [s]: e.target.value } }))}
                />
              ))}
            </Box>
            <Button size="small" onClick={() => setNotes((all) => ({ ...all, [tooth!]: blank() }))}>{t("Clear this tooth's notes")}</Button>
          </Paper>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('Click a tooth to add notes for its surfaces. Highlighted teeth already have notes.')}</Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save report')}</Button>
      </DialogActions>
    </Dialog>
  );
}
