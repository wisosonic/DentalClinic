import { useGetMeQuery } from '../features/auth/authApi';

export function useRole() {
  const me = useGetMeQuery().data;
  const role = me?.role;
  return {
    role,
    isAdmin: role === 'admin',
    isDoctor: role === 'doctor',
    /** Can complete a visit. */
    canComplete: role === 'admin' || role === 'doctor',
    /** An external specialist: sees his own patients, and the visits he treats for others. */
    isSpecialist: role === 'doctor' && me?.doctor?.kind === 'external',
    /** The signed-in doctor's profile id, when there is one. */
    doctorId: role === 'doctor' ? (me?.doctor?.id ?? null) : null,
    /** A doctor login that isn't linked to a doctor profile yet: it sees nothing. */
    unlinkedDoctor: role === 'doctor' && me !== undefined && !me.doctor,
  };
}
