import { useState } from 'react';
import { Autocomplete, Box, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { PatientDto } from '@aya/shared';
import { useListPatientsQuery } from '../features/clinical/clinicalApi';
import { fullName } from '../lib/format';
import { useDebounce } from '../lib/useDebounce';

/** Finds a patient by typing part of a name or phone number. The server does the searching. */
export function PatientPicker({
  value, onChange, label, error, helperText, disabled, autoFocus,
}: {
  value: PatientDto | null;
  onChange: (patient: PatientDto | null) => void;
  label?: string;
  error?: boolean;
  helperText?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const search = useDebounce(input.trim());
  const { data, isFetching } = useListPatientsQuery({ q: search, pageSize: 10 }, { skip: disabled });
  const options = data?.data ?? [];

  return (
    <Autocomplete
      options={options} value={value} disabled={disabled} loading={isFetching}
      filterOptions={(x) => x} // the server already filtered
      getOptionLabel={(p) => fullName(p)} isOptionEqualToValue={(a, b) => a.id === b.id}
      onChange={(_e, v) => onChange(v)}
      onInputChange={(_e, v, reason) => reason === 'input' && setInput(v)}
      noOptionsText={input ? t('No matching patients') : t('Type a name or phone number')}
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
        <TextField {...params} label={label ?? t('Patient')} required autoFocus={autoFocus} error={error} helperText={helperText} />
      )}
    />
  );
}
