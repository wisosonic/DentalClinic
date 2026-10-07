import { useState } from 'react';
import {
  Alert, Box, Button, Chip, IconButton, Paper, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import type { DeletedClinicDataDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { StatusChip } from '../../components/StatusChip';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { api } from '../auth/authApi';
import { useDeleteAppointmentMutation, useDeleteUnitMutation } from '../clinical/clinicalApi';
import { TimeText } from '../../lib/useTime';

const deletedApi = api.injectEndpoints({
  endpoints: (build) => ({
    deletedClinicData: build.query<DeletedClinicDataDto, void>({ query: () => '/clinics/deleted-data', providesTags: ['Clinic', 'Appointment', 'Unit'] }),
  }),
});
const { useDeletedClinicDataQuery } = deletedApi;

type Appt = DeletedClinicDataDto['appointments'][number];
type Unit = DeletedClinicDataDto['units'][number];
type ApptKey = 'date' | 'patient' | 'doctor' | 'unit' | 'status' | 'report';
type UnitKey = 'name' | 'owner' | 'appointments';

/**
 * What deleted clinics left behind (admin only). Deleting a clinic removes only its record: its appointments and
 * dental units stay, because they feed the payment, commission and tax figures. They are read-only here and
 * everywhere else; an admin can delete them.
 */
export function DeletedClinicsPage() {
  const { t } = useTranslation();
  const { data, error, isFetching } = useDeletedClinicDataQuery();
  const apptSort = useSort<ApptKey>('date', 'desc');
  const unitSort = useSort<UnitKey>('name');
  const [removeAppt, apptState] = useDeleteAppointmentMutation();
  const [removeUnit, unitState] = useDeleteUnitMutation();
  const [deletingAppt, setDeletingAppt] = useState<Appt | null>(null);
  const [deletingUnit, setDeletingUnit] = useState<Unit | null>(null);

  const appts = sortRows(
    data?.appointments ?? [],
    (a) => ({ date: `${a.date} ${a.time}`, patient: fullName(a.patient), doctor: fullName(a.doctor), unit: a.unit?.name ?? null, status: a.status, report: a.hasReport ? 1 : 0 })[apptSort.key],
    apptSort.order,
  );
  const units = sortRows(data?.units ?? [], (u) => ({ name: u.name, owner: u.ownerName, appointments: u.appointments })[unitSort.key], unitSort.order);
  const failure = apptState.error ?? unitState.error;

  return (
    <>
      <PageHeader title={t('Deleted clinics’ data')} subtitle={t('Records that belong to clinics that were deleted. They stay for the payment, commission and tax records and cannot be changed.')} />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {failure != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(failure)}</Alert>}

      {!data ? (
        <Skeleton variant="rounded" height={160} aria-label={t('Loading')} />
      ) : data.appointments.length === 0 && data.units.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}><Typography>{t('No clinic has been deleted, or nothing was left behind.')}</Typography></Paper>
      ) : (
        <Box sx={{ display: 'grid', gap: 3, opacity: isFetching ? 0.6 : 1 }}>
          <Box component="section" aria-label={t('Appointments')}>
            <Typography variant="h6" component="h2" gutterBottom>{t('Appointments')}</Typography>
            {appts.length === 0 ? (
              <Typography color="text.secondary">{t('No appointments.')}</Typography>
            ) : (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label={t('Appointments')}>
                  <TableHead>
                    <TableRow>
                      <SortCell field="date" sort={apptSort}>{t('Date')}</SortCell>
                      <SortCell field="patient" sort={apptSort}>{t('Patient')}</SortCell>
                      <SortCell field="doctor" sort={apptSort}>{t('Doctor')}</SortCell>
                      <SortCell field="unit" sort={apptSort}>{t('Dental unit')}</SortCell>
                      <SortCell field="status" sort={apptSort}>{t('Status')}</SortCell>
                      <SortCell field="report" sort={apptSort}>{t('Report')}</SortCell>
                      <TableCell align="right">{t('Actions')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {appts.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(a.date)} <TimeText value={a.time} /></TableCell>
                        <TableCell><RouterLink to={`/patients/${a.patient.id}`}>{fullName(a.patient)}</RouterLink></TableCell>
                        <TableCell>{fullName(a.doctor)}</TableCell>
                        <TableCell>{a.unit?.name ?? '—'}</TableCell>
                        <TableCell><StatusChip status={a.status} /></TableCell>
                        <TableCell>{a.hasReport ? <Chip size="small" color="primary" variant="outlined" label={t('Written')} /> : '—'}</TableCell>
                        <TableCell align="right">
                          <Tooltip title={t('Delete')}>
                            <IconButton size="small" aria-label={t('Delete the appointment of {{name}} on {{date}}', { name: fullName(a.patient), date: formatDate(a.date) })} onClick={() => { apptState.reset(); setDeletingAppt(a); }}>
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>

          <Box component="section" aria-label={t('Dental units')}>
            <Typography variant="h6" component="h2" gutterBottom>{t('Dental units')}</Typography>
            {units.length === 0 ? (
              <Typography color="text.secondary">{t('No dental units.')}</Typography>
            ) : (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small" aria-label={t('Dental units')}>
                  <TableHead>
                    <TableRow>
                      <SortCell field="name" sort={unitSort}>{t('Name')}</SortCell>
                      <SortCell field="owner" sort={unitSort}>{t('Owner')}</SortCell>
                      <SortCell field="appointments" sort={unitSort} align="right">{t('Appointments')}</SortCell>
                      <TableCell align="right">{t('Actions')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {units.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>{u.name}</TableCell>
                        <TableCell>{t('Dr. {{name}}', { name: u.ownerName })}</TableCell>
                        <TableCell align="right">{u.appointments}</TableCell>
                        <TableCell align="right">
                          <Tooltip title={u.appointments > 0 ? t('Appointments are still on this unit') : t('Delete')}>
                            <span>
                              <IconButton size="small" disabled={u.appointments > 0} aria-label={t('Delete {{name}}', { name: u.name })} onClick={() => { unitState.reset(); setDeletingUnit(u); }}>
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
              {t('A dental unit that appointments were booked on is kept, because commission is worked out from it. Delete its appointments first.')}
            </Typography>
          </Box>
        </Box>
      )}

      <ConfirmDialog
        open={!!deletingAppt} destructive title={t('Delete this appointment?')}
        message={t('It goes to the Trash. Only an administrator can restore it or erase it for good.')}
        confirmLabel={t('Delete appointment')} busy={apptState.isLoading} onClose={() => setDeletingAppt(null)}
        onConfirm={async () => { await removeAppt(deletingAppt!.id); setDeletingAppt(null); }}
      />
      <ConfirmDialog
        open={!!deletingUnit} destructive title={t('Delete this dental unit?')}
        message={t('The unit is removed. Nothing is booked on it.')}
        confirmLabel={t('Delete dental unit')} busy={unitState.isLoading} onClose={() => setDeletingUnit(null)}
        onConfirm={async () => { await removeUnit(deletingUnit!.id); setDeletingUnit(null); }}
      />
      <Button component={RouterLink} to="/settings/clinics" sx={{ mt: 2 }}>{t('Back to clinics')}</Button>
    </>
  );
}
