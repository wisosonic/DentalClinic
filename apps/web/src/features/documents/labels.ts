import type { DocumentCategory } from '@aya/shared';

/** The kinds of document. They are medical terms, so they stay English in both languages (no Arabic entry). */
export const DOCUMENT_CATEGORY_LABEL: Record<DocumentCategory, string> = {
  xray: 'X-ray', panoramic: 'Panoramic', cbct: 'CBCT', blood_test: 'Blood test', other: 'Other',
};
