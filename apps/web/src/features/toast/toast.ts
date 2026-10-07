import { createListenerMiddleware, createSlice, isFulfilled, nanoid, type PayloadAction } from '@reduxjs/toolkit';
import { translate } from '../../i18n';

export interface Toast {
  id: string;
  message: string;
}

const slice = createSlice({
  name: 'toast',
  initialState: [] as Toast[],
  reducers: {
    toastAdded: (state, action: PayloadAction<Toast>) => {
      // The same message again within a moment (a save made of several requests) is shown once.
      if (!state.some((t) => t.message === action.payload.message)) state.push(action.payload);
    },
    toastClosed: (state, action: PayloadAction<string>) => state.filter((t) => t.id !== action.payload),
  },
});

export const { toastAdded, toastClosed } = slice.actions;
export default slice.reducer;

/** What to say after each change (English text is the translation key). Endpoints not listed say nothing. */
export const TOAST_MESSAGES: Record<string, string> = {
  createPatient: 'Patient added',
  updatePatient: 'Patient saved',
  deletePatient: 'Patient moved to the Trash',
  createAppointment: 'Appointment booked',
  updateAppointment: 'Appointment saved',
  deleteAppointment: 'Appointment moved to the Trash',
  setAppointmentCategories: 'Procedures saved',
  setAppointmentTeeth: 'Procedures saved',
  saveReportSummary: 'Report saved',
  saveReportTeeth: 'Report saved',
  saveReportMedications: 'Report saved',
  deleteReport: 'Report moved to the Trash',
  createDoctor: 'Doctor added',
  updateDoctor: 'Doctor saved',
  deleteDoctor: 'Doctor deleted',
  createClinic: 'Clinic added',
  updateClinic: 'Clinic saved',
  deleteClinic: 'Clinic deleted',
  uploadClinicLogo: 'Logo saved',
  removeClinicLogo: 'Logo removed',
  createUnit: 'Dental unit added',
  renameUnit: 'Dental unit renamed',
  deleteUnit: 'Dental unit deleted',
  setClinicDoctor: 'Saved',
  removeClinicDoctor: 'Doctor removed from the clinic',
  createMedication: 'Medication added',
  updateMedication: 'Medication saved',
  deleteMedication: 'Medication deleted',
  createCategory: 'Procedure added',
  updateCategory: 'Procedure saved',
  deleteCategory: 'Procedure deleted',
  createUser: 'Account created',
  saveRole: 'Permissions saved',
  resetRole: 'Role put back to the built-in permissions',
  updateUser: 'Account saved',
  changePassword: 'Password changed',
  createPayment: 'Payment recorded',
  updatePayment: 'Payment saved',
  deletePayment: 'Payment moved to the Trash',
  createExpense: 'Expense added',
  updateExpense: 'Expense saved',
  deleteExpense: 'Expense moved to the Trash',
  uploadDocument: 'Document added',
  updateDocument: 'Document saved',
  deleteDocument: 'Document moved to the Trash',
  createOffer: 'Treatment offer created',
  updateOffer: 'Treatment offer saved',
  setOfferItems: 'Treatment offer saved',
  scheduleOfferItem: 'Visit booked',
  markOfferItemDone: 'Marked as done',
  markOfferItemPending: 'Marked as pending',
  deleteOffer: 'Treatment offer moved to the Trash',
  createLabOrder: 'Lab order added',
  updateLabOrder: 'Lab order saved',
  deleteLabOrder: 'Lab order moved to the Trash',
  createDirectoryEntry: 'Added',
  updateDirectoryEntry: 'Saved',
  deleteDirectoryEntry: 'Deleted',
  declareTaxYear: 'Year marked as declared and paid',
  reopenTaxYear: 'Year reopened',
  saveGeneralSettings: 'Settings saved',
  saveAppearanceSettings: 'Settings saved',
  saveTaxRules: 'Settings saved',
  deleteTaxRules: 'Tax rules deleted',
  createCommissionPayment: 'Commission payment recorded',
  updateCommissionPayment: 'Commission payment saved',
  deleteCommissionPayment: 'Commission payment moved to the Trash',
  restoreTrash: 'Restored',
  purgeTrash: 'Erased for good',
  checkInWaiting: 'Number given',
  resetWaitingScreen: 'Screen address made',
  deleteAuditEntry: 'Entry deleted',
  clearAudit: 'Log cleared',
};

/** Messages that depend on what was done to an appointment. */
export const WAITING_ACTION_MESSAGES: Record<string, string> = {
  call: 'Patient called',
  finish: 'Marked as finished',
  leave: 'Removed from the waiting room',
  requeue: 'Put back to waiting',
};

export const OFFER_ACTION_MESSAGES: Record<string, string> = {
  accept: 'Offer accepted',
  cancel: 'Offer cancelled',
};

export const LAB_ACTION_MESSAGES: Record<string, string> = {
  send: 'Order marked as sent',
  receive: 'Order marked as received',
  fit: 'Order marked as fitted',
};

export const ACTION_MESSAGES: Record<string, string> = {
  confirm: 'Appointment confirmed',
  cancel: 'Appointment cancelled',
  complete: 'Visit completed',
  'no-show': 'Marked as no-show',
};

/**
 * After any successful change (a mutation), say so. Reads never toast, and neither do the sign-in
 * flows or the dialogs that already show their result (reset links and temporary passwords).
 */
export const toastListener = createListenerMiddleware();
toastListener.startListening({
  matcher: isFulfilled,
  effect: (action, api) => {
    const meta = (action as { meta?: { arg?: { type?: string; endpointName?: string; originalArgs?: { action?: string } } } }).meta;
    if (meta?.arg?.type !== 'mutation') return;
    const endpoint = meta.arg.endpointName ?? '';
    const verb = meta.arg.originalArgs?.action ?? '';
    const key = endpoint === 'appointmentAction' ? ACTION_MESSAGES[verb] : endpoint === 'offerAction' ? OFFER_ACTION_MESSAGES[verb] : endpoint === 'labOrderAction' ? LAB_ACTION_MESSAGES[verb] : endpoint === 'waitingAction' ? WAITING_ACTION_MESSAGES[verb] : TOAST_MESSAGES[endpoint];
    if (key) api.dispatch(toastAdded({ id: nanoid(), message: translate(key) }));
  },
});
