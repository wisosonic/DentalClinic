import type { OfferItemStatus, OfferPaymentState, OfferWorkState } from './offers';
import type { DocumentCategory } from './documents';

// ---------------------------------------------------------------------------
// The patient portal (phase 8): what a patient sees of their own record. View only, plus cancelling an
// appointment with notice. Nothing here carries internal notes, the clinic's costs, other people's details or
// the doctors' shares.
// ---------------------------------------------------------------------------

export interface PortalAppointmentDto {
  id: number;
  date: string;
  time: string;
  endTime: string;
  durationMinutes: number;
  status: 'pending' | 'confirmed';
  doctor: { fname: string; lname: string };
  clinic: { name: string; address: string | null; phone: string | null } | null;
  /** The procedures booked, by name. */
  procedures: string[];
  /** Whether it is still far enough ahead to cancel online (the clinic's notice period). */
  canCancel: boolean;
  /** The last moment to cancel online, clinic time: "YYYY-MM-DD HH:MM". */
  cancelUntil: string;
}

export interface PortalOverviewDto {
  patient: {
    id: number;
    fname: string;
    lname: string;
    patientIdentifier: string;
    username: string | null;
    doctor: { fname: string; lname: string } | null;
  };
  /** The next appointment, if any. */
  next: PortalAppointmentDto | null;
  upcomingCount: number;
  /** Over the treatment offers the patient has agreed to; null when the clinic does not show patients money. */
  balance: { price: number; paid: number; remaining: number; currency: string } | null;
  /** Whether this clinic shows patients their payments, receipts and balances. */
  showPayments: boolean;
  /** Documents the clinic has marked as visible to the patient. */
  documentsCount: number;
  /** The notice period for cancelling online, in hours. */
  cancelMinHours: number;
}

export interface PortalOfferDto {
  id: number;
  title: string;
  description: string | null;
  price: number;
  /** The three of these are left out when the clinic does not show patients money. */
  paid?: number;
  remaining?: number;
  currency: string;
  paymentState?: OfferPaymentState;
  workState: OfferWorkState;
  progress: { done: number; total: number; percent: number };
  doctor: { fname: string; lname: string } | null;
  items: {
    id: number;
    sequence: number;
    description: string;
    tooth: string | null;
    price: number;
    status: OfferItemStatus;
    /** The visit booked for this work, if any. */
    visit: { date: string; time: string } | null;
  }[];
  createdAt: string | null;
}

export interface PortalPaymentDto {
  id: number;
  date: string;
  amount: number;
  currency: string;
  method: string | null;
  offerId: number | null;
  offerTitle: string | null;
  /** What was still owed on the offer after this payment. */
  remaining: number | null;
}

export interface PortalDocumentDto {
  id: number;
  category: DocumentCategory;
  title: string;
  takenOn: string | null;
  mime: string;
  sizeBytes: number;
  isImage: boolean;
}
