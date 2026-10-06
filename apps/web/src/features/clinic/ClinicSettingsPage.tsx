import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Alert, Avatar, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, MenuItem,
  Paper, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import UploadIcon from '@mui/icons-material/Upload';
import BusinessIcon from '@mui/icons-material/Business';
import { useTranslation } from 'react-i18next';
import {
  COMMISSION_REQUIRED, DOCTOR_KINDS, unitCreateSchema, GENDERS, clinicDoctorInputSchema, clinicInputSchema, doctorInputSchema, doctorUpdateSchema,
  type ClinicDto, type DoctorDto, type DoctorKind, type UnitDto,
} from '@aya/shared';
import { useRef } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { PageHeader } from '../../components/PageHeader';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { validate, type FieldErrors } from '../../lib/zodForm';
import {
  useCreateClinicMutation, useRemoveClinicLogoMutation, useUploadClinicLogoMutation, useCreateDoctorMutation, useCreateUnitMutation, useDeleteClinicMutation, useDeleteDoctorMutation, useDeleteUnitMutation,
  useGetClinicDoctorsQuery, useGetClinicsQuery, useGetDoctorsQuery, useGetUnitsQuery, useListUsersQuery, useRemoveClinicDoctorMutation,
  useRenameUnitMutation, useSetClinicDoctorMutation, useUpdateClinicMutation, useUpdateDoctorMutation,
} from '../clinical/clinicalApi';

type Fields = Record<string, string>;

const KIND_LABEL: Record<DoctorKind, string> = { owner: 'Owner', external: 'External' };

/** A small generic form dialog: string fields, validated with a shared schema. */
function FormDialog(props: {
  open: boolean;
  title: string;
  fields: { key: string; label: string; required?: boolean; type?: string; helper?: string }[];
  initial: Fields;
  schema: Parameters<typeof validate>[0];
  busy: boolean;
  error?: unknown;
  onSubmit: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Fields>(props.initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (props.open) {
      setValues(props.initial);
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const submit = () => {
    const { data, errors: found } = validate(props.schema, values);
    if (!data) return setErrors(found!);
    props.onSubmit(data);
  };

  return (
    <Dialog open={props.open} onClose={props.busy ? undefined : props.onClose} fullWidth maxWidth="sm">
      <DialogTitle>{props.title}</DialogTitle>
      <DialogContent>
        {props.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(props.error)}</Alert>}
        {props.fields.map((f) => (
          <TextField
            key={f.key} label={f.label} value={values[f.key] ?? ''} required={f.required} type={f.type}
            onChange={(e) => { setValues((v) => ({ ...v, [f.key]: e.target.value })); setErrors((er) => ({ ...er, [f.key]: '' })); }}
            error={!!errors[f.key]} helperText={errors[f.key] || f.helper}
          />
        ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose} disabled={props.busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={props.busy}>{props.busy ? t('Saving…') : t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Doctors
// ---------------------------------------------------------------------------

const emptyDoctor = { fname: '', lname: '', kind: 'external', commissionPercent: '', speciality: '', gender: '', phone: '', email: '', address: '' };
const doctorToFields = (d?: DoctorDto) =>
  d
    ? {
        fname: d.fname, lname: d.lname, kind: d.kind, commissionPercent: d.commissionPercent == null ? '' : String(d.commissionPercent),
        speciality: d.speciality ?? '', gender: d.gender ?? '', phone: d.phone ?? '', email: d.email ?? '', address: d.address ?? '',
      }
    : emptyDoctor;

function DoctorFormDialog({ open, doctor, onClose }: { open: boolean; doctor?: DoctorDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  const [values, setValues] = useState<Fields>(doctorToFields(doctor));
  const [userId, setUserId] = useState('');
  const [taxSpouse, setTaxSpouse] = useState(false);
  const [taxChildren, setTaxChildren] = useState('0');
  const [errors, setErrors] = useState<FieldErrors>({});
  const { data: users } = useListUsersQuery(undefined, { skip: !open || !isAdmin || !doctor });
  const [create, createState] = useCreateDoctorMutation();
  const [update, updateState] = useUpdateDoctorMutation();
  const busy = createState.isLoading || updateState.isLoading;

  useEffect(() => {
    if (open) {
      setValues(doctorToFields(doctor));
      setUserId(doctor?.userId ? String(doctor.userId) : '');
      setTaxSpouse(Boolean(doctor?.taxSpouse));
      setTaxChildren(String(doctor?.taxChildren ?? 0));
      setErrors({});
      createState.reset();
      updateState.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doctor]);

  const set = (key: string) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((er) => ({ ...er, [key]: '' }));
  };
  const external = values.kind === 'external';

  const submit = async () => {
    const payload = {
      ...values,
      // An owner has no commission percentage.
      commissionPercent: external && values.commissionPercent !== '' ? Number(values.commissionPercent) : null,
      // The login account is an admin's setting, sent only when it changed.
      ...(isAdmin && doctor && userId !== (doctor.userId ? String(doctor.userId) : '') ? { userId: userId ? Number(userId) : null } : {}),
      // The family details for the income tax estimate are an admin's, sent only when they changed.
      ...(isAdmin && doctor && taxSpouse !== Boolean(doctor.taxSpouse) ? { taxSpouse } : {}),
      ...(isAdmin && doctor && Number(taxChildren) !== (doctor.taxChildren ?? 0) ? { taxChildren: Number(taxChildren) } : {}),
    };
    const { data, errors: found } = validate(doctor ? doctorUpdateSchema : doctorInputSchema, payload);
    if (!data) return setErrors(found!);
    if (external && data.commissionPercent == null) return setErrors({ commissionPercent: t(COMMISSION_REQUIRED) });
    const result = doctor ? await update({ id: doctor.id, body: data }) : await create(data);
    if (!result.error) onClose();
  };

  const text = (key: string, label: string, extra: object = {}) => (
    <TextField label={label} value={values[key] ?? ''} onChange={set(key)} error={!!errors[key]} helperText={errors[key] || undefined} {...extra} />
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{doctor ? t('Edit {{name}}', { name: fullName(doctor) }) : t('Add doctor')}</DialogTitle>
      <DialogContent>
        {(createState.error ?? updateState.error) != null && (
          <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(createState.error ?? updateState.error)}</Alert>
        )}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', columnGap: 2 }}>
          {text('fname', t('First name'), { required: true, autoFocus: true })}
          {text('lname', t('Last name'), { required: true })}
        </Box>
        <TextField
          select label={t('Kind')} value={values.kind} onChange={set('kind')} disabled={!isAdmin}
          helperText={isAdmin ? t('Owner doctors have a dental unit; external doctors are visiting specialists') : t('Only an admin can add or change an owner doctor')}
        >
          {DOCTOR_KINDS.map((k) => <MenuItem key={k} value={k}>{t(KIND_LABEL[k])}</MenuItem>)}
        </TextField>
        {isAdmin && doctor && (
          <TextField
            select label={t('Login account')} value={userId} onChange={(e) => setUserId(e.target.value)}
            helperText={t('Links this doctor to a sign-in, so their own appointments, patients and reports are theirs. Only admin and doctor logins can be linked.')}
          >
            <MenuItem value="">{t('None')}</MenuItem>
            {(users?.data ?? []).filter((u) => u.role === 'admin' || u.role === 'doctor').map((u) => (
              <MenuItem key={u.id} value={String(u.id)}>{u.name} ({u.email})</MenuItem>
            ))}
          </TextField>
        )}
        {isAdmin && doctor && (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', columnGap: 2, alignItems: 'center' }}>
            <FormControlLabel control={<Switch checked={taxSpouse} onChange={(e) => setTaxSpouse(e.target.checked)} />} label={t('Spouse is eligible (income tax)')} />
            <TextField
              label={t('Eligible children (income tax)')} type="number" value={taxChildren} onChange={(e) => setTaxChildren(e.target.value)}
              error={!!errors.taxChildren} helperText={errors.taxChildren || undefined} slotProps={{ htmlInput: { min: 0, max: 30, step: 1, dir: 'ltr' } }}
            />
          </Box>
        )}
        {external && text('commissionPercent', t('Commission percentage'), {
          required: true, type: 'number', slotProps: { htmlInput: { min: 0, max: 100, step: 'any' } },
          helperText: errors.commissionPercent || t('The share of what he collects that he pays the owner of the dental unit he uses'),
        })}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', columnGap: 2 }}>
          {text('speciality', t('Speciality'))}
          <TextField select label={t('Gender')} value={values.gender} onChange={set('gender')}>
            <MenuItem value="">{t('Not set')}</MenuItem>
            {GENDERS.map((g) => <MenuItem key={g} value={g}>{t(g)}</MenuItem>)}
          </TextField>
          {text('phone', t('Phone'), { type: 'tel' })}
          {text('email', t('Email'), { type: 'email' })}
        </Box>
        {text('address', t('Address'))}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? t('Saving…') : t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function DoctorsPanel() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  const { data: doctors = [] } = useGetDoctorsQuery();
  const sort = useSort<'name' | 'kind' | 'speciality' | 'commission'>('name');
  const [remove, removeState] = useDeleteDoctorMutation();
  const [editing, setEditing] = useState<DoctorDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DoctorDto | null>(null);
  // Owner doctors may only manage external doctors; admins manage everyone.
  const canEdit = (d: DoctorDto) => isAdmin || d.kind === 'external';

  const sorted = (kind: DoctorDto['kind']) => sortRows(doctors.filter((d) => d.kind === kind), (d) => (sort.key === 'name' ? fullName(d) : sort.key === 'speciality' ? d.speciality : d.commissionPercent), sort.order);
  const section = (kind: DoctorDto['kind'], title: string, hint: string) => {
    const rows = sorted(kind);
    const external = kind === 'external';
    return (
      <Box component="section" sx={{ mb: 3 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 0.5 }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{hint}</Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label={title}>
            <TableHead>
              <TableRow>
                <SortCell field="name" sort={sort}>{t('Name')}</SortCell><SortCell field="speciality" sort={sort}>{t('Speciality')}</SortCell>
                {external && <SortCell field="commission" sort={sort}>{t('Commission')}</SortCell>}
                <TableCell align="right">{t('Actions')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && <TableRow><TableCell colSpan={external ? 4 : 3}>{external ? t('No external specialists yet.') : t('No owner doctors yet.')}</TableCell></TableRow>}
              {rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{fullName(d)}</TableCell>
                  <TableCell>{d.speciality ?? '—'}</TableCell>
                  {external && <TableCell>{d.commissionPercent == null ? <Chip size="small" color="warning" label={t('Not set')} /> : `${d.commissionPercent}%`}</TableCell>}
                  <TableCell align="right">
                    {canEdit(d) && (
                      <Tooltip title={t('Edit')}><IconButton aria-label={t('Edit {{name}}', { name: fullName(d) })} onClick={() => setEditing(d)}><EditIcon /></IconButton></Tooltip>
                    )}
                    {isAdmin && (
                      <Tooltip title={t('Delete')}><IconButton aria-label={t('Delete {{name}}', { name: fullName(d) })} onClick={() => { removeState.reset(); setDeleting(d); }}><DeleteOutlineIcon /></IconButton></Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    );
  };

  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>{t('Add doctor')}</Button>
      </Box>
      {removeState.error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(removeState.error)}</Alert>}
      {section('owner', t('Owner doctors'), t('The clinic’s owners: each has a dental unit. Only an admin can edit them.'))}
      {section('external', t('External specialists'), t('Outside doctors who pay the owners a commission on what they collect.'))}

      <DoctorFormDialog open={!!editing} doctor={editing && editing !== 'new' ? editing : undefined} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting} destructive title={t('Delete {{name}}?', { name: deleting ? fullName(deleting) : '' })}
        message={t('A doctor who has appointments or owns a dental unit cannot be deleted.')}
        confirmLabel={t('Delete doctor')} busy={removeState.isLoading} onClose={() => setDeleting(null)}
        onConfirm={async () => { await remove(deleting!.id); setDeleting(null); }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Clinics, their doctors and dental units (admin)
// ---------------------------------------------------------------------------

function UnitRow({ unit }: { unit: UnitDto }) {
  const { t } = useTranslation();
  const [rename, renameState] = useRenameUnitMutation();
  const [remove, removeState] = useDeleteUnitMutation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(unit.name);
  const error = renameState.error ?? removeState.error;

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ flexGrow: 1, minWidth: 160 }}>
          <Typography fontWeight={600}>{unit.name}</Typography>
          <Typography variant="body2" color="text.secondary">{t('Owner: Dr {{name}}', { name: unit.ownerName })}</Typography>
        </Box>
        <IconButton aria-label={t('Rename {{name}}', { name: unit.name })} onClick={() => { setName(unit.name); setEditing(true); }}><EditIcon /></IconButton>
        <IconButton aria-label={t('Delete {{name}}', { name: unit.name })} onClick={() => remove(unit.id)}><DeleteOutlineIcon /></IconButton>
      </Box>
      {error != null && <Alert severity="error" sx={{ mt: 1 }}>{errorMessage(error)}</Alert>}
      <Dialog open={editing} onClose={() => setEditing(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('Rename dental unit')}</DialogTitle>
        <DialogContent><TextField label={t('Name')} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(false)}>{t('Cancel')}</Button>
          <Button variant="contained" disabled={!name.trim()} onClick={async () => { const r = await rename({ id: unit.id, name: name.trim() }); if (!r.error) setEditing(false); }}>{t('Save')}</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX = 512 * 1024;

function ClinicLogo({ clinic }: { clinic: ClinicDto }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [upload, uploading] = useUploadClinicLogoMutation();
  const [remove, removing] = useRemoveClinicLogoMutation();
  const [problem, setProblem] = useState<string | null>(null);
  const busy = uploading.isLoading || removing.isLoading;

  const pick = async (file: File | undefined) => {
    if (input.current) input.current.value = ''; // lets the same file be chosen again
    if (!file) return;
    setProblem(null);
    if (!LOGO_TYPES.includes(file.type)) return setProblem(t('Choose a PNG, JPEG or WebP image'));
    if (file.size > LOGO_MAX) return setProblem(t('The logo must be smaller than 512 KB'));
    const result = await upload({ id: clinic.id, file });
    if (result.error) setProblem(errorMessage(result.error));
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1 }}>
      <input
        ref={input} type="file" accept={LOGO_TYPES.join(',')} hidden aria-label={t('Clinic logo file')}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Button size="small" variant="outlined" startIcon={<UploadIcon />} disabled={busy} onClick={() => input.current?.click()}>
        {clinic.logoUrl ? t('Change logo') : t('Upload logo')}
      </Button>
      {clinic.logoUrl && (
        <Button size="small" color="error" disabled={busy} onClick={async () => { const r = await remove(clinic.id); if (r.error) setProblem(errorMessage(r.error)); }}>
          {t('Remove logo')}
        </Button>
      )}
      <Typography variant="caption" color="text.secondary">{t('PNG, JPEG or WebP, up to 512 KB')}</Typography>
      {problem && <Alert severity="error" sx={{ width: '100%' }} role="alert">{problem}</Alert>}
    </Box>
  );
}

function ClinicCard({ clinic }: { clinic: ClinicDto }) {
  const { t } = useTranslation();
  const { data: doctors = [] } = useGetDoctorsQuery();
  const { data: links = [] } = useGetClinicDoctorsQuery(clinic.id);
  const { data: units = [] } = useGetUnitsQuery(clinic.id);
  const [updateClinic, updateState] = useUpdateClinicMutation();
  const [deleteClinic, deleteState] = useDeleteClinicMutation();
  const [setLink, setState] = useSetClinicDoctorMutation();
  const [removeLink, removeState] = useRemoveClinicDoctorMutation();
  const [createUnit, createUnitState] = useCreateUnitMutation();
  const [addingUnit, setAddingUnit] = useState<{ name: string; ownerDoctorId: string } | null>(null);
  const [unitErrors, setUnitErrors] = useState<FieldErrors>({});
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [assign, setAssign] = useState<{ doctorId: number | null; drPart: string } | null>(null);
  const [assignErrors, setAssignErrors] = useState<FieldErrors>({});

  const assigned = new Set(links.map((l) => l.doctorId));
  const free = doctors.filter((d) => !assigned.has(d.id));
  const picked = doctors.find((d) => d.id === assign?.doctorId);
  // Only owner doctors who work at this clinic can own a unit.
  const owners = links.filter((l) => l.kind === 'owner');

  const saveUnit = async () => {
    const { data, errors } = validate(unitCreateSchema, {
      clinicId: clinic.id, ownerDoctorId: Number(addingUnit?.ownerDoctorId) || undefined, name: addingUnit?.name ?? '',
    });
    if (!data) return setUnitErrors({ ...errors!, ...(errors!.ownerDoctorId ? { ownerDoctorId: t('Choose the owner doctor') } : {}) });
    const result = await createUnit(data);
    if (!result.error) setAddingUnit(null);
  };

  const saveLink = async () => {
    if (!assign?.doctorId) return setAssignErrors({ doctorId: t('Choose a doctor') });
    const { data, errors } = validate(clinicDoctorInputSchema, { drPart: assign.drPart === '' ? undefined : assign.drPart });
    if (!data) return setAssignErrors(errors!);
    const result = await setLink({ clinicId: clinic.id, doctorId: assign.doctorId, body: data });
    if (!result.error) setAssign(null);
  };

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
          <Avatar variant="rounded" src={clinic.logoUrl ?? undefined} alt={clinic.logoUrl ? t('{{name}} logo', { name: clinic.name }) : ''} sx={{ width: 56, height: 56, bgcolor: 'primary.light', color: 'primary.contrastText' }}>
            <BusinessIcon />
          </Avatar>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="h6" component="h2">{clinic.name}</Typography>
            <Typography variant="body2" color="text.secondary">{[clinic.address, clinic.phone].filter(Boolean).join(' · ') || t('No address')}</Typography>
          </Box>
          <Button size="small" startIcon={<EditIcon />} onClick={() => { updateState.reset(); setEditing(true); }}>{t('Edit')}</Button>
          <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} onClick={() => { deleteState.reset(); setDeleting(true); }}>{t('Delete')}</Button>
        </Box>
        {deleteState.error && <Alert severity="error" sx={{ mt: 1 }}>{errorMessage(deleteState.error)}</Alert>}
        <ClinicLogo clinic={clinic} />

        <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>{t('Dental units')}</Typography>
        <Stack spacing={1}>
          {units.length === 0 && <Typography color="text.secondary" variant="body2">{t('No dental units yet. Assigning an owner doctor to this clinic creates their first one.')}</Typography>}
          {units.map((u) => <UnitRow key={u.id} unit={u} />)}
        </Stack>
        <Button
          sx={{ mt: 1 }} startIcon={<AddIcon />} disabled={owners.length === 0}
          title={owners.length === 0 ? t('Assign an owner doctor to this clinic first') : undefined}
          onClick={() => { createUnitState.reset(); setUnitErrors({}); setAddingUnit({ name: '', ownerDoctorId: String(owners[0]?.doctorId ?? '') }); }}
        >
          {t('Add dental unit')}
        </Button>

        <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>{t('Doctors who work here')}</Typography>
        {removeState.error && <Alert severity="error" sx={{ mb: 1 }}>{errorMessage(removeState.error)}</Alert>}
        {links.length === 0 && <Typography color="text.secondary" variant="body2">{t('No doctors assigned. Nobody can be booked here until you assign one.')}</Typography>}
        <Stack spacing={1}>
          {links.map((l) => (
            <Paper key={l.doctorId} variant="outlined" sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Box sx={{ flexGrow: 1, minWidth: 160 }}>
                <Typography fontWeight={600}>{fullName(l)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {t(KIND_LABEL[l.kind])}{l.speciality ? ` · ${l.speciality}` : ''}{l.drPart !== undefined ? ` · ${t('share {{percent}}%', { percent: l.drPart })}` : ''}
                </Typography>
              </Box>
              <IconButton aria-label={t('Edit share for {{name}}', { name: fullName(l) })} onClick={() => { setState.reset(); setAssignErrors({}); setAssign({ doctorId: l.doctorId, drPart: String(l.drPart ?? 100) }); }}><EditIcon /></IconButton>
              <IconButton aria-label={t('Remove {{name}} from this clinic', { name: fullName(l) })} onClick={() => { removeState.reset(); removeLink({ clinicId: clinic.id, doctorId: l.doctorId }); }}><DeleteOutlineIcon /></IconButton>
            </Paper>
          ))}
        </Stack>
        <Button sx={{ mt: 1 }} startIcon={<AddIcon />} disabled={free.length === 0} onClick={() => { setState.reset(); setAssignErrors({}); setAssign({ doctorId: free[0]?.id ?? null, drPart: '100' }); }}>
          {t('Assign doctor')}
        </Button>
      </CardContent>

      <FormDialog
        open={editing} title={t('Edit clinic')}
        fields={[{ key: 'name', label: t('Name'), required: true }, { key: 'address', label: t('Address') }, { key: 'phone', label: t('Phone'), type: 'tel' }]}
        initial={{ name: clinic.name, address: clinic.address ?? '', phone: clinic.phone ?? '' }}
        schema={clinicInputSchema} busy={updateState.isLoading} error={updateState.error}
        onClose={() => setEditing(false)}
        onSubmit={async (body) => { const r = await updateClinic({ id: clinic.id, body }); if (!r.error) setEditing(false); }}
      />
      <ConfirmDialog
        open={deleting} destructive title={t('Delete {{name}}?', { name: clinic.name })} message={t('Only the clinic is deleted. Its appointments and dental units stay, because they are part of the payment, commission and tax records, but they no longer belong to a clinic and can no longer be changed. An admin can review and delete them under “Deleted clinics’ data”.')}
        confirmLabel={t('Delete clinic')} busy={deleteState.isLoading} onClose={() => setDeleting(false)}
        onConfirm={async () => { await deleteClinic(clinic.id); setDeleting(false); }}
      />
      <Dialog open={!!addingUnit} onClose={() => setAddingUnit(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('Add dental unit')}</DialogTitle>
        <DialogContent>
          {createUnitState.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(createUnitState.error)}</Alert>}
          <TextField
            label={t('Name')} value={addingUnit?.name ?? ''} autoFocus required
            onChange={(e) => { setAddingUnit((a) => a && { ...a, name: e.target.value }); setUnitErrors((er) => ({ ...er, name: '' })); }}
            error={!!unitErrors.name} helperText={unitErrors.name}
          />
          <TextField
            select label={t('Owner doctor')} value={addingUnit?.ownerDoctorId ?? ''} required
            onChange={(e) => setAddingUnit((a) => a && { ...a, ownerDoctorId: e.target.value })}
            error={!!unitErrors.ownerDoctorId} helperText={unitErrors.ownerDoctorId || t('An external doctor who uses this unit pays the owner a commission')}
          >
            {owners.map((o) => <MenuItem key={o.doctorId} value={String(o.doctorId)}>{fullName(o)}</MenuItem>)}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddingUnit(null)}>{t('Cancel')}</Button>
          <Button variant="contained" onClick={saveUnit} disabled={createUnitState.isLoading}>{t('Add unit')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!assign} onClose={() => setAssign(null)} fullWidth maxWidth="xs">
        <DialogTitle>{assigned.has(assign?.doctorId ?? -1) ? t('Edit doctor’s share') : t('Assign doctor')}</DialogTitle>
        <DialogContent>
          {setState.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(setState.error)}</Alert>}
          <TextField
            select label={t('Doctor')} value={assign?.doctorId ?? ''} disabled={assigned.has(assign?.doctorId ?? -1)}
            onChange={(e) => setAssign((a) => a && { ...a, doctorId: Number(e.target.value) })}
            error={!!assignErrors.doctorId} helperText={assignErrors.doctorId}
          >
            {(assigned.has(assign?.doctorId ?? -1) ? doctors : free).map((d) => <MenuItem key={d.id} value={d.id}>{fullName(d)} ({t(KIND_LABEL[d.kind])})</MenuItem>)}
          </TextField>
          {picked?.kind === 'owner' && !assigned.has(picked.id) && (
            <Alert severity="info" sx={{ mb: 1 }}>{t('Dr {{name}} will get a dental unit at this clinic.', { name: picked.fname })}</Alert>
          )}
          <TextField
            label={t("Doctor's share (%)")} type="number" value={assign?.drPart ?? ''} onChange={(e) => setAssign((a) => a && { ...a, drPart: e.target.value })}
            error={!!assignErrors.drPart} helperText={assignErrors.drPart || t('100 means the doctor keeps everything')}
            slotProps={{ htmlInput: { min: 0, max: 100 } }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssign(null)}>{t('Cancel')}</Button>
          <Button variant="contained" onClick={saveLink} disabled={setState.isLoading}>{t('Save')}</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

function ClinicsPanel() {
  const { t } = useTranslation();
  const { data: clinics = [] } = useGetClinicsQuery();
  const [create, createState] = useCreateClinicMutation();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => { createState.reset(); setAdding(true); }}>{t('Add clinic')}</Button>
      </Box>
      {clinics.map((c) => <ClinicCard key={c.id} clinic={c} />)}
      <FormDialog
        open={adding} title={t('Add clinic')}
        fields={[{ key: 'name', label: t('Name'), required: true }, { key: 'address', label: t('Address') }, { key: 'phone', label: t('Phone'), type: 'tel' }]}
        initial={{ name: '', address: '', phone: '' }}
        schema={clinicInputSchema} busy={createState.isLoading} error={createState.error}
        onClose={() => setAdding(false)}
        onSubmit={async (body) => { const r = await create(body); if (!r.error) setAdding(false); }}
      />
    </>
  );
}

/** Doctors: admins manage everyone, owner doctors manage the external ones. */
export function DoctorsPage() {
  const { t } = useTranslation();
  const { isAdmin, isSpecialist } = useRole();
  // An external specialist doesn't manage the clinic's doctors.
  if (isSpecialist) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader
        title={t('Doctors')}
        subtitle={isAdmin ? t('Owner and external doctors, and their sign-in accounts') : t('Add and edit the external doctors who work with the clinic')}
      />
      <DoctorsPanel />
    </>
  );
}

/** Clinics, their dental units and who works where. Admin only. */
export function ClinicsPage() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  if (!isAdmin) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader title={t('Clinics')} subtitle={t('Clinics, dental units and who works where')} />
      <ClinicsPanel />
    </>
  );
}
