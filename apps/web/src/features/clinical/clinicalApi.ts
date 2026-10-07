import type {
  AppointmentDto,
  AuditEntryDto,
  TrashImpactDto,
  TrashItemDto,
  BusyDto,
  CategoryDto,
  ChartToothDto,
  MedicationDto,
  PublicUser,
  ReportResponse,
  TimelineEntryDto,
  ClinicConfigDto,
  ClinicDoctorDto,
  ClinicDto,
  DoctorDto,
  Paginated,
  PatientDto,
  ToothDto,
  UnitDto,
} from '@aya/shared';
import { api } from '../auth/authApi';

export interface PatientListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: 'name' | 'phone' | 'number' | 'lastVisit' | 'createdAt';
  order?: 'asc' | 'desc';
}

export interface AppointmentListParams {
  page?: number;
  pageSize?: number;
  patientId?: number;
  doctorId?: number;
  clinicId?: number;
  unitId?: number;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  sort?: 'date' | 'time' | 'patient' | 'doctor' | 'unit' | 'status' | 'report';
  order?: 'asc' | 'desc';
}

export interface AuditListParams {
  page?: number;
  pageSize?: number;
  kind?: 'views' | 'changes';
  userId?: number;
  entity?: string;
  entityId?: string;
  from?: string;
  to?: string;
  sort?: 'time' | 'user' | 'action';
  order?: 'asc' | 'desc';
}

export interface TrashListParams {
  page?: number;
  pageSize?: number;
  kind?: TrashItemDto['kind'];
  q?: string;
  sort?: 'deletedAt' | 'kind' | 'label' | 'deletedBy';
  order?: 'asc' | 'desc';
}

export interface BusyParams {
  doctorId: number;
  unitId: number;
  date: string;
  excludeId?: number;
}

/** Drops undefined/empty values so they don't end up in the query string as "undefined". */
const qs = (params: object = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return { params: clean as Record<string, string | number> };
};

type Body = Record<string, unknown>;

export const clinicalApi = api.injectEndpoints({
  endpoints: (build) => ({
    // ----- reference ---------------------------------------------------------
    getConfig: build.query<ClinicConfigDto, void>({ query: () => '/config', providesTags: ['Settings'] }), // the settings pages change it
    getTeeth: build.query<ToothDto[], void>({ query: () => '/teeth', transformResponse: (r: { data: ToothDto[] }) => r.data }),
    getCategories: build.query<CategoryDto[], void>({
      query: () => '/categories',
      transformResponse: (r: { data: CategoryDto[] }) => r.data,
      providesTags: ['Category'],
    }),
    createCategory: build.mutation<CategoryDto, Body>({
      query: (body) => ({ url: '/categories', method: 'POST', body }),
      transformResponse: (r: { category: CategoryDto }) => r.category,
      invalidatesTags: ['Category'],
    }),
    updateCategory: build.mutation<CategoryDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/categories/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { category: CategoryDto }) => r.category,
      invalidatesTags: ['Category'],
    }),
    deleteCategory: build.mutation<void, number>({
      query: (id) => ({ url: `/categories/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Category'],
    }),

    // ----- medications (prescribing catalog) --------------------------------
    getMedications: build.query<MedicationDto[], void>({
      query: () => '/medications',
      transformResponse: (r: { data: MedicationDto[] }) => r.data,
      providesTags: ['Medication'],
    }),
    createMedication: build.mutation<MedicationDto, Body>({
      query: (body) => ({ url: '/medications', method: 'POST', body }),
      transformResponse: (r: { medication: MedicationDto }) => r.medication,
      invalidatesTags: ['Medication'],
    }),
    updateMedication: build.mutation<MedicationDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/medications/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { medication: MedicationDto }) => r.medication,
      invalidatesTags: ['Medication', 'Report', 'Timeline'],
    }),
    deleteMedication: build.mutation<void, number>({
      query: (id) => ({ url: `/medications/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Medication'],
    }),

    // ----- visit reports, timeline and tooth chart ---------------------------
    getReport: build.query<ReportResponse, number>({
      query: (appointmentId) => `/appointments/${appointmentId}/report`,
      providesTags: (_r, _e, id) => [{ type: 'Report', id }],
    }),
    saveReportSummary: build.mutation<ReportResponse, { appointmentId: number; summary: string }>({
      query: ({ appointmentId, summary }) => ({ url: `/appointments/${appointmentId}/report`, method: 'PUT', body: { summary } }),
      invalidatesTags: (_r, _e, a) => [{ type: 'Report', id: a.appointmentId }, 'Timeline'],
    }),
    saveReportTeeth: build.mutation<ReportResponse, { appointmentId: number; teeth: Body[] }>({
      query: ({ appointmentId, teeth }) => ({ url: `/appointments/${appointmentId}/report/teeth`, method: 'PUT', body: { teeth } }),
      invalidatesTags: (_r, _e, a) => [{ type: 'Report', id: a.appointmentId }, 'Timeline'],
    }),
    saveReportMedications: build.mutation<ReportResponse, { appointmentId: number; medications: Body[] }>({
      query: ({ appointmentId, medications }) => ({ url: `/appointments/${appointmentId}/report/medications`, method: 'PUT', body: { medications } }),
      invalidatesTags: (_r, _e, a) => [{ type: 'Report', id: a.appointmentId }, 'Timeline'],
    }),
    getTimeline: build.query<{ data: TimelineEntryDto[]; meta: { page: number; pageSize: number; total: number } }, { patientId: number | 'me'; page?: number; pageSize?: number }>({
      query: ({ patientId, page, pageSize }) => ({ url: patientId === 'me' ? '/patients/me/timeline' : `/patients/${patientId}/timeline`, ...qs({ page, pageSize }) }),
      providesTags: ['Timeline', 'Appointment', 'Report'],
    }),
    getChart: build.query<ChartToothDto[], number>({
      query: (patientId) => `/patients/${patientId}/chart`,
      transformResponse: (r: { data: ChartToothDto[] }) => r.data,
      providesTags: ['Report'],
    }),

    // ----- what is planned for an appointment --------------------------------
    setAppointmentCategories: build.mutation<AppointmentDto, { id: number; categoryIds: number[] }>({
      query: ({ id, categoryIds }) => ({ url: `/appointments/${id}/categories`, method: 'PUT', body: { categoryIds } }),
      transformResponse: (r: { appointment: AppointmentDto }) => r.appointment,
      invalidatesTags: ['Appointment', 'Timeline'],
    }),
    setAppointmentTeeth: build.mutation<AppointmentDto, { id: number; teeth: Body[] }>({
      query: ({ id, teeth }) => ({ url: `/appointments/${id}/teeth`, method: 'PUT', body: { teeth } }),
      transformResponse: (r: { appointment: AppointmentDto }) => r.appointment,
      invalidatesTags: ['Appointment'],
    }),

    // ----- logins (admin), to link a doctor profile to an account -------------
    listUsers: build.query<{ data: PublicUser[] }, void>({
      query: () => ({ url: '/users', params: { pageSize: 100, sort: 'name' } }),
      providesTags: ['User'],
    }),

    listAudit: build.query<Paginated<AuditEntryDto>, AuditListParams>({
      query: (p) => ({ url: '/audit-log', ...qs(p) }),
      providesTags: ['Audit'],
    }),
    deleteAuditEntry: build.mutation<void, number>({
      query: (id) => ({ url: `/audit-log/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Audit'],
    }),
    clearAudit: build.mutation<{ removed: number }, void>({
      query: () => ({ url: '/audit-log', method: 'DELETE', body: {} }),
      invalidatesTags: ['Audit'],
    }),
    deleteAppointment: build.mutation<void, number>({
      query: (id) => ({ url: `/appointments/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Appointment', 'Timeline', 'Report', 'Trash', 'Offer'],
    }),
    deleteReport: build.mutation<void, number>({
      query: (appointmentId) => ({ url: `/appointments/${appointmentId}/report`, method: 'DELETE' }),
      invalidatesTags: ['Report', 'Appointment', 'Timeline', 'Trash'],
    }),
    listTrash: build.query<Paginated<TrashItemDto>, TrashListParams>({
      query: (p) => ({ url: '/trash', ...qs(p) }),
      providesTags: ['Trash'],
    }),
    getTrashImpact: build.query<TrashImpactDto, { kind: string; id: number }>({
      query: ({ kind, id }) => `/trash/${kind}/${id}/impact`,
    }),
    restoreTrash: build.mutation<void, { kind: string; id: number }>({
      query: ({ kind, id }) => ({ url: `/trash/${kind}/${id}/restore`, method: 'POST', body: {} }),
      invalidatesTags: ['Trash', 'Patient', 'Appointment', 'Report', 'Timeline'],
    }),
    purgeTrash: build.mutation<void, { kind: string; id: number; confirm: string }>({
      query: ({ kind, id, confirm }) => ({ url: `/trash/${kind}/${id}`, method: 'DELETE', body: { confirm } }),
      invalidatesTags: ['Trash', 'Patient', 'Appointment', 'Report', 'Timeline'],
    }),
    createUser: build.mutation<{ user: PublicUser; temporaryPassword?: string }, { name: string; email: string; role: string }>({
      query: (body) => ({ url: '/users', method: 'POST', body }),
      invalidatesTags: ['User'],
    }),
    updateUser: build.mutation<{ user: PublicUser }, { id: number; body: { name?: string; role?: string; isActive?: boolean } }>({
      query: ({ id, body }) => ({ url: `/users/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['User'],
    }),
    resetUserPassword: build.mutation<{ temporaryPassword: string }, number>({
      query: (id) => ({ url: `/users/${id}/reset-password`, method: 'POST', body: {} }),
    }),
    createResetLink: build.mutation<{ link: string; expiresInHours: number }, number>({
      query: (id) => ({ url: `/users/${id}/reset-link`, method: 'POST', body: {} }),
    }),

    // ----- patients ----------------------------------------------------------
    listPatients: build.query<Paginated<PatientDto>, PatientListParams | void>({
      query: (p) => ({ url: '/patients', ...qs(p ?? {}) }),
      providesTags: ['Patient'],
    }),
    getMyPatient: build.query<PatientDto, void>({
      query: () => '/patients/me',
      transformResponse: (r: { patient: PatientDto }) => r.patient,
      providesTags: ['Patient'],
    }),
    getPatient: build.query<PatientDto, number>({
      query: (id) => `/patients/${id}`,
      transformResponse: (r: { patient: PatientDto }) => r.patient,
      providesTags: (_r, _e, id) => [{ type: 'Patient', id }],
    }),
    createPatient: build.mutation<PatientDto, { body: Body; allowDuplicate?: boolean }>({
      query: ({ body, allowDuplicate }) => ({ url: '/patients', method: 'POST', body, ...(allowDuplicate ? { params: { allowDuplicate: 'true' } } : {}) }),
      transformResponse: (r: { patient: PatientDto }) => r.patient,
      invalidatesTags: ['Patient'],
    }),
    updatePatient: build.mutation<PatientDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/patients/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { patient: PatientDto }) => r.patient,
      invalidatesTags: ['Patient', 'Appointment'],
    }),
    deletePatient: build.mutation<void, number>({
      query: (id) => ({ url: `/patients/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Patient', 'Appointment'],
    }),
    patientAppointments: build.query<AppointmentDto[], number>({
      query: (id) => `/patients/${id}/appointments`,
      transformResponse: (r: { data: AppointmentDto[] }) => r.data,
      providesTags: ['Appointment'],
    }),

    // ----- appointments ------------------------------------------------------
    listAppointments: build.query<Paginated<AppointmentDto>, AppointmentListParams | void>({
      query: (p) => ({ url: '/appointments', ...qs(p ?? {}) }),
      providesTags: ['Appointment'],
    }),
    getAppointment: build.query<AppointmentDto, number>({
      query: (id) => `/appointments/${id}`,
      transformResponse: (r: { appointment: AppointmentDto }) => r.appointment,
      providesTags: ['Appointment'],
    }),
    getBusy: build.query<BusyDto, BusyParams>({
      query: (p) => ({ url: '/appointments/busy', ...qs(p) }),
      // What is booked changes whenever anything is booked, so it is refetched with the appointments.
      providesTags: ['Appointment'],
    }),
    createAppointment: build.mutation<AppointmentDto, Body>({
      query: (body) => ({ url: '/appointments', method: 'POST', body }),
      transformResponse: (r: { appointment: AppointmentDto }) => r.appointment,
      invalidatesTags: ['Appointment', 'Patient'],
    }),
    updateAppointment: build.mutation<AppointmentDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/appointments/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { appointment: AppointmentDto }) => r.appointment,
      invalidatesTags: ['Appointment'],
    }),
    appointmentAction: build.mutation<AppointmentDto, { id: number; action: 'confirm' | 'cancel' | 'complete' | 'no-show' }>({
      query: ({ id, action }) => ({ url: `/appointments/${id}/${action}`, method: 'POST' }),
      transformResponse: (r: { appointment: AppointmentDto }) => r.appointment,
      invalidatesTags: ['Appointment', 'Patient', 'Offer'], // completing a visit updates the patient's last visit
    }),

    // ----- doctors and clinics ----------------------------------------------
    getDoctors: build.query<DoctorDto[], void>({
      query: () => '/doctors',
      transformResponse: (r: { data: DoctorDto[] }) => r.data,
      providesTags: ['Doctor'],
    }),
    createDoctor: build.mutation<DoctorDto, Body>({
      query: (body) => ({ url: '/doctors', method: 'POST', body }),
      transformResponse: (r: { doctor: DoctorDto }) => r.doctor,
      invalidatesTags: ['Doctor'],
    }),
    updateDoctor: build.mutation<DoctorDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/doctors/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { doctor: DoctorDto }) => r.doctor,
      invalidatesTags: ['Doctor', 'Clinic', 'Appointment'],
    }),
    deleteDoctor: build.mutation<void, number>({
      query: (id) => ({ url: `/doctors/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Doctor', 'Clinic'],
    }),

    getClinics: build.query<ClinicDto[], void>({
      query: () => '/clinics',
      transformResponse: (r: { data: ClinicDto[] }) => r.data,
      providesTags: ['Clinic'],
    }),
    createClinic: build.mutation<ClinicDto, Body>({
      query: (body) => ({ url: '/clinics', method: 'POST', body }),
      transformResponse: (r: { clinic: ClinicDto }) => r.clinic,
      invalidatesTags: ['Clinic'],
    }),
    updateClinic: build.mutation<ClinicDto, { id: number; body: Body }>({
      query: ({ id, body }) => ({ url: `/clinics/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { clinic: ClinicDto }) => r.clinic,
      invalidatesTags: ['Clinic', 'Appointment'],
    }),
    // The image is sent as the raw request body; the server checks its bytes, not this type.
    uploadClinicLogo: build.mutation<ClinicDto, { id: number; file: File }>({
      query: ({ id, file }) => ({ url: `/clinics/${id}/logo`, method: 'PUT', body: file, headers: { 'content-type': file.type } }),
      transformResponse: (r: { clinic: ClinicDto }) => r.clinic,
      invalidatesTags: ['Clinic'],
    }),
    removeClinicLogo: build.mutation<ClinicDto, number>({
      query: (id) => ({ url: `/clinics/${id}/logo`, method: 'DELETE' }),
      transformResponse: (r: { clinic: ClinicDto }) => r.clinic,
      invalidatesTags: ['Clinic'],
    }),
    deleteClinic: build.mutation<void, number>({
      query: (id) => ({ url: `/clinics/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Clinic'],
    }),
    getUnits: build.query<UnitDto[], number | void>({
      query: (clinicId) => ({ url: '/units', ...qs(clinicId ? { clinicId } : {}) }),
      transformResponse: (r: { data: UnitDto[] }) => r.data,
      providesTags: ['Unit'],
    }),
    createUnit: build.mutation<UnitDto, { clinicId: number; ownerDoctorId: number; name: string }>({
      query: (body) => ({ url: '/units', method: 'POST', body }),
      transformResponse: (r: { unit: UnitDto }) => r.unit,
      invalidatesTags: ['Unit'],
    }),
    renameUnit: build.mutation<UnitDto, { id: number; name: string }>({
      query: ({ id, name }) => ({ url: `/units/${id}`, method: 'PATCH', body: { name } }),
      transformResponse: (r: { unit: UnitDto }) => r.unit,
      invalidatesTags: ['Unit', 'Appointment'],
    }),
    deleteUnit: build.mutation<void, number>({
      query: (id) => ({ url: `/units/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Unit'],
    }),
    getClinicDoctors: build.query<ClinicDoctorDto[], number>({
      query: (clinicId) => `/clinics/${clinicId}/doctors`,
      transformResponse: (r: { data: ClinicDoctorDto[] }) => r.data,
      providesTags: (_r, _e, id) => [{ type: 'Clinic', id }, 'Clinic'],
    }),
    setClinicDoctor: build.mutation<ClinicDoctorDto, { clinicId: number; doctorId: number; body: Body }>({
      query: ({ clinicId, doctorId, body }) => ({ url: `/clinics/${clinicId}/doctors/${doctorId}`, method: 'PUT', body }),
      transformResponse: (r: { link: ClinicDoctorDto }) => r.link,
      invalidatesTags: ['Clinic', 'Appointment', 'Unit'],
    }),
    removeClinicDoctor: build.mutation<void, { clinicId: number; doctorId: number }>({
      query: ({ clinicId, doctorId }) => ({ url: `/clinics/${clinicId}/doctors/${doctorId}`, method: 'DELETE' }),
      invalidatesTags: ['Clinic', 'Appointment'],
    }),
  }),
});

export const {
  useGetConfigQuery,
  useGetTeethQuery,
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
  useGetMedicationsQuery,
  useCreateMedicationMutation,
  useUpdateMedicationMutation,
  useDeleteMedicationMutation,
  useGetReportQuery,
  useSaveReportSummaryMutation,
  useSaveReportTeethMutation,
  useSaveReportMedicationsMutation,
  useGetTimelineQuery,
  useGetChartQuery,
  useSetAppointmentCategoriesMutation,
  useSetAppointmentTeethMutation,
  useListUsersQuery,
  useListAuditQuery,
  useClearAuditMutation,
  useDeleteAuditEntryMutation,
  useDeleteAppointmentMutation,
  useDeleteReportMutation,
  useListTrashQuery,
  useGetTrashImpactQuery,
  useRestoreTrashMutation,
  usePurgeTrashMutation,
  useCreateUserMutation,
  useUpdateUserMutation,
  useResetUserPasswordMutation,
  useCreateResetLinkMutation,
  useListPatientsQuery,
  useGetPatientQuery,
  useCreatePatientMutation,
  useUpdatePatientMutation,
  useDeletePatientMutation,
  usePatientAppointmentsQuery,
  useListAppointmentsQuery,
  useGetAppointmentQuery,
  useGetBusyQuery,
  useGetUnitsQuery,
  useCreateUnitMutation,
  useRenameUnitMutation,
  useDeleteUnitMutation,
  useCreateAppointmentMutation,
  useUpdateAppointmentMutation,
  useAppointmentActionMutation,
  useGetMyPatientQuery,
  useGetDoctorsQuery,
  useCreateDoctorMutation,
  useUpdateDoctorMutation,
  useDeleteDoctorMutation,
  useGetClinicsQuery,
  useCreateClinicMutation,
  useUpdateClinicMutation,
  useDeleteClinicMutation,
  useUploadClinicLogoMutation,
  useRemoveClinicLogoMutation,
  useGetClinicDoctorsQuery,
  useSetClinicDoctorMutation,
  useRemoveClinicDoctorMutation,
} = clinicalApi;
