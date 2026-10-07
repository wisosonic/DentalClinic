/**
 * Interface labels whose core is a medical term. They are deliberately left without an Arabic entry, so they show
 * in English in both languages (owner decision 2026-10-05, the same rule as medication, procedure and tooth names).
 * The i18n test accepts these keys as having no translation, and fails if one is given an Arabic entry.
 */
export const ENGLISH_ONLY: string[] = [
  "Medications",
  "Medication",
  "Medication {{n}}",
  "Add medication",
  "Edit medication",
  "Remove medication {{n}}",
  "Search medications",
  "Choose a medication",
  "Procedures",
  "Procedure of item {{n}}",
  "Add procedure",
  "Edit procedure",
  "Procedures & teeth",
  "Procedures and teeth",
  "Teeth",
  "Teeth involved",
  "Tooth (optional)",
  "Tooth {{index}}",
  "Tooth {{index}}: note",
  "Tooth of item {{n}}",
  "Tooth notes (clinic only)",
  "Prescription",
  "Dose",
  "Dose {{n}}",
];
