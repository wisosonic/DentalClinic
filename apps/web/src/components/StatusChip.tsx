import Chip from '@mui/material/Chip';
import { useTranslation } from 'react-i18next';
import type { AppointmentStatus } from '@aya/shared';
import { STATUS_COLOR, statusLabel } from '../lib/format';

export function StatusChip({ status }: { status: AppointmentStatus }) {
  useTranslation(); // re-render when the language changes
  return <Chip size="small" label={statusLabel(status)} color={STATUS_COLOR[status] ?? 'default'} variant={status === 'cancelled' ? 'outlined' : 'filled'} />;
}
