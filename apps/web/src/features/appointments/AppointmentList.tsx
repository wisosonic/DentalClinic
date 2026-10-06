import { useEffect, useState } from 'react';
import {
  Alert, Box, Card, CardActionArea, CardContent, Chip, MenuItem, Paper, Skeleton, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TablePagination, TableRow, TextField, Typography, useMediaQuery,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import { useTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import { APPOINTMENT_STATUSES } from '@aya/shared';
import { StatusChip } from '../../components/StatusChip';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName, statusLabel } from '../../lib/format';
import { useDebounce } from '../../lib/useDebounce';
import { SortCell, useSort } from '../../components/SortHead';
import { useGetDoctorsQuery, useGetUnitsQuery, useListAppointmentsQuery } from '../clinical/clinicalApi';

export function AppointmentList({ onSelect }: { onSelect: (id: number) => void }) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(useTheme().breakpoints.down('md'));
  const [status, setStatus] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const q = useDebounce(search.trim());
  const sort = useSort<'date' | 'time' | 'patient' | 'doctor' | 'unit' | 'status' | 'report'>('date', 'desc');
  const { data: doctors = [] } = useGetDoctorsQuery();
  const { data: units = [] } = useGetUnitsQuery();
  useEffect(() => setPage(0), [sort.key, sort.order]); // a new order starts from the first page

  const { data, isFetching, error } = useListAppointmentsQuery({
    page: page + 1, pageSize, q, status: status || undefined, doctorId: doctorId ? Number(doctorId) : undefined,
    unitId: unitId ? Number(unitId) : undefined,
    from: from || undefined, to: to || undefined, sort: sort.key, order: sort.order,
  });
  const rows = data?.data ?? [];
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  return (
    <>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', columnGap: 2, mb: 1 }}>
        <TextField label={t('Search patient')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} margin="dense" />
        <TextField select label={t('Status')} value={status} onChange={(e) => reset(setStatus)(e.target.value)} margin="dense">
          <MenuItem value="">{t('All')}</MenuItem>
          {APPOINTMENT_STATUSES.map((s) => <MenuItem key={s} value={s}>{statusLabel(s)}</MenuItem>)}
        </TextField>
        <TextField select label={t('Doctor')} value={doctorId} onChange={(e) => reset(setDoctorId)(e.target.value)} margin="dense">
          <MenuItem value="">{t('All')}</MenuItem>
          {doctors.map((d) => <MenuItem key={d.id} value={String(d.id)}>{fullName(d)}</MenuItem>)}
        </TextField>
        <TextField select label={t('Dental unit')} value={unitId} onChange={(e) => reset(setUnitId)(e.target.value)} margin="dense">
          <MenuItem value="">{t('All')}</MenuItem>
          {units.map((u) => <MenuItem key={u.id} value={String(u.id)}>{u.name}</MenuItem>)}
        </TextField>
        <TextField label={t('From')} type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} margin="dense" slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label={t('To')} type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} margin="dense" slotProps={{ inputLabel: { shrink: true } }} />
      </Box>

      {error && <Alert severity="error">{errorMessage(error)}</Alert>}

      {!data && isFetching ? (
        <Stack spacing={1}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={mobile ? 84 : 48} />)}</Stack>
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('No appointments match these filters.')}</Typography></Paper>
      ) : mobile ? (
        <Stack spacing={1} sx={{ opacity: isFetching ? 0.6 : 1 }}>
          {rows.map((a) => (
            <Card key={a.id} variant="outlined">
              <CardActionArea onClick={() => onSelect(a.id)} sx={{ minHeight: 64 }}>
                <CardContent>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                    <Typography fontWeight={600}>{fullName(a.patient)}</Typography>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      {a.hasReport && <Chip size="small" color="success" variant="outlined" icon={<DescriptionIcon />} label={t('Report')} />}
                      <StatusChip status={a.status} />
                    </Box>
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {formatDate(a.date)} · <bdi dir="ltr">{a.time}–{a.endTime}</bdi> · {t('Dr {{name}}', { name: `${a.doctor.fname} ${a.doctor.lname}` })}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="date" sort={sort}>{t('Date')}</SortCell><SortCell field="time" sort={sort}>{t('Time')}</SortCell>
                <SortCell field="patient" sort={sort}>{t('Patient')}</SortCell><SortCell field="doctor" sort={sort}>{t('Doctor')}</SortCell>
                <SortCell field="unit" sort={sort}>{t('Dental unit')}</SortCell><SortCell field="status" sort={sort}>{t('Status')}</SortCell><SortCell field="report" sort={sort}>{t('Report')}</SortCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((a) => (
                <TableRow
                  key={a.id} hover tabIndex={0} sx={{ cursor: 'pointer' }}
                  onClick={() => onSelect(a.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(a.id)}
                >
                  <TableCell>{formatDate(a.date)}</TableCell>
                  <TableCell><bdi dir="ltr">{a.time}–{a.endTime}</bdi></TableCell>
                  <TableCell>{fullName(a.patient)}</TableCell>
                  <TableCell>{fullName(a.doctor)}</TableCell>
                  <TableCell>{a.unit?.name ?? '—'}</TableCell>
                  <TableCell><StatusChip status={a.status} /></TableCell>
                  <TableCell>
                    {a.hasReport ? <Chip size="small" color="success" variant="outlined" icon={<DescriptionIcon />} label={t('Written')} /> : <Typography variant="body2" color="text.secondary">—</Typography>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {data && data.meta.total > 0 && (
        <TablePagination
          component="div" count={data.meta.total} page={page} rowsPerPage={pageSize} rowsPerPageOptions={[10, 25, 50, 100]}
          labelRowsPerPage={t('Rows per page:')}
          labelDisplayedRows={({ from: f, to: tt, count }) => t('{{from}}–{{to}} of {{count}}', { from: f, to: tt, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        />
      )}
    </>
  );
}
