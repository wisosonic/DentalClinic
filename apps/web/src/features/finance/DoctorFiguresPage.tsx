import { useMemo } from 'react';
import { Alert, Chip, Paper, Skeleton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { DoctorFiguresDto } from '@aya/shared';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { useRole } from '../../components/useRole';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { formatMoney } from '../../lib/money';
import { useDoctorFiguresQuery } from './financeApi';
import { PeriodPicker, usePeriod } from './PeriodPicker';

type SortKey = 'name' | 'kind' | 'offers' | 'value' | 'collected' | 'debts' | 'commission' | 'fees';

const value = (d: DoctorFiguresDto, key: SortKey): string | number | null =>
  ({ name: fullName(d.doctor), kind: d.doctor.kind, offers: d.offers.count, value: d.offers.value, collected: d.collected, debts: d.debts, commission: d.commissionBalance, fees: d.fees })[key];

/**
 * Each doctor's own money, by the doctor whose patients they are. An admin sees every doctor; a doctor only himself.
 * Debts are as things stand today; the other figures follow the period.
 */
export function DoctorFiguresPage() {
  const { t } = useTranslation();
  const { isAdmin } = useRole();
  const { period, setPeriod, today, ready } = usePeriod();
  const sort = useSort<SortKey>('name');
  const { data, error, isFetching } = useDoctorFiguresQuery({ from: period.from || undefined, to: period.to || undefined }, { skip: !ready });
  const rows = useMemo(() => sortRows(data?.doctors ?? [], (d) => value(d, sort.key), sort.order), [data, sort.key, sort.order]);

  return (
    <>
      <PageHeader
        title={t('By doctor')}
        subtitle={isAdmin ? t('Each doctor’s patients: treatment offers made, money collected and what is still owed.') : t('Your patients: treatment offers made, money collected and what is still owed.')}
      />
      <PeriodPicker period={period} setPeriod={setPeriod} today={today} />
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {!data ? (
        <Skeleton variant="rounded" height={160} />
      ) : rows.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}><Typography>{t('No doctor to show.')}</Typography></Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <SortCell field="name" sort={sort}>{t('Doctor')}</SortCell>
                <SortCell field="kind" sort={sort}>{t('Kind')}</SortCell>
                <SortCell field="offers" sort={sort} align="right">{t('Offers')}</SortCell>
                <SortCell field="value" sort={sort} align="right">{t('Offered')}</SortCell>
                <SortCell field="collected" sort={sort} align="right">{t('Collected')}</SortCell>
                <SortCell field="debts" sort={sort} align="right">{t('Owed by patients')}</SortCell>
                <SortCell field="commission" sort={sort} align="right">{t('Commission balance')}</SortCell>
                <SortCell field="fees" sort={sort} align="right">{t('Specialist fees')}</SortCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.doctor.id}>
                  <TableCell>{fullName(d.doctor)}</TableCell>
                  <TableCell><Chip size="small" color={d.doctor.kind === 'owner' ? 'primary' : 'default'} label={d.doctor.kind === 'owner' ? t('Owner') : t('External')} /></TableCell>
                  <TableCell align="right">{d.offers.count}</TableCell>
                  <TableCell align="right">{formatMoney(d.offers.value)}</TableCell>
                  <TableCell align="right">{formatMoney(d.collected)}</TableCell>
                  <TableCell align="right">{formatMoney(d.debts)}</TableCell>
                  <TableCell align="right">
                    {d.commissionBalance === null ? (
                      <Tooltip title={t('The commission percentage is not set, so this cannot be worked out.')}><Chip size="small" color="warning" label={t('Not set')} /></Tooltip>
                    ) : (
                      <Tooltip title={d.doctor.kind === 'owner' ? t('Specialists still owe this owner') : t('This specialist still owes the owners')}>
                        <span>{formatMoney(d.commissionBalance)}</span>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell align="right">{formatMoney(d.fees)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        {t('Offers and collected follow the dates above; what patients owe is as things stand today. Drafts are not counted as offers.')}
      </Typography>
    </>
  );
}
