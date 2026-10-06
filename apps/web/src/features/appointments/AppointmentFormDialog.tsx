import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { appointmentInputSchema, DEFAULT_DURATION, type AppointmentDto, type BusyPeriodDto } from '@aya/shared';
import { translate } from '../../i18n';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { useDebounce } from '../../lib/useDebounce';
import { validate, type FieldErrors } from '../../lib/zodForm';
import {
  useCreateAppointmentMutation,
  useGetBusyQuery,
  useGetCategoriesQuery,
  useGetClinicDoctorsQuery,
  useGetClinicsQuery,
  useGetConfigQuery,
  useGetUnitsQuery,
  useListPatientsQuery,
  useUpdateAppointmentMutation,
} from '../clinical/clinicalApi';
import { useScheduleOfferItemMutation } from '../offers/offersApi';

export interface FormDefaults {
  date?: string;
  time?: string;
  unitId?: number;
  patient?: { id: number; fname: string; lname: string };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Edit this appointment; omit to book a new one. */
  appointment?: AppointmentDto;
  defaults?: FormDefaults;
  onSaved?: (appointment: AppointmentDto) => void;
  /** Book this item of a treatment offer: the patient, procedure and reason come from the offer. */
  offerItem?: { offerId: number; itemId: number; description: string; categoryId: number | null };
}

type PatientOption = { id: number; fname: string; lname: string; phone?: string };

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const endOf = (t: string, minutes: number) => {
  const m = toMinutes(t) + minutes;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** 90 -> "1 h 30 min" (or its Arabic equivalent). */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? translate('{{n}} h', { n: h }) : '', m ? translate('{{n}} min', { n: m }) : ''].filter(Boolean).join(' ');
}

const DURATIONS = [...Array.from({ length: 16 }, (_, i) => (i + 1) * 15), 300, 360, 420, 480];

export function AppointmentFormDialog({ open, onClose, appointment, defaults, onSaved, offerItem }: Props) {
  const { t } = useTranslation();
  const editing = !!appointment;
  const { canComplete, isSpecialist, doctorId: myDoctorId } = useRole(); // doctors and admins may change a length
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [patientInput, setPatientInput] = useState('');
  const [clinicId, setClinicId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [intended, setIntended] = useState('');
  const [status, setStatus] = useState<'confirmed' | 'pending'>('confirmed');
  const [errors, setErrors] = useState<FieldErrors>({});

  const { data: config } = useGetConfigQuery(undefined, { skip: !open });
  const { data: clinics = [] } = useGetClinicsQuery(undefined, { skip: !open });
  const { data: categories = [] } = useGetCategoriesQuery(undefined, { skip: !open });
  const { data: clinicDoctors = [] } = useGetClinicDoctorsQuery(Number(clinicId), { skip: !open || !clinicId });
  const { data: units = [] } = useGetUnitsQuery(Number(clinicId) || undefined, { skip: !open || !clinicId });
  const search = useDebounce(patientInput.trim());
  const { data: found, isFetching: searching } = useListPatientsQuery({ q: search, pageSize: 10 }, { skip: !open || editing });
  const [create, createState] = useCreateAppointmentMutation();
  const [update, updateState] = useUpdateAppointmentMutation();
  const [schedule, scheduleState] = useScheduleOfferItemMutation();
  const busy = createState.isLoading || updateState.isLoading || scheduleState.isLoading;
  const serverError = createState.error ?? updateState.error ?? scheduleState.error;

  // Reset whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    createState.reset();
    updateState.reset();
    scheduleState.reset();
    setErrors({});
    setPatientInput('');
    if (appointment) {
      setPatient({ ...appointment.patient });
      setClinicId(String(appointment.clinicId));
      setUnitId(appointment.unitId ? String(appointment.unitId) : '');
      setDoctorId(String(appointment.doctorId));
      setDate(appointment.date);
      setTime(appointment.time);
      setDuration(appointment.durationMinutes);
      setCategoryIds(appointment.categories.map((c) => c.id));
      setIntended(appointment.intended ?? '');
    } else {
      setPatient(defaults?.patient ?? null);
      setClinicId('');
      setUnitId(defaults?.unitId ? String(defaults.unitId) : '');
      setDoctorId('');
      setDate(defaults?.date ?? '');
      setTime(defaults?.time ?? '');
      setDuration(config?.defaultDuration ?? DEFAULT_DURATION);
      setCategoryIds(offerItem?.categoryId ? [offerItem.categoryId] : []);
      setIntended(offerItem?.description ?? '');
      setStatus('confirmed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appointment, defaults]);

  // Sensible defaults: the only clinic, and the unit that belongs to the chosen owner doctor.
  useEffect(() => {
    if (open && !clinicId && clinics.length >= 1) setClinicId(String(clinics[0]!.id));
  }, [open, clinicId, clinics]);
  useEffect(() => {
    if (open && !doctorId && clinicDoctors.length === 1) setDoctorId(String(clinicDoctors[0]!.doctorId));
  }, [open, doctorId, clinicDoctors]);
  // A specialist books himself, and nobody else.
  useEffect(() => {
    if (open && isSpecialist && myDoctorId && !editing && doctorId !== String(myDoctorId)) setDoctorId(String(myDoctorId));
  }, [open, isSpecialist, myDoctorId, editing, doctorId]);
  // A unit was chosen first (from the by-unit view): suggest its owner as the doctor.
  useEffect(() => {
    if (!open || doctorId || !unitId) return;
    const owner = units.find((u) => u.id === Number(unitId))?.ownerDoctorId;
    if (owner && clinicDoctors.some((d) => d.doctorId === owner)) setDoctorId(String(owner));
  }, [open, doctorId, unitId, units, clinicDoctors]);
  useEffect(() => {
    if (!open || unitId || !doctorId) return;
    const own = units.find((u) => u.ownerDoctorId === Number(doctorId));
    if (own) setUnitId(String(own.id));
  }, [open, unitId, doctorId, units]);

  const canCheck = open && !!doctorId && !!unitId && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const { data: busyData, isFetching: loadingBusy } = useGetBusyQuery(
    { doctorId: Number(doctorId), unitId: Number(unitId), date, excludeId: appointment?.id },
    { skip: !canCheck, refetchOnMountOrArgChange: true },
  );

  const patientOptions = useMemo<PatientOption[]>(() => {
    const list = found?.data ?? [];
    return patient && !list.some((p) => p.id === patient.id) ? [patient, ...list] : list;
  }, [found, patient]);

  // The server says "Another patient" for someone the viewer may not know about.
  const who = (name: string) => translate(name);

  // Warn as soon as the chosen time overlaps something, before the server has to refuse it.
  const conflict = useMemo(() => {
    if (!busyData || !/^\d{2}:\d{2}$/.test(time)) return null;
    const start = toMinutes(time);
    const end = start + duration;
    const hit = (p: BusyPeriodDto) => toMinutes(p.start) < end && start < toMinutes(p.start) + p.durationMinutes;
    const doctorHit = busyData.doctorBusy.find(hit);
    if (doctorHit) return t('The doctor is busy from {{start}} to {{end}} ({{who}}).', { start: doctorHit.start, end: doctorHit.end, who: who(doctorHit.patientName) });
    const unitHit = busyData.unitBusy.find(hit);
    if (unitHit) return t('The dental unit is in use from {{start}} to {{end}} ({{who}}).', { start: unitHit.start, end: unitHit.end, who: who(unitHit.patientName) });
    return null;
     
  }, [busyData, time, duration, t]);
  const pastMidnight = /^\d{2}:\d{2}$/.test(time) && toMinutes(time) + duration > 1440;

  const submit = async () => {
    const draft = {
      patientId: patient?.id, doctorId: Number(doctorId) || undefined, clinicId: Number(clinicId) || undefined,
      unitId: Number(unitId) || undefined, date, time, durationMinutes: duration, intended, categoryIds,
      ...(editing ? {} : { status }),
    };
    const { errors: found } = validate(appointmentInputSchema, draft);
    if (found) {
      const friendly: FieldErrors = { ...found };
      if (found.patientId) friendly.patientId = t('Choose a patient');
      if (found.doctorId) friendly.doctorId = t('Choose a doctor');
      if (found.clinicId) friendly.clinicId = t('Choose a clinic');
      if (found.unitId) friendly.unitId = t('Choose a dental unit');
      if (found.date) friendly.date = t('Choose a date');
      if (found.time) friendly.time = t('Choose a time');
      return setErrors(friendly);
    }

    if (offerItem) {
      const scheduled = await schedule({
        id: offerItem.offerId, itemId: offerItem.itemId,
        body: { doctorId: Number(doctorId), clinicId: Number(clinicId), unitId: Number(unitId), date, time, durationMinutes: duration },
      });
      if (scheduled.data) onClose();
      return;
    }
    let result;
    if (appointment) {
      const body: Record<string, unknown> = {};
      if (Number(doctorId) !== appointment.doctorId) body.doctorId = Number(doctorId);
      if (Number(clinicId) !== appointment.clinicId) body.clinicId = Number(clinicId);
      if (Number(unitId) !== appointment.unitId) body.unitId = Number(unitId);
      if (date !== appointment.date) body.date = date;
      if (time !== appointment.time) body.time = time;
      if (duration !== appointment.durationMinutes) body.durationMinutes = duration;
      if ((intended || null) !== (appointment.intended || null)) body.intended = intended || null;
      if (!Object.keys(body).length) return onClose();
      result = await update({ id: appointment.id, body });
    } else {
      result = await create({ ...draft, intended: intended || null });
    }
    if (result.data) {
      onSaved?.(result.data);
      onClose();
    }
  };

  const busyChips = (title: string, list: BusyPeriodDto[]) => (
    <Box sx={{ mb: 1 }}>
      <Typography variant="caption" color="text.secondary">{title}</Typography>
      <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
        {list.length === 0 && <Typography variant="body2" color="text.secondary">{t('Nothing booked')}</Typography>}
        {list.map((p) => (
          <Chip key={p.appointmentId} size="small" variant="outlined" label={`${p.start}–${p.end} · ${who(p.patientName)}`} />
        ))}
      </Stack>
    </Box>
  );

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? t('Edit appointment') : offerItem ? t('Book a visit for this treatment') : t('Book appointment')}</DialogTitle>
      <DialogContent>
        {serverError && (
          <Alert severity="error" sx={{ mb: 1 }} role="alert">
            {errorMessage(serverError)}
          </Alert>
        )}

        <Autocomplete
          options={patientOptions}
          value={patient}
          disabled={editing || !!offerItem}
          loading={searching}
          filterOptions={(x) => x} // the server already filtered
          getOptionLabel={(p) => fullName(p)}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          onChange={(_e, v) => {
            setPatient(v);
            setErrors((e) => ({ ...e, patientId: '' }));
          }}
          onInputChange={(_e, v, reason) => reason === 'input' && setPatientInput(v)}
          noOptionsText={patientInput ? t('No matching patients') : t('Type a name or phone number')}
          loadingText={t('Loading…')}
          renderOption={(props, p) => (
            <li {...props} key={p.id}>
              <Box>
                <Typography>{fullName(p)}</Typography>
                {p.phone && <Typography variant="caption" color="text.secondary"><bdi dir="ltr">{p.phone}</bdi></Typography>}
              </Box>
            </li>
          )}
          renderInput={(params) => (
            <TextField {...params} label={t('Patient')} required error={!!errors.patientId} helperText={errors.patientId || undefined} />
          )}
        />

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', columnGap: 2 }}>
          <TextField
            select label={t('Clinic')} value={clinicId} required
            onChange={(e) => { setClinicId(e.target.value); setUnitId(''); setDoctorId(''); }}
            error={!!errors.clinicId} helperText={errors.clinicId || undefined}
          >
            {clinics.map((c) => <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>)}
          </TextField>
          <TextField
            select label={t('Doctor')} value={doctorId} required disabled={!clinicId || (isSpecialist && !editing)}
            onChange={(e) => { setDoctorId(e.target.value); setUnitId(''); }}
            error={!!errors.doctorId}
            helperText={errors.doctorId || (clinicId && clinicDoctors.length === 0 ? t('No doctors are assigned to this clinic yet') : undefined)}
          >
            {clinicDoctors.map((d) => (
              <MenuItem key={d.doctorId} value={String(d.doctorId)}>
                {fullName(d)}{d.kind === 'external' ? ` ${t('(external)')}` : ''}
              </MenuItem>
            ))}
          </TextField>
        </Box>

        <TextField
          select label={t('Dental unit')} value={unitId} required disabled={!clinicId}
          onChange={(e) => { setUnitId(e.target.value); setErrors((er) => ({ ...er, unitId: '' })); }}
          error={!!errors.unitId} helperText={errors.unitId || t('The commission of an external doctor goes to the unit’s owner')}
        >
          {units.map((u) => <MenuItem key={u.id} value={String(u.id)}>{u.name}</MenuItem>)}
        </TextField>

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', columnGap: 2 }}>
          <TextField
            label={t('Date')} type="date" value={date} required
            onChange={(e) => { setDate(e.target.value); setErrors((er) => ({ ...er, date: '' })); }}
            error={!!errors.date} helperText={errors.date || (date ? formatDate(date) : undefined)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label={t('Start time')} type="time" value={time} required
            onChange={(e) => { setTime(e.target.value); setErrors((er) => ({ ...er, time: '' })); }}
            error={!!errors.time} helperText={errors.time || (time ? t('Ends at {{time}}', { time: endOf(time, duration) }) : undefined)}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { step: 900 } }}
          />
          <TextField
            select label={t('Length')} value={duration} required
            disabled={editing && !canComplete}
            onChange={(e) => setDuration(Number(e.target.value))}
            helperText={editing && !canComplete ? t('Only a doctor or an admin can change the length') : undefined}
          >
            {DURATIONS.map((m) => <MenuItem key={m} value={m}>{durationLabel(m)}</MenuItem>)}
          </TextField>
        </Box>

        {canCheck && (
          <Box sx={{ mt: 1, mb: 1 }}>
            {loadingBusy && <CircularProgress size={18} aria-label={t('Checking the schedule')} />}
            {busyData && (
              <>
                {busyChips(t('Doctor already booked this day'), busyData.doctorBusy)}
                {busyChips(t('Dental unit in use this day'), busyData.unitBusy)}
              </>
            )}
          </Box>
        )}
        {conflict && <Alert severity="warning" sx={{ mb: 1 }}>{conflict}</Alert>}
        {pastMidnight && <Alert severity="warning" sx={{ mb: 1 }}>{t('The appointment must end before midnight.')}</Alert>}

        <Autocomplete
          multiple
          options={categories}
          value={categories.filter((c) => categoryIds.includes(c.id))}
          getOptionLabel={(c) => c.name}
          onChange={(_e, v) => setCategoryIds(v.map((c) => c.id))}
          renderInput={(params) => <TextField {...params} label={t('Procedures')} />}
          disabled={editing || !!offerItem}
        />
        <TextField label={t('Reason / notes')} value={intended} onChange={(e) => setIntended(e.target.value)} multiline minRows={2} disabled={!!offerItem} />

        {!editing && !offerItem && (
          <TextField select label={t('Status')} value={status} onChange={(e) => setStatus(e.target.value as 'confirmed' | 'pending')}>
            <MenuItem value="confirmed">{t('Confirmed')}</MenuItem>
            <MenuItem value="pending">{t('Pending (awaiting confirmation)')}</MenuItem>
          </TextField>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !!conflict || pastMidnight}>
          {busy ? t('Saving…') : editing ? t('Save changes') : t('Book')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
