import type { ReactNode } from 'react';
import { Alert, Box, Button, Divider, Paper, Skeleton, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import type { AppointmentStatus, DashboardChartsDto } from '@aya/shared';
import { errorMessage } from '../../lib/baseQuery';
import { STATUS_HEX, formatDate, fullName, statusLabel } from '../../lib/format';
import { formatMoney } from '../../lib/money';
import { dateLocale } from '../../i18n';
import { MonthlyChart } from '../finance/MonthlyChart';
import { BarList } from './BarList';
import { useDashboardChartsQuery } from './dashboardApi';

function Card({ title, note, children, action }: { title: string; note?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Paper component="section" aria-label={title} sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Box>
        <Typography variant="h6" component="h3">{title}</Typography>
        {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
      </Box>
      {children}
      {action && <><Box sx={{ flexGrow: 1 }} />{action}</>}
    </Paper>
  );
}

/** One column on phones, two on tablets, three on a wide screen. */
const COLUMNS = { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' };

const Empty = ({ children }: { children: ReactNode }) => <Typography color="text.secondary" variant="body2">{children}</Typography>;

const weekday = (date: string) =>
  new Intl.DateTimeFormat(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

function MoneyCharts({ data }: { data: DashboardChartsDto }) {
  const { t } = useTranslation();
  const doctor = data.role === 'doctor';
  const months = data.byMonth ?? [];
  const quiet = months.every((m) => m.payments === 0 && m.expenses === 0);
  const status = (data.appointmentsByStatus ?? []).filter((s) => s.count > 0);
  const procedures = data.topProcedures ?? [];
  const debts = data.topDebts ?? [];

  return (
    <>
      {/* The month chart takes the first column of its row; the other places are kept for charts to come. */}
      <Box sx={{ gridColumn: '1 / -1', display: 'grid', gap: 2, gridTemplateColumns: COLUMNS }}>
        {quiet ? (
          <Card title={doctor ? t('Collected, last 6 months') : t('Payments and expenses, last 6 months')}>
            <Empty>{t('Nothing came in or went out in the last 6 months.')}</Empty>
          </Card>
        ) : (
          <MonthlyChart months={months} showExpenses={!doctor} narrow title={doctor ? t('Collected, last 6 months') : t('Payments and expenses, last 6 months')} />
        )}
      </Box>

      <Card title={t('Appointments by status')} note={t('The last 30 days.')}>
        {status.length === 0 ? (
          <Empty>{t('No appointments in the last 30 days.')}</Empty>
        ) : (
          <BarList
            label={t('Appointments by status')}
            items={status.map((s) => ({ key: s.status, label: statusLabel(s.status as AppointmentStatus), value: s.count, color: STATUS_HEX[s.status as AppointmentStatus] }))}
          />
        )}
      </Card>

      <Card title={t('Most booked procedures')} note={t('The last 90 days, cancelled visits left out.')}>
        {procedures.length === 0 ? (
          <Empty>{t('No procedures booked in the last 90 days.')}</Empty>
        ) : (
          <BarList label={t('Most booked procedures')} items={procedures.map((p) => ({ key: p.id, label: p.name, value: p.count }))} />
        )}
      </Card>

      <Card
        title={t('Biggest debts')} note={t('What patients still owe, as things stand today.')}
        action={doctor || debts.length > 0 ? <Button component={RouterLink} to="/treatment-offers?debt=1" variant="outlined" size="small" sx={{ alignSelf: 'flex-start' }}>{t('Browse debts')}</Button> : undefined}
      >
        {debts.length === 0 ? (
          <Empty>{t('Nobody owes anything.')}</Empty>
        ) : (
          <BarList
            label={t('Biggest debts')} color="#7b1fa2"
            items={debts.map((d) => ({ key: d.patient.id, label: <RouterLink to={`/patients/${d.patient.id}`}>{fullName(d.patient)}</RouterLink>, value: d.owed, display: formatMoney(d.owed) }))}
          />
        )}
      </Card>
    </>
  );
}

function FrontDeskCharts({ data }: { data: DashboardChartsDto }) {
  const { t } = useTranslation();
  const days = data.appointmentsPerDay ?? [];
  const overdue = data.overdueLabOrders ?? { count: 0, oldest: [] };
  const waiting = data.offersAwaitingAcceptance ?? 0;

  return (
    <>
      <Card title={t('Appointments, next 7 days')} note={t('Booked, pending and completed visits.')}>
        {days.every((d) => d.count === 0) ? (
          <Empty>{t('Nothing booked in the next 7 days.')}</Empty>
        ) : (
          <BarList label={t('Appointments, next 7 days')} items={days.map((d) => ({ key: d.date, label: weekday(d.date), value: d.count }))} />
        )}
      </Card>

      <Card
        title={t('Overdue lab orders')} note={t('Past their due date and not received yet.')}
        action={<Button component={RouterLink} to="/lab-orders?overdue=1" variant="outlined" size="small" sx={{ alignSelf: 'flex-start' }}>{t('Browse overdue orders')}</Button>}
      >
        <Typography variant="h4" component="p" dir="ltr" sx={{ textAlign: 'start' }}>{overdue.count}</Typography>
        {overdue.oldest.length === 0 ? (
          <Empty>{t('No overdue orders.')}</Empty>
        ) : (
          <>
            <Divider />
            <Box component="ul" aria-label={t('Oldest overdue orders')} sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1 }}>
              {overdue.oldest.map((o) => (
                <Box component="li" key={o.id}>
                  <Typography variant="body2" fontWeight={600}>{o.item} · {o.lab}</Typography>
                  <Typography variant="caption" color="text.secondary">{fullName(o.patient)} · {t('due {{date}}', { date: formatDate(o.dueAt) })}</Typography>
                </Box>
              ))}
            </Box>
          </>
        )}
      </Card>

      <Card
        title={t('Offers awaiting acceptance')} note={t('Sent to the patient, not accepted yet.')}
        action={<Button component={RouterLink} to="/treatment-offers?status=sent" variant="outlined" size="small" sx={{ alignSelf: 'flex-start' }}>{t('Browse treatment offers')}</Button>}
      >
        <Typography variant="h4" component="p" dir="ltr" sx={{ textAlign: 'start' }}>{waiting}</Typography>
      </Card>
    </>
  );
}

/** Charts under the dashboard tiles. The server shapes the data by role, so this only draws what arrived. */
export default function InsightsSection() {
  const { t } = useTranslation();
  const { data, error, isLoading } = useDashboardChartsQuery();

  return (
    <Box component="section" aria-label={t('Insights')} sx={{ mt: 4 }}>
      <Typography variant="h6" component="h2" gutterBottom>{t('Insights')}</Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {isLoading ? (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }} aria-label={t('Loading')}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rounded" height={180} />)}
        </Box>
      ) : data ? (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: COLUMNS, alignItems: 'stretch' }}>
          {data.role === 'staff' ? <FrontDeskCharts data={data} /> : <MoneyCharts data={data} />}
        </Box>
      ) : null}
    </Box>
  );
}

