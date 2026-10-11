import { useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, MenuItem, Paper, Skeleton, Switch, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import { useTranslation } from 'react-i18next';
import {
  ALLERGY_SEVERITIES, BLOOD_TYPES, MEDICAL_SUGGESTIONS, PREGNANCY, SMOKING, medicalItemSchema, medicalProfileSchema,
  type MedicalItemDto, type MedicalItemKind, type MedicalProfileDto,
} from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { formatDateTime } from '../../lib/format';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useGetMedicalHistoryQuery, useReviewMedicalHistoryMutation, useUpdateMedicalProfileMutation, useAddMedicalItemMutation, useDeleteMedicalItemMutation, useUpdateMedicalItemMutation } from './medicalApi';

/** The four lists, worded in the current language. Their titles are medical terms, so they stay English in both languages (no Arabic entry). */
interface KindSpec { kind: MedicalItemKind; title: string; add: string; on: string; off: string; hint: string }
function useKinds(): KindSpec[] {
  const { t } = useTranslation();
  return [
    { kind: 'allergy', title: t('Allergies'), add: t('Add an allergy'), on: t('Current'), off: t('No longer'), hint: t('Drugs, materials, anything that caused a reaction.') },
    { kind: 'condition', title: t('Medical conditions'), add: t('Add a condition'), on: t('Current'), off: t('Resolved'), hint: t('Diabetes, heart disease, a bleeding disorder…') },
    { kind: 'medication', title: t('Current medications'), add: t('Add a medication'), on: t('Taking'), off: t('Stopped'), hint: t('What the patient takes now, including blood thinners.') },
    { kind: 'surgery', title: t('Past surgeries'), add: t('Add a surgery'), on: t('Recorded'), off: t('Recorded'), hint: t('Operations and treatments that matter for dental care.') },
  ];
}

const SEVERITY_COLOR = { severe: 'error', moderate: 'warning', mild: 'default' } as const;
type SortKey = 'name' | 'severity' | 'since' | 'note' | 'status';
const SEVERITY_RANK: Record<string, number> = { severe: 0, moderate: 1, mild: 2 };

function ItemDialog({ patientId, kind, item, onClose }: { patientId: number; kind: MedicalItemKind; item: MedicalItemDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const spec = useKinds().find((k) => k.kind === kind)!;
  const [add, addState] = useAddMedicalItemMutation();
  const [update, updateState] = useUpdateMedicalItemMutation();
  const [name, setName] = useState(item?.name ?? '');
  const [severity, setSeverity] = useState<string>(item?.severity ?? '');
  const [since, setSince] = useState(item?.since ?? '');
  const [note, setNote] = useState(item?.note ?? '');
  const [active, setActive] = useState(item?.active ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const busy = addState.isLoading || updateState.isLoading;
  const problem = addState.error ?? updateState.error;

  const submit = async () => {
    const values = { kind, name, severity: kind === 'allergy' ? severity : null, since, note, active };
    const { data, errors: found } = validate(medicalItemSchema, values);
    if (!data) return setErrors(found!);
    const result = item
      ? await update({ patientId, itemId: item.id, body: { name: data.name, severity: data.severity ?? null, since: data.since ?? null, note: data.note ?? null, active: data.active } })
      : await add({ patientId, body: values });
    if (!('error' in result && result.error)) onClose();
  };
  const clear = (key: string) => setErrors((e) => ({ ...e, [key]: '' }));

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{item ? t('Edit the entry') : spec.add}</DialogTitle>
      <DialogContent>
        {problem != null && <Alert severity="error" role="alert" sx={{ mb: 1 }}>{errorMessage(problem)}</Alert>}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{spec.hint}</Typography>
        <Autocomplete
          freeSolo options={MEDICAL_SUGGESTIONS[kind]} inputValue={name} onInputChange={(_e, v) => { setName(v); clear('name'); }}
          renderInput={(params) => <TextField {...params} label={t('Name')} required error={!!errors.name} helperText={errors.name || undefined} autoFocus />}
        />
        {kind === 'allergy' && (
          <TextField select label={t('Severity')} value={severity} onChange={(e) => { setSeverity(e.target.value); clear('severity'); }} error={!!errors.severity} helperText={errors.severity || undefined}>
            <MenuItem value="">{t('Not stated')}</MenuItem>
            {ALLERGY_SEVERITIES.map((s) => <MenuItem key={s} value={s}>{t(s)}</MenuItem>)}
          </TextField>
        )}
        <TextField
          label={t('Since')} value={since} onChange={(e) => { setSince(e.target.value); clear('since'); }} error={!!errors.since} dir="ltr"
          helperText={errors.since || t('A year (2019), a month (2019-04) or a date (2019-04-30). Optional.')} placeholder="2019"
        />
        <TextField label={t('Note (optional)')} value={note} onChange={(e) => { setNote(e.target.value); clear('note'); }} error={!!errors.note} helperText={errors.note || undefined} multiline minRows={2} />
        {kind !== 'surgery' && <FormControlLabel control={<Switch checked={active} onChange={(e) => setActive(e.target.checked)} />} label={active ? spec.on : spec.off} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : item ? t('Save changes') : t('Add')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function ItemsTable({ patientId, spec, items }: { patientId: number; spec: KindSpec; items: MedicalItemDto[] }) {
  const { t } = useTranslation();
  const sort = useSort<SortKey>(spec.kind === 'allergy' ? 'severity' : 'name');
  const [editing, setEditing] = useState<MedicalItemDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MedicalItemDto | null>(null);
  const [remove, removeState] = useDeleteMedicalItemMutation();
  const isAllergy = spec.kind === 'allergy';

  const value: Record<SortKey, (i: MedicalItemDto) => string | number | null> = {
    name: (i) => i.name, severity: (i) => (i.severity ? SEVERITY_RANK[i.severity]! : null), since: (i) => i.since, note: (i) => i.note, status: (i) => (i.active ? 0 : 1),
  };
  const rows = sortRows(items, value[sort.key], sort.order);

  return (
    <Paper component="section" aria-label={spec.title} sx={{ p: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>{spec.title}</Typography>
        <Button size="small" startIcon={<AddIcon />} onClick={() => setEditing('new')}>{spec.add}</Button>
      </Box>
      {removeState.error != null && <Alert severity="error" role="alert" sx={{ mb: 1 }}>{errorMessage(removeState.error)}</Alert>}
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{t('Nothing recorded.')}</Typography>
      ) : (
        <TableContainer>
          <Table size="small" aria-label={spec.title}>
            <TableHead>
              <TableRow>
                <SortCell field="name" sort={sort}>{t('Name')}</SortCell>
                {isAllergy && <SortCell field="severity" sort={sort}>{t('Severity')}</SortCell>}
                <SortCell field="since" sort={sort}>{t('Since')}</SortCell>
                <SortCell field="note" sort={sort}>{t('Note')}</SortCell>
                {spec.kind !== 'surgery' && <SortCell field="status" sort={sort}>{t('Status')}</SortCell>}
                <TableCell align="right" sx={{ width: 96 }}><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t('Actions')}</span></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((i) => (
                <TableRow key={i.id} hover sx={{ opacity: i.active ? 1 : 0.6 }}>
                  <TableCell sx={{ fontWeight: 600 }}>{i.name}</TableCell>
                  {isAllergy && <TableCell>{i.severity ? <Chip size="small" color={SEVERITY_COLOR[i.severity]} label={t(i.severity)} /> : '—'}</TableCell>}
                  <TableCell><bdi dir="ltr">{i.since ?? '—'}</bdi></TableCell>
                  <TableCell sx={{ maxWidth: 320, overflowWrap: 'anywhere' }}>{i.note ?? '—'}</TableCell>
                  {spec.kind !== 'surgery' && <TableCell><Chip size="small" variant="outlined" label={i.active ? spec.on : spec.off} /></TableCell>}
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit {{title}}', { title: i.name })} onClick={() => setEditing(i)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete {{title}}', { title: i.name })} onClick={() => { removeState.reset(); setDeleting(i); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {editing && <ItemDialog patientId={patientId} kind={spec.kind} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting} destructive title={t('Remove this entry?')} message={t('It is removed from the medical history. If it is only no longer true, edit it and switch it off instead, so the history keeps it.')}
        confirmLabel={t('Remove')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { const r = await remove({ patientId, itemId: deleting!.id }); if (!('error' in r && r.error)) setDeleting(null); }}
      />
    </Paper>
  );
}

function ProfileDialog({ patientId, profile, onClose }: { patientId: number; profile: MedicalProfileDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [save, state] = useUpdateMedicalProfileMutation();
  const [bloodType, setBloodType] = useState<string>(profile.bloodType ?? '');
  const [pregnancy, setPregnancy] = useState<string>(profile.pregnancy ?? '');
  const [smoking, setSmoking] = useState<string>(profile.smoking ?? '');
  const [notes, setNotes] = useState(profile.notes ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = async () => {
    const { data, errors: found } = validate(medicalProfileSchema, { bloodType, pregnancy, smoking, notes });
    if (!data) return setErrors(found!);
    const result = await save({ patientId, body: data });
    if (!('error' in result && result.error)) onClose();
  };
  const smokingLabel: Record<(typeof SMOKING)[number], string> = { never: 'Never smoked', former: 'Former smoker', current: 'Smokes' };

  return (
    <Dialog open onClose={state.isLoading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('Edit the medical profile')}</DialogTitle>
      <DialogContent>
        {state.error != null && <Alert severity="error" role="alert" sx={{ mb: 1 }}>{errorMessage(state.error)}</Alert>}
        <TextField select label={t('Blood type')} value={bloodType} onChange={(e) => setBloodType(e.target.value)} error={!!errors.bloodType} helperText={errors.bloodType || undefined}>
          <MenuItem value="">{t('Not recorded')}</MenuItem>
          {BLOOD_TYPES.map((b) => <MenuItem key={b} value={b}>{b}</MenuItem>)}
        </TextField>
        <TextField select label={t('Pregnant')} value={pregnancy} onChange={(e) => setPregnancy(e.target.value)} error={!!errors.pregnancy} helperText={errors.pregnancy || undefined}>
          <MenuItem value="">{t('Not recorded')}</MenuItem>
          {PREGNANCY.map((p) => <MenuItem key={p} value={p}>{t(p === 'yes' ? 'Yes' : 'No')}</MenuItem>)}
        </TextField>
        <TextField select label={t('Smoking')} value={smoking} onChange={(e) => setSmoking(e.target.value)} error={!!errors.smoking} helperText={errors.smoking || undefined}>
          <MenuItem value="">{t('Not recorded')}</MenuItem>
          {SMOKING.map((s) => <MenuItem key={s} value={s}>{t(smokingLabel[s])}</MenuItem>)}
        </TextField>
        <TextField label={t('Other notes')} value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={3} error={!!errors.notes} helperText={errors.notes || t('Anything else the dentist should know. Clinic only.')} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={state.isLoading}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={state.isLoading}>{state.isLoading ? t('Saving…') : t('Save changes')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function Fact({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography>{children || '—'}</Typography>
    </Box>
  );
}

/** A patient's medical history: the profile and four lists. Doctors and staff view and manage it; patients never see it. */
export function MedicalHistorySection({ patientId }: { patientId: number }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGetMedicalHistoryQuery(patientId);
  const [review, reviewState] = useReviewMedicalHistoryMutation();
  const [editingProfile, setEditingProfile] = useState(false);
  const kinds = useKinds();

  if (isLoading) return <Skeleton variant="rounded" height={160} aria-label={t('Loading')} />;
  if (error || !data) return <Alert severity="error">{errorMessage(error, 'Patient not found')}</Alert>;
  const { profile, items } = data;
  const smoking = { never: 'Never smoked', former: 'Former smoker', current: 'Smokes' } as const;

  return (
    <>
      <Paper component="section" aria-label={t('Medical profile')} sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>{t('Medical profile')}</Typography>
          <Button size="small" startIcon={<EditIcon />} onClick={() => setEditingProfile(true)}>{t('Edit')}</Button>
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }, gap: 2 }}>
          <Fact label={t('Blood type')}>{profile.bloodType}</Fact>
          <Fact label={t('Pregnant')}>{profile.pregnancy && t(profile.pregnancy === 'yes' ? 'Yes' : 'No')}</Fact>
          <Fact label={t('Smoking')}>{profile.smoking && t(smoking[profile.smoking])}</Fact>
          <Fact label={t('Last updated')}>{profile.updatedAt ? `${formatDateTime(profile.updatedAt)}${profile.updatedBy?.name ? ` · ${profile.updatedBy.name}` : ''}` : ''}</Fact>
        </Box>
        {profile.notes && <Typography variant="body2" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{profile.notes}</Typography>}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2, flexWrap: 'wrap' }}>
          <Typography variant="body2" color={profile.reviewedAt ? 'text.secondary' : 'warning.main'} sx={{ flexGrow: 1 }}>
            {profile.reviewedAt
              ? t('Gone through with the patient on {{date}} by {{name}}.', { date: formatDateTime(profile.reviewedAt), name: profile.reviewedBy?.name || t('someone') })
              : t('Not yet confirmed with the patient.')}
          </Typography>
          <Button size="small" variant="outlined" startIcon={<FactCheckOutlinedIcon />} disabled={reviewState.isLoading} onClick={() => review(patientId)}>{t('I went through it with the patient')}</Button>
        </Box>
        {reviewState.error != null && <Alert severity="error" role="alert" sx={{ mt: 1 }}>{errorMessage(reviewState.error)}</Alert>}
      </Paper>

      {kinds.map((spec) => <ItemsTable key={spec.kind} patientId={patientId} spec={spec} items={items.filter((i) => i.kind === spec.kind)} />)}
      {editingProfile && <ProfileDialog patientId={patientId} profile={profile} onClose={() => setEditingProfile(false)} />}
    </>
  );
}
