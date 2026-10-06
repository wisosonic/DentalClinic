import type { LabStatus } from '@aya/shared';

type Color = 'default' | 'info' | 'primary' | 'warning' | 'success' | 'error';

/** English text is the translation key. */
export const LAB_STATUS_LABEL: Record<LabStatus, string> = { draft: 'Draft', sent: 'Sent', received: 'Received', fitted: 'Fitted' };
export const LAB_STATUS_COLOR: Record<LabStatus, Color> = { draft: 'default', sent: 'info', received: 'primary', fitted: 'success' };
