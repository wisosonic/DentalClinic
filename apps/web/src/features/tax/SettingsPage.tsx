import { useEffect, useState } from 'react';
import { Alert, Box, Button, IconButton, MenuItem, Paper, Skeleton, TextField, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useTranslation } from 'react-i18next';
import { taxSettingsSchema, taxYearSchema, type TaxSettings } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { errorMessage } from '../../lib/baseQuery';
import { validate, type FieldErrors } from '../../lib/zodForm';
import { useGetConfigQuery } from '../clinical/clinicalApi';
import { useDeleteTaxRulesMutation, useSaveTaxRulesMutation, useTaxRulesQuery } from './taxApi';

interface Row { key: number; to: string; rate: string }
let nextKey = 1;
const numberField = { min: 0, step: 'any', inputMode: 'decimal' as const, dir: 'ltr' as const };
const NEW = 'new';

const toRows = (s: TaxSettings): Row[] => s.brackets.map((b) => ({ key: nextKey++, to: b.to === null ? '' : String(b.to), rate: String(b.rate) }));

/**
 * The Taxes section of Settings (admin): the income tax rules. Laws change, so the rules are kept as sets
 * that apply from a year: the estimate for a year uses the latest set that starts in that year or before.
 */
export function TaxesSection() {
  const { t } = useTranslation();
  const { data: config } = useGetConfigQuery();
  const { data, error } = useTaxRulesQuery();
  const [save, saveState] = useSaveTaxRulesMutation();
  const [remove, removeState] = useDeleteTaxRulesMutation();
  const [selected, setSelected] = useState<string | null>(null); // a year, or NEW
  const [year, setYear] = useState('');
  const [rate, setRate] = useState('');
  const [percent, setPercent] = useState('');
  const [allow, setAllow] = useState({ single: '', spouse: '', child: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [deleting, setDeleting] = useState(false);
  const thisYear = config?.today?.slice(0, 4) ?? '';

  const fill = (s: TaxSettings) => {
    setRate(String(s.usdToLbp));
    setPercent(String(s.taxPercentage));
    setAllow({ single: String(s.allowances.single), spouse: String(s.allowances.spouse), child: String(s.allowances.child) });
    setRows(toRows(s));
    setErrors({});
  };

  // Show the newest saved set first (or the starting values, to be saved as a first set).
  useEffect(() => {
    if (!data || selected !== null) return;
    const latest = data.sets[0];
    setSelected(latest ? String(latest.effectiveYear) : NEW);
    setYear(latest ? String(latest.effectiveYear) : thisYear);
    fill(latest ? latest.settings : data.defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, thisYear]);

  const choose = (value: string) => {
    if (!data) return;
    saveState.reset();
    removeState.reset();
    setSelected(value);
    if (value === NEW) {
      setYear(thisYear);
      fill((data.sets[0]?.settings ?? data.defaults)); // a new set begins as a copy of the newest
    } else {
      setYear(value);
      fill(data.sets.find((s) => String(s.effectiveYear) === value)!.settings);
    }
  };

  /** Each bracket starts where the one before it ends. */
  const fromOf = (i: number) => (i === 0 ? '0' : rows[i - 1]!.to);
  const patch = (key: number, changes: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...changes } : x)));
  const clear = (k: string) => setErrors((e) => ({ ...e, [k]: '' }));

  const submit = async () => {
    const draft = {
      usdToLbp: rate,
      taxPercentage: percent,
      allowances: allow,
      brackets: rows.map((r, i) => ({ from: i === 0 ? 0 : rows[i - 1]!.to, to: i === rows.length - 1 ? null : r.to, rate: r.rate })),
    };
    const { data: parsed, errors: found } = validate(taxSettingsSchema, draft);
    const y = validate(taxYearSchema, year);
    if (!parsed || y.errors) return setErrors({ ...(found ?? {}), ...(y.errors ? { year: y.errors._ ?? '' } : {}) });
    setErrors({});
    const result = await save({ year: y.data, body: parsed });
    if (result.data) setSelected(String(y.data));
  };

  const reset = () => data && fill(data.defaults);
  const field = (k: string) => ({ error: !!errors[k], helperText: errors[k] || undefined });
  const saved = data?.sets.some((s) => String(s.effectiveYear) === selected) ?? false;
  const busy = saveState.isLoading || removeState.isLoading;

  return (
    <>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(error)}</Alert>}
      {(saveState.error ?? removeState.error) != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(saveState.error ?? removeState.error)}</Alert>}
      {!data || selected === null ? (
        <Skeleton variant="rounded" height={260} aria-label={t('Loading')} />
      ) : (
        <Paper component="section" aria-label={t('Income tax')} sx={{ p: 3, maxWidth: 860 }}>
          <Typography variant="h6" component="h2">{t('Income tax')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {data.sets.length === 0
              ? t('Nothing is saved yet: the starting values are in use. Save them to make them your own.')
              : t('The estimate for a year uses the latest rules that start in that year or before. When the law changes, add a new set from the year it applies.')}
          </Typography>

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <TextField select label={t('Rules that apply from')} value={selected} onChange={(e) => choose(e.target.value)} sx={{ minWidth: 240 }}>
              {data.sets.map((s) => <MenuItem key={s.effectiveYear} value={String(s.effectiveYear)}>{t('From {{year}}', { year: s.effectiveYear })}</MenuItem>)}
              <MenuItem value={NEW}>{data.sets.length === 0 ? t('Save a first set') : t('Add rules for a new year')}</MenuItem>
            </TextField>
            {selected === NEW && (
              <TextField
                label={t('Applies from year')} type="number" value={year} onChange={(e) => { setYear(e.target.value); clear('year'); }}
                slotProps={{ htmlInput: { min: 2000, max: 2100, step: 1, dir: 'ltr' } }} sx={{ width: 170 }} {...field('year')}
              />
            )}
          </Box>

          <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 1, mb: 0.5 }}>{t('Exchange rate and tax percentage')}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, columnGap: 2 }}>
            <TextField
              label={t('LBP per 1 US dollar')} type="number" value={rate} onChange={(e) => { setRate(e.target.value); clear('usdToLbp'); }}
              slotProps={{ htmlInput: numberField }} {...field('usdToLbp')}
            />
            <TextField
              label={t('Tax percentage of the payments (%)')} type="number" value={percent} onChange={(e) => { setPercent(e.target.value); clear('taxPercentage'); }}
              slotProps={{ htmlInput: { ...numberField, max: 100 } }} {...field('taxPercentage')}
              helperText={errors.taxPercentage || t('For dental services this is 35%. It is taxed before the allowances.')}
            />
          </Box>

          <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 2, mb: 0.5 }}>{t('Family allowances (LBP)')}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, columnGap: 2 }}>
            <TextField label={t('Single')} type="number" value={allow.single} onChange={(e) => { setAllow({ ...allow, single: e.target.value }); clear('allowances.single'); }} slotProps={{ htmlInput: numberField }} {...field('allowances.single')} />
            <TextField label={t('Spouse, if eligible (added)')} type="number" value={allow.spouse} onChange={(e) => { setAllow({ ...allow, spouse: e.target.value }); clear('allowances.spouse'); }} slotProps={{ htmlInput: numberField }} {...field('allowances.spouse')} />
            <TextField label={t('Each eligible child (added)')} type="number" value={allow.child} onChange={(e) => { setAllow({ ...allow, child: e.target.value }); clear('allowances.child'); }} slotProps={{ htmlInput: numberField }} {...field('allowances.child')} />
          </Box>
          <Typography variant="caption" color="text.secondary">{t('Whether a doctor has an eligible spouse and children is set on the doctor’s profile.')}</Typography>

          <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 2, mb: 0.5 }}>{t('Tax brackets (LBP)')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('Each bracket starts where the one before it ends; the last has no limit.')}
          </Typography>
          {errors.brackets && <Alert severity="error" sx={{ mb: 1 }}>{errors.brackets}</Alert>}
          <Box role="group" aria-label={t('Tax brackets (LBP)')} sx={{ display: 'grid', gap: 1 }}>
            {rows.map((r, i) => {
              const last = i === rows.length - 1;
              return (
                <Box key={r.key} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: '1fr 1fr 110px 44px' }, columnGap: 1.5, alignItems: 'start' }}>
                  <TextField label={t('From')} value={fromOf(i)} disabled slotProps={{ htmlInput: { dir: 'ltr', 'aria-label': t('From of bracket {{n}}', { n: i + 1 }) } }} {...field(`brackets.${i}.from`)} />
                  <TextField
                    label={t('To')} type="number" value={last ? '' : r.to} disabled={last} placeholder={last ? t('No limit') : undefined}
                    onChange={(e) => { patch(r.key, { to: e.target.value }); clear(`brackets.${i}.to`); clear(`brackets.${i + 1}.from`); }}
                    slotProps={{ htmlInput: { ...numberField, 'aria-label': t('To of bracket {{n}}', { n: i + 1 }) } }} {...field(`brackets.${i}.to`)}
                  />
                  <TextField
                    label={t('Rate (%)')} type="number" value={r.rate} onChange={(e) => { patch(r.key, { rate: e.target.value }); clear(`brackets.${i}.rate`); }}
                    slotProps={{ htmlInput: { ...numberField, max: 100, 'aria-label': t('Rate of bracket {{n}}', { n: i + 1 }) } }} {...field(`brackets.${i}.rate`)}
                  />
                  <Tooltip title={t('Remove')}>
                    <span>
                      <IconButton aria-label={t('Remove bracket {{n}}', { n: i + 1 })} disabled={rows.length <= 1} onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))} sx={{ mt: 0.5 }}>
                        <DeleteOutlineIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              );
            })}
          </Box>
          <Button startIcon={<AddIcon />} onClick={() => setRows((r) => [...r, { key: nextKey++, to: '', rate: '' }])} sx={{ mt: 1 }}>{t('Add bracket')}</Button>

          <Box sx={{ display: 'flex', gap: 1, mt: 3, flexWrap: 'wrap' }}>
            <Button variant="contained" onClick={submit} disabled={busy}>{saveState.isLoading ? t('Saving…') : t('Save settings')}</Button>
            <Button onClick={reset} disabled={busy}>{t('Use the starting values')}</Button>
            {saved && <Button color="error" onClick={() => setDeleting(true)} disabled={busy}>{t('Delete this set')}</Button>}
          </Box>
        </Paper>
      )}

      <ConfirmDialog
        open={deleting} destructive title={t('Delete these tax rules?')}
        message={t('Years that used them will use the rules before them, or the starting values if there are none.')}
        confirmLabel={t('Delete this set')} busy={removeState.isLoading} onClose={() => setDeleting(false)}
        onConfirm={async () => {
          const result = await remove(Number(selected));
          setDeleting(false);
          if (result.data) { setSelected(null); }
        }}
      />
    </>
  );
}
