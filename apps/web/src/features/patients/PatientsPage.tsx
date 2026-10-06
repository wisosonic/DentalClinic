import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardActionArea, CardContent, InputAdornment, Link, Paper, Skeleton, Stack, Table, TableBody,
  TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { SortCell, useSort } from '../../components/SortHead';
import { PageHeader } from '../../components/PageHeader';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate, fullName } from '../../lib/format';
import { useDebounce } from '../../lib/useDebounce';
import { useListPatientsQuery } from '../clinical/clinicalApi';
import { PatientFormDialog } from './PatientFormDialog';

export function PatientsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mobile = useMediaQuery(useTheme().breakpoints.down('md'));
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [creating, setCreating] = useState(false);
  const q = useDebounce(search.trim());

  const sort = useSort<'name' | 'phone' | 'number' | 'lastVisit'>('name');
  const { data, isFetching, error } = useListPatientsQuery({ q, page: page + 1, pageSize, sort: sort.key, order: sort.order });
  useEffect(() => setPage(0), [sort.key, sort.order]); // a new order starts from the first page
  const patients = data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('Patients')}
        subtitle={data ? (data.meta.total === 1 ? t('{{n}} patient', { n: data.meta.total }) : t('{{n}} patients', { n: data.meta.total })) : undefined}
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)}>
            {t('New patient')}
          </Button>
        }
      />

      <TextField
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
        placeholder={t('Search by name, phone or patient number')}
        fullWidth
        margin="none"
        sx={{ mb: 2, maxWidth: 520 }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          },
          htmlInput: { 'aria-label': t('Search patients') },
        }}
      />

      {error && <Alert severity="error">{errorMessage(error)}</Alert>}

      {!data && isFetching ? (
        <Stack spacing={1}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} variant="rounded" height={mobile ? 72 : 48} />
          ))}
        </Stack>
      ) : patients.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography>{q ? t('No patients match “{{q}}”.', { q }) : t('No patients yet.')}</Typography>
        </Paper>
      ) : mobile ? (
        <Stack spacing={1} sx={{ opacity: isFetching ? 0.6 : 1 }}>
          {patients.map((p) => (
            <Card key={p.id} variant="outlined">
              <CardActionArea onClick={() => navigate(`/patients/${p.id}`)} sx={{ minHeight: 64 }}>
                <CardContent>
                  <Typography fontWeight={600}>{fullName(p)}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    <bdi dir="ltr">{p.phone}</bdi> · #{p.patientIdentifier}
                  </Typography>
                  {p.lastVisit && (
                    <Typography variant="caption" color="text.secondary">
                      {t('Last visit {{date}}', { date: formatDate(p.lastVisit) })}
                    </Typography>
                  )}
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table>
            <TableHead>
              <TableRow>
                <SortCell field="name" sort={sort}>{t('Name')}</SortCell>
                <SortCell field="phone" sort={sort}>{t('Phone')}</SortCell>
                <SortCell field="number" sort={sort}>{t('Patient #')}</SortCell>
                <SortCell field="lastVisit" sort={sort}>{t('Last visit')}</SortCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {patients.map((p) => (
                <TableRow key={p.id} hover onClick={() => navigate(`/patients/${p.id}`)} sx={{ cursor: 'pointer' }}>
                  <TableCell>
                    <Link component={RouterLink} to={`/patients/${p.id}`} onClick={(e) => e.stopPropagation()} color="inherit" underline="hover" fontWeight={600}>
                      {fullName(p)}
                    </Link>
                  </TableCell>
                  <TableCell><bdi dir="ltr">{p.phone}</bdi></TableCell>
                  <TableCell>{p.patientIdentifier}</TableCell>
                  <TableCell>{formatDate(p.lastVisit) || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {data && data.meta.total > 0 && (
        <TablePagination
          component="div"
          count={data.meta.total}
          page={page}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[10, 25, 50, 100]}
          labelRowsPerPage={t('Rows per page:')}
          labelDisplayedRows={({ from, to, count }) => t('{{from}}–{{to}} of {{count}}', { from, to, count })}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => {
            setPageSize(Number(e.target.value));
            setPage(0);
          }}
        />
      )}

      <PatientFormDialog open={creating} onClose={() => setCreating(false)} onSaved={(p) => navigate(`/patients/${p.id}`)} />
    </>
  );
}
