import { z } from 'zod';

// ---------------------------------------------------------------------------
// Family links between patients (owner request 2026-10-09)
// ---------------------------------------------------------------------------

/**
 * What the chosen person is to the patient whose page is open: "Omar is Ali's father". One link is stored once and
 * seen from both sides; the other side's word is worked out (Ali is Omar's son or daughter, by Ali's gender).
 */
export const FAMILY_RELATIONS = ['father', 'mother', 'son', 'daughter', 'sibling', 'spouse'] as const;
export type FamilyRelation = (typeof FAMILY_RELATIONS)[number];

/** What a link can read as: also parent or child when the gender is not known, and husband or wife for a spouse (display only, never chosen). */
export type FamilyRole = FamilyRelation | 'parent' | 'child' | 'husband' | 'wife';

export const familyLinkSchema = z.object({
  relativeId: z.coerce.number({ invalid_type_error: 'Choose a patient' }).int('Choose a patient').positive('Choose a patient'),
  relation: z.enum(FAMILY_RELATIONS, { errorMap: () => ({ message: 'Choose how they are related' }) }),
});
export type FamilyLinkInput = z.input<typeof familyLinkSchema>;

/** One relative of a patient, as clinic staff see it (patients never see family links). */
export interface FamilyMemberDto {
  /** The link, used to remove it. */
  linkId: number;
  patientId: number;
  patientIdentifier: string;
  fname: string;
  lname: string;
  phone: string;
  dateOfBirth: string | null;
  gender: string | null;
  /** What this person is to the patient whose page is open. */
  relation: FamilyRole;
  lastVisit: string | null;
  /** The next pending or confirmed visit from today on. */
  nextAppointment: { id: number; date: string; time: string } | null;
}

/** A spouse is shown as husband or wife when the gender is known, and as spouse when it is not. */
export function spouseRole(gender: string | null): FamilyRole {
  return gender === 'male' ? 'husband' : gender === 'female' ? 'wife' : 'spouse';
}

/** What a person is to the other one, seen from the other side of a link made as "<relative> is the patient's <relation>". */
export function inverseRole(relation: FamilyRelation, gender: string | null): FamilyRole {
  if (relation === 'sibling') return 'sibling';
  if (relation === 'spouse') return spouseRole(gender);
  if (relation === 'father' || relation === 'mother') return gender === 'male' ? 'son' : gender === 'female' ? 'daughter' : 'child';
  return gender === 'male' ? 'father' : gender === 'female' ? 'mother' : 'parent';
}
