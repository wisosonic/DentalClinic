import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Link, MenuItem, Paper, Skeleton, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import PaymentsIcon from '@mui/icons-material/Payments';
import PercentIcon from '@mui/icons-material/Percent';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import { calculateIncomeTax, type TaxBracketStep } from '@aya/shared';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { fullName } from '../../lib/format';
import { formatLbp, formatMoney } from '../../lib/money';
import { BRAND } from '../../theme';
import { useGetConfigQuery, useGetDoctorsQuery } from '../clinical/clinicalApi';
import { formatDate } from '../../lib/format';
import { useDeclareTaxYearMutation, useIncomeTaxQuery, useReopenTaxYearMutation } from './taxApi';

type SortKey = 'from' | 'to' | 'rate' | 'amount' | 'tax';

function Tile({ icon, color, title, value, note }: { icon: React.ReactNode; color: string; title: string; value: string; note?: string }) {
  return (
    <Paper component="section" aria-label={title} sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box sx={{ width: 44, height: 44, borderRadius: 1, display: 'grid', placeItems: 'center', color: '#fff', background: color, boxShadow: `0 8px 18px ${color}55`, flexShrink: 0 }}>{icon}</Box>
        <Typography color="text.secondary" fontWeight={600}>{title}</Typography>
      </Box>
      <Typography variant="h5" component="p" dir="ltr" sx={{ textAlign: 'start', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{value}</Typography>
      {note && <Typography variant="body2" color="text.secondary">{note}</Typography>}
    </Paper>
  );
}

/**
 * The Lebanese income tax estimate, for admins: the year's payments, the owner's steps (35%, family
 * allowances, brackets) and the tax payable in LBP. The calculation is the shared function, so changing the
 * family details or trying another amount answers at once without asking the server again.
 */
export function IncomeTaxPage() {
  const { t } = useTranslation();
  const { data: config } = useGetConfigQuery();
  const thisYear = Number(config?.today?.slice(0, 4)) || new Date().getFullYear();
  const [year, setYear] = useState<number | null>(null);
  const [doctorId, setDoctorId] = useState('');
  const [spouse, setSpouse] = useState(false);
  const [children, setChildren] = useState('0');
  const [tryAmount, setTryAmount] = useState('');
  const sort = useSort<SortKey>('from');
  const chosenYear = year ?? thisYear;
  const [declaring, setDeclaring] = useState(false);
  const [paidDate, setPaidDate] = useState('');
  const [note, setNote] = useState('');
  const [declare, declareState] = useDeclareTaxYearMutation();
  const [reopening, setReopening] = useState(false);
  const [reopen, reopenState] = useReopenTaxYearMutation();

  const { data: doctors = [] } = useGetDoctorsQuery();
  const { data, error, isFetching } = useIncomeTaxQuery({ year: chosenYear, doctorId: Number(doctorId) || undefined }, { skip: !config });

  const childCount = Math.max(0, Math.min(30, Math.floor(Number(children) || 0)));
  const trying = !data?.declaration && tryAmount.trim() !== '' && Number(tryAmount) >= 0;
  const paymentsUsd = trying ? Number(tryAmount) : (data?.payments.totalUsd ?? 0);
  // A declared year is the stored copy, as it was on the day: never recalculated, whatever the laws say now.
  const declared = data?.declaration ?? null;
  const calculated = useMemo(
    () => (data ? calculateIncomeTax({ paymentsUsd, spouse, children: childCount }, data.settings) : null),
    [data, paymentsUsd, spouse, childCount],
  );
  const result = declared ? data!.result : calculated;

  // A doctor's saved family details are where the page starts; change them here to try another situation.
  const familyKey = data ? `${data.doctor?.id ?? 0}:${data.family.spouse}:${data.family.children}:${data.declaration?.id ?? 0}` : '';
  useEffect(() => {
    if (!data) return;
    // a declared year shows the family details it was filed with
    const shown = data.declaration ? data.input : data.family;
    setSpouse(shown.spouse);
    setChildren(String(shown.children));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyKey]);

  const stepValue: Record<SortKey, (s: TaxBracketStep) => number> = { from: (s) => s.from, to: (s) => s.to ?? Number.MAX_SAFE_INTEGER, rate: (s) => s.rate, amount: (s) => s.amount, tax: (s) => s.tax };
  const steps = result ? sortRows(result.steps, stepValue[sort.key], sort.order) : [];
  const years = Array.from({ length: 7 }, (_, i) => thisYear - i);

  return (
    <>
      <PageHeader
        title={t('Income tax')} subtitle={t('An estimate for the owners and their accountant, not a tax return.')}
        actions={data ? (
          <Button
            component="a" variant="outlined" startIcon={<PictureAsPdfIcon />} target="_blank" rel="noopener"
            href={`/api/v1/finance/tax/pdf?${new URLSearchParams({ year: String(chosenYear), ...(doctorId ? { doctorId } : {}), ...(declared ? {} : { spouse: spouse ? '1' : '0', children: String(childCount) }) })}`}
          >
            {t('PDF worksheet')}
          </Button>
        ) : undefined}
      />

      <Paper sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField select label={t('Year')} value={chosenYear} onChange={(e) => setYear(Number(e.target.value))} margin="none" sx={{ minWidth: 110 }}>
            {years.map((y) => <MenuItem key={y} value={y}>{data?.declaredYears.includes(y) ? `${y} · ${t('Declared and paid')}` : y}</MenuItem>)}
          </TextField>
          <TextField select label={t('Taxpayer')} value={doctorId} onChange={(e) => setDoctorId(e.target.value)} margin="none" sx={{ minWidth: 220 }}>
            <MenuItem value="">{t('The whole clinic')}</MenuItem>
            {doctors.map((d) => <MenuItem key={d.id} value={String(d.id)}>{t('Dr. {{name}}', { name: fullName(d) })}</MenuItem>)}
          </TextField>
          <FormControlLabel control={<Switch checked={spouse} disabled={!!declared} onChange={(e) => setSpouse(e.target.checked)} />} label={t('Spouse is eligible')} />
          <TextField
            label={t('Eligible children')} type="number" value={children} disabled={!!declared} onChange={(e) => setChildren(e.target.value)} margin="none" sx={{ width: 150 }}
            slotProps={{ htmlInput: { min: 0, max: 30, step: 1, dir: 'ltr' } }}
          />
          {/* the hint sits beside the box, so the box lines up with the other fields on the row */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <TextField
              label={t('Try another amount (USD)')} type="number" value={declared ? '' : tryAmount} disabled={!!declared} onChange={(e) => setTryAmount(e.target.value)} margin="none" sx={{ width: 220 }}
              slotProps={{ htmlInput: { min: 0, step: '0.01', dir: 'ltr' } }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 200 }}>{t('Leave empty to use the year’s payments')}</Typography>
          </Box>
        </Box>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {declared && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {t('Declared and paid on {{date}}{{by}}. These figures are stored as they were on that day and are no longer recalculated, whatever the rates and brackets are now.', { date: formatDate(declared.paidDate), by: declared.declaredBy ? ` · ${declared.declaredBy}` : '' })}
          {declared.note ? ` ${declared.note}` : ''}
          <Box sx={{ mt: 1 }}>
            {declared.canReopen ? (
              <Button size="small" color="inherit" variant="outlined" onClick={() => { reopenState.reset(); setReopening(true); }}>{t('Reopen this year')}</Button>
            ) : (
              <Typography variant="caption">{t('This year is over, so its declaration is locked and cannot be reopened.')}</Typography>
            )}
          </Box>
        </Alert>
      )}
      {data?.drift && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t('Payments recorded for this year have changed since it was declared. They are now {{usd}}; the stored figures above were not changed.', { usd: formatMoney(data.drift.paymentsUsd) })}
        </Alert>
      )}
      {declared ? null : data?.usingDefaults ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('These figures use the starting exchange rate, allowances and brackets.')}{' '}
          <Link component={RouterLink} to="/settings">{t('Check them in Settings')}</Link>
        </Alert>
      ) : data ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('Using the rules that apply from {{year}}.', { year: data.rulesFrom })}{' '}
          <Link component={RouterLink} to="/settings">{t('See the rules in Settings')}</Link>
        </Alert>
      ) : null}
      {data && data.excluded.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t('Payments in a currency other than USD have no exchange rate and are left out:')}{' '}
          {data.excluded.map((x) => `${x.currency} ${x.total} (${x.count})`).join(', ')}
        </Alert>
      )}

      {!data || !result ? (
        <Skeleton variant="rounded" height={200} aria-label={t('Loading')} />
      ) : (
        <Box sx={{ opacity: isFetching ? 0.6 : 1 }}>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, mb: 2 }}>
            <Tile
              icon={<PaymentsIcon />} color="#2e7d32" title={t('Payments in the year')} value={formatMoney(paymentsUsd)}
              note={trying ? t('The amount you are trying.') : t('{{clinic}} from patients and {{commission}} commission received.', { clinic: formatMoney(data.payments.clinic.total), commission: formatMoney(data.payments.commission.total) })}
            />
            <Tile icon={<RequestQuoteIcon />} color={BRAND.teal} title={t('Tax payable')} value={formatLbp(result.taxPayable)} note={t('In Lebanese pounds only.')} />
            <Tile icon={<PercentIcon />} color="#7b1fa2" title={t('Share of payments')} value={`${result.effectiveRate}%`} note={t('Tax payable as a share of everything received.')} />
          </Box>

          <Paper sx={{ p: 2.5, mb: 2 }}>
            <Typography variant="h6" component="h2" gutterBottom>{t('How it is worked out')}</Typography>
            <Box component="ol" aria-label={t('How it is worked out')} sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
              {[
                { key: 'a', label: t('Payments in LBP (at {{rate}} LBP per USD)', { rate: data.settings.usdToLbp.toLocaleString('en-US') }), value: result.paymentsLbp },
                { key: 'b', label: t('{{percent}}% of the payments', { percent: data.settings.taxPercentage }), value: result.taxablePart },
                { key: 'c', label: t('Family allowances ({{details}})', { details: [t('single'), spouse && t('spouse'), childCount > 0 && t('{{n}} child(ren)', { n: childCount })].filter(Boolean).join(', ') }), value: -result.allowances.total },
                { key: 'd', label: t('Amount after the allowances (never below zero)'), value: result.amountAfterAllowances },
                { key: 'e', label: t('Tax payable after the brackets'), value: result.taxPayable, strong: true },
              ].map((row) => (
                <Box component="li" key={row.key} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'baseline', borderBottom: row.strong ? 0 : '1px solid rgba(15,100,120,0.12)', pb: row.strong ? 0 : 1 }}>
                  <Typography fontWeight={row.strong ? 800 : 400}>{row.label}</Typography>
                  <Typography fontWeight={row.strong ? 800 : 600} dir="ltr" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatLbp(row.value)}</Typography>
                </Box>
              ))}
            </Box>
          </Paper>

          <Typography variant="h6" component="h2" gutterBottom>{t('Brackets')}</Typography>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <SortCell field="from" sort={sort} align="right">{t('From (LBP)')}</SortCell>
                  <SortCell field="to" sort={sort} align="right">{t('To (LBP)')}</SortCell>
                  <SortCell field="rate" sort={sort} align="right">{t('Rate')}</SortCell>
                  <SortCell field="amount" sort={sort} align="right">{t('Amount in the bracket (LBP)')}</SortCell>
                  <SortCell field="tax" sort={sort} align="right">{t('Tax (LBP)')}</SortCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {steps.map((s) => (
                  <TableRow key={s.from} sx={s.amount === 0 ? { opacity: 0.55 } : undefined}>
                    <TableCell align="right"><bdi dir="ltr">{s.from.toLocaleString('en-US')}</bdi></TableCell>
                    <TableCell align="right">{s.to === null ? t('No limit') : <bdi dir="ltr">{s.to.toLocaleString('en-US')}</bdi>}</TableCell>
                    <TableCell align="right"><bdi dir="ltr">{s.rate}%</bdi></TableCell>
                    <TableCell align="right"><bdi dir="ltr">{s.amount.toLocaleString('en-US')}</bdi></TableCell>
                    <TableCell align="right"><bdi dir="ltr">{s.tax.toLocaleString('en-US')}</bdi></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {!declared && (
            <Box sx={{ mt: 2 }}>
              <Button
                variant="contained" disabled={trying || chosenYear > thisYear || data.excluded.length > 0}
                onClick={() => { declareState.reset(); setPaidDate(config?.today ?? ''); setNote(''); setDeclaring(true); }}
              >
                {t('Mark this year as declared and paid')}
              </Button>
              {(trying || data.excluded.length > 0 || chosenYear > thisYear) && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                  {chosenYear > thisYear ? t('A year that has not started cannot be declared.') : trying ? t('Clear the amount you are trying first.') : t('Some payments are in a currency with no rate: sort them out before declaring.')}
                </Typography>
              )}
            </Box>
          )}
          <Stack sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {t('Expenses are not deducted. Payments are those received in the year (from patients, plus commission received). This is an estimate, not a tax return.')}
            </Typography>
          </Stack>
        </Box>
      )}

      <Dialog open={declaring} onClose={declareState.isLoading ? undefined : () => setDeclaring(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('Mark {{year}} as declared and paid?', { year: chosenYear })}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 1 }}>
            {t('The figures on this page are stored as they are now and this year is never recalculated. Later changes to the rates, brackets or payments will not touch it. There is no way back.')}
          </Alert>
          {declareState.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(declareState.error)}</Alert>}
          {result && <Typography sx={{ mb: 1 }}>{t('Tax payable')}: <strong dir="ltr">{formatLbp(result.taxPayable)}</strong></Typography>}
          <TextField label={t('Day it was paid')} type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} required />
          <TextField label={t('Note (optional)')} value={note} onChange={(e) => setNote(e.target.value)} multiline minRows={2} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeclaring(false)} disabled={declareState.isLoading}>{t('Cancel')}</Button>
          <Button
            variant="contained" disabled={declareState.isLoading || !paidDate}
            onClick={async () => {
              const r = await declare({ year: chosenYear, doctorId: Number(doctorId) || null, paidDate, note, spouse, children: childCount });
              if (!('error' in r && r.error)) setDeclaring(false);
            }}
          >
            {declareState.isLoading ? t('Saving…') : t('Declared and paid')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={reopening} onClose={reopenState.isLoading ? undefined : () => setReopening(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('Reopen {{year}}?', { year: chosenYear })}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 1 }}>
            {t('The year is calculated again from today’s payments and rules. The stored declaration is kept in the records as reopened, with who did it and when. Only the current year can be reopened.')}
          </Alert>
          {reopenState.error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(reopenState.error)}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReopening(false)} disabled={reopenState.isLoading}>{t('Cancel')}</Button>
          <Button
            variant="contained" color="warning" disabled={reopenState.isLoading}
            onClick={async () => {
              const r = await reopen({ year: chosenYear, doctorId: Number(doctorId) || null });
              if (!('error' in r && r.error)) setReopening(false);
            }}
          >
            {reopenState.isLoading ? t('Saving…') : t('Reopen this year')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
