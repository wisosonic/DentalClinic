import { Suspense, lazy, useState } from 'react';
import { Box, Button, Checkbox, CircularProgress, FormControlLabel, MenuItem, Tab, Tabs, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/PageHeader';
import { fullName } from '../../lib/format';
import { useGetDoctorsQuery, useGetUnitsQuery } from '../clinical/clinicalApi';
import { AppointmentList } from './AppointmentList';
import { useAppointmentDialogs } from './AppointmentDialogs';

// FullCalendar is large; only load it when this page is opened.
const CalendarView = lazy(() => import('./CalendarView'));
const UnitDayView = lazy(() => import('./UnitDayView'));

export function AppointmentsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'calendar' | 'units' | 'list'>('calendar');
  const [doctorId, setDoctorId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const { data: doctors = [] } = useGetDoctorsQuery();
  const { data: units = [] } = useGetUnitsQuery();
  const { dialogs, openDetail, openCreate } = useAppointmentDialogs();

  return (
    <>
      <PageHeader
        title={t('Appointments')}
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => openCreate()}>
            {t('Book appointment')}
          </Button>
        }
      />

      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, mb: 2 }}>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} aria-label={t('Appointment views')}>
          <Tab value="calendar" label={t('Calendar')} />
          <Tab value="units" label={t('By unit')} />
          <Tab value="list" label={t('List')} />
        </Tabs>
        {tab === 'units' && (
          <FormControlLabel control={<Checkbox checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />} label={t('Show cancelled')} />
        )}
        {tab === 'calendar' && (
          <>
            <TextField select size="small" label={t('Doctor')} value={doctorId} onChange={(e) => setDoctorId(e.target.value)} margin="none" sx={{ minWidth: 180 }}>
              <MenuItem value="">{t('All doctors')}</MenuItem>
              {doctors.map((d) => <MenuItem key={d.id} value={String(d.id)}>{fullName(d)}</MenuItem>)}
            </TextField>
            <TextField select size="small" label={t('Dental unit')} value={unitId} onChange={(e) => setUnitId(e.target.value)} margin="none" sx={{ minWidth: 180 }}>
              <MenuItem value="">{t('All units')}</MenuItem>
              {units.map((u) => <MenuItem key={u.id} value={String(u.id)}>{u.name}</MenuItem>)}
            </TextField>
            <FormControlLabel control={<Checkbox checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />} label={t('Show cancelled')} />
          </>
        )}
      </Box>

      {tab === 'units' ? (
        <Suspense fallback={<CircularProgress aria-label={t('Loading')} />}>
          <UnitDayView
            showCancelled={showCancelled}
            onSelect={openDetail}
            onCreateAt={(date, time, unitId) => openCreate({ date, time, unitId })}
          />
        </Suspense>
      ) : tab === 'calendar' ? (
        <Suspense fallback={<CircularProgress aria-label={t('Loading calendar')} />}>
          <CalendarView
            doctorId={doctorId ? Number(doctorId) : undefined}
            unitId={unitId ? Number(unitId) : undefined}
            showCancelled={showCancelled}
            onSelect={openDetail}
            onCreateAt={(date, time) => openCreate({ date, time })}
          />
        </Suspense>
      ) : (
        <AppointmentList onSelect={openDetail} />
      )}
      {dialogs}
    </>
  );
}
