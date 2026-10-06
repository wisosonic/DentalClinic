import type { ReactNode } from 'react';
import { Alert, Box, Button, Chip, Divider, List, ListItem, ListItemText, Paper, Skeleton, Stack, Typography } from '@mui/material';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import PaymentsIcon from '@mui/icons-material/Payments';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import DownloadIcon from '@mui/icons-material/Download';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import type { FinanceSummaryDto } from '@aya/shared';
import { PageHeader } from '../../components/PageHeader';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { EXPENSE_TYPE_LABEL, PAYMENT_TYPE_LABEL, formatMoney } from '../../lib/money';
import { BRAND } from '../../theme';
import { useFinanceSummaryQuery } from './financeApi';
import { MonthlyChart } from './MonthlyChart';
import { PeriodPicker, usePeriod } from './PeriodPicker';

/** One figure with a colour, a title and a way in to the records behind it. */
function Tile({ icon, color, title, value, note, children, action }: {
  icon: ReactNode; color: string; title: string; value: string; note?: string; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <Paper sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{ width: 44, height: 44, borderRadius: 1, display: 'grid', placeItems: 'center', color: '#fff', background: color, boxShadow: `0 8px 18px ${color}55`, flexShrink: 0 }}>{icon}</Box>
        <Typography color="text.secondary" fontWeight={600}>{title}</Typography>
      </Box>
      <Typography variant="h4" component="p" dir="ltr" sx={{ textAlign: 'start', fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
      {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
      {children}
      <Box sx={{ flexGrow: 1 }} />
      {action}
    </Paper>
  );
}

/** Lab or supplier spending, by name. Nothing is drawn when there is none. */
function NamedTotals({ title, rows }: { title: string; rows: { id: number; name: string; total: number }[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <Divider />
      <List dense disablePadding aria-label={title}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>{title}</Typography>
        {rows.map((r) => (
          <ListItem key={r.id} disableGutters secondaryAction={<Typography fontWeight={700} dir="ltr">{formatMoney(r.total)}</Typography>}>
            <ListItemText primary={r.name} />
          </ListItem>
        ))}
      </List>
    </>
  );
}

/** The summary as a spreadsheet-friendly file, built in the browser from what is on screen. */
function downloadCsv(data: FinanceSummaryDto) {
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const rows: (string | number)[][] = [
    ['Section', 'Item', 'Amount'],
    ...data.payments.byType.map((x) => ['Payments', x.type === 'clinic' ? 'From patients' : 'Commission received', x.total]),
    ['Payments', 'Total', data.payments.total],
    ...data.expenses.byType.map((x) => ['Expenses', x.type, x.total]),
    ...(data.expenses.byLab ?? []).map((x) => ['Expenses by lab', x.name, x.total]),
    ...(data.expenses.bySupplier ?? []).map((x) => ['Expenses by supplier', x.name, x.total]),
    ['Expenses', 'Total', data.expenses.total],
    ['Net profit', '', data.net],
    ['Patients owe', '', data.debts.total],
    ...data.byMonth.map((m) => ['Month ' + m.month, 'Payments', m.payments]),
    ...data.byMonth.map((m) => ['Month ' + m.month, 'Expenses', m.expenses]),
  ];
  const blob = new Blob([`\uFEFF${rows.map((r) => r.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `summary-${data.from ?? 'start'}-${data.to ?? 'today'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** The money at a glance, for admins: in, out, the difference, and what patients still owe. */
export function SummaryPage() {
  const { t } = useTranslation();
  const { period: range, setPeriod, today, ready } = usePeriod();
  const { data, error, isFetching } = useFinanceSummaryQuery({ from: range.from || undefined, to: range.to || undefined }, { skip: !ready });

  const link = (path: string) => {
    const q = new URLSearchParams();
    if (range.from) q.set('from', range.from);
    if (range.to) q.set('to', range.to);
    return `${path}${q.size ? `?${q}` : ''}`;
  };
  const negative = (data?.net ?? 0) < 0;

  return (
    <>
      <PageHeader
        title={t('Summary')} subtitle={t('What came in, what went out, and what patients still owe.')}
        actions={data && <Button variant="outlined" startIcon={<DownloadIcon />} onClick={() => downloadCsv(data)}>{t('Download CSV')}</Button>}
      />

      <PeriodPicker period={range} setPeriod={setPeriod} today={today} />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {!data ? (
        <Skeleton variant="rounded" height={220} />
      ) : (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', xl: 'repeat(4, 1fr)' }, opacity: isFetching ? 0.6 : 1 }}>
          <Tile
            icon={<PaymentsIcon />} color="#2e7d32" title={t('Total payments')} value={formatMoney(data.payments.total)}
            note={data.payments.count === 1 ? t('1 payment received') : t('{{n}} payments received', { n: data.payments.count })}
            action={
              <Stack direction="row" gap={1} flexWrap="wrap">
                <Button component={RouterLink} to={link('/payments')} variant="outlined" size="small">{t('Browse payments')}</Button>
                {data.payments.byType.some((x) => x.type === 'commission') && (
                  <Button component={RouterLink} to={link('/commission')} variant="outlined" size="small">{t('Browse commission')}</Button>
                )}
              </Stack>
            }
          >
            {data.payments.byType.length > 0 && (
              <Stack direction="row" gap={0.75} flexWrap="wrap">
                {data.payments.byType.map((x) => <Chip key={x.type} size="small" variant="outlined" label={`${t(PAYMENT_TYPE_LABEL[x.type])} ${formatMoney(x.total)}`} />)}
              </Stack>
            )}
          </Tile>

          <Tile
            icon={<ReceiptLongIcon />} color="#ed6c02" title={t('Total expenses')} value={formatMoney(data.expenses.total)}
            note={data.expenses.count === 1 ? t('1 expense') : t('{{n}} expenses', { n: data.expenses.count })}
            action={<Button component={RouterLink} to={link('/expenses')} variant="outlined" size="small">{t('Browse expenses')}</Button>}
          >
            {data.expenses.byType.length > 0 && (
              <Stack direction="row" gap={0.75} flexWrap="wrap">
                {data.expenses.byType.map((x) => <Chip key={x.type} size="small" variant="outlined" label={`${t(EXPENSE_TYPE_LABEL[x.type])} ${formatMoney(x.total)}`} />)}
              </Stack>
            )}
            <NamedTotals title={t('By lab')} rows={data.expenses.byLab ?? []} />
            <NamedTotals title={t('By supplier')} rows={data.expenses.bySupplier ?? []} />
          </Tile>

          <Tile
            icon={negative ? <TrendingDownIcon /> : <TrendingUpIcon />} color={negative ? '#d32f2f' : BRAND.teal} title={t('Net profit')} value={formatMoney(data.net)}
            note={negative ? t('More went out than came in.') : t('Payments minus expenses.')}
          />

          <Tile
            icon={<AccountBalanceWalletIcon />} color="#7b1fa2" title={t('Patients’ debts')} value={formatMoney(data.debts.total)}
            note={t('{{patients}} owing, on {{offers}} treatment offers. As things stand today, whatever the dates above.', { patients: data.debts.patients, offers: data.debts.offers })}
            action={<Button component={RouterLink} to="/treatment-offers?debt=1" variant="outlined" size="small">{t('Browse debts')}</Button>}
          >
            {data.debts.top.length > 0 && (
              <>
                <Divider />
                <List dense disablePadding aria-label={t('Biggest debts')}>
                  {data.debts.top.map((d) => (
                    <ListItem key={d.patient.id} disableGutters secondaryAction={<Typography fontWeight={700} dir="ltr">{formatMoney(d.owed)}</Typography>}>
                      <ListItemText primary={<RouterLink to={`/patients/${d.patient.id}`}>{fullName(d.patient)}</RouterLink>} />
                    </ListItem>
                  ))}
                </List>
              </>
            )}
          </Tile>
        </Box>
      )}
      {data && <Box sx={{ mt: 3 }}><MonthlyChart months={data.byMonth} /></Box>}
    </>
  );
}
