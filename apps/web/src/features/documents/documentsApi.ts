import type { DocumentCategory, Paginated, PatientDocumentDto } from '@aya/shared';
import { api } from '../auth/authApi';

export interface DocumentUploadArgs {
  patientId: number;
  file: File;
  category: DocumentCategory;
  title: string;
  takenOn?: string;
  note?: string;
  allowDuplicate?: boolean;
}

export const documentsApi = api.injectEndpoints({
  endpoints: (build) => ({
    listDocuments: build.query<Paginated<PatientDocumentDto>, { patientId: number; category?: string; q?: string }>({
      query: ({ patientId, category, q }) => ({ url: `/patients/${patientId}/documents`, params: Object.fromEntries(Object.entries({ category, q }).filter(([, v]) => v)) as Record<string, string> }),
      providesTags: ['Document'],
    }),
    // The file is the request body and its details travel in the address (one file per request).
    uploadDocument: build.mutation<PatientDocumentDto, DocumentUploadArgs>({
      query: ({ patientId, file, category, title, takenOn, note, allowDuplicate }) => ({
        url: `/patients/${patientId}/documents`, method: 'POST', body: file, headers: { 'content-type': file.type },
        params: Object.fromEntries(Object.entries({ category, title, takenOn, note, name: file.name, allowDuplicate: allowDuplicate ? '1' : undefined }).filter(([, v]) => v)) as Record<string, string>,
      }),
      transformResponse: (r: { document: PatientDocumentDto }) => r.document,
      invalidatesTags: ['Document'],
    }),
    updateDocument: build.mutation<PatientDocumentDto, { id: number; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ url: `/documents/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { document: PatientDocumentDto }) => r.document,
      invalidatesTags: ['Document'],
    }),
    deleteDocument: build.mutation<void, number>({
      query: (id) => ({ url: `/documents/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Document', 'Trash'],
    }),
  }),
});

export const { useListDocumentsQuery, useUploadDocumentMutation, useUpdateDocumentMutation, useDeleteDocumentMutation } = documentsApi;
