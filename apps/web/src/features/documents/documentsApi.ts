import type { DocumentAnnotationDto, DocumentAnnotationInput, DocumentCategory, DocumentCommentDto, Paginated, PatientDocumentDto } from '@aya/shared';
import { api } from '../auth/authApi';

export interface DocumentUploadArgs {
  patientId: number;
  file: File;
  category: DocumentCategory;
  title: string;
  takenOn?: string;
  note?: string;
  patientVisible?: boolean;
  allowDuplicate?: boolean;
}

export const documentsApi = api.injectEndpoints({
  endpoints: (build) => ({
    listDocuments: build.query<Paginated<PatientDocumentDto>, { patientId: number; category?: string; q?: string; tag?: string }>({
      query: ({ patientId, category, q, tag }) => ({ url: `/patients/${patientId}/documents`, params: Object.fromEntries(Object.entries({ category, q, tag }).filter(([, v]) => v)) as Record<string, string> }),
      providesTags: ['Document'],
    }),
    // The file is the request body and its details travel in the address (one file per request).
    uploadDocument: build.mutation<PatientDocumentDto, DocumentUploadArgs>({
      query: ({ patientId, file, category, title, takenOn, note, patientVisible, allowDuplicate }) => ({
        url: `/patients/${patientId}/documents`, method: 'POST', body: file, headers: { 'content-type': file.type },
        params: Object.fromEntries(Object.entries({ category, title, takenOn, note, name: file.name, patientVisible: patientVisible === undefined ? undefined : patientVisible ? '1' : '0', allowDuplicate: allowDuplicate ? '1' : undefined }).filter(([, v]) => v)) as Record<string, string>,
      }),
      transformResponse: (r: { document: PatientDocumentDto }) => r.document,
      invalidatesTags: ['Document'],
    }),
    updateDocument: build.mutation<PatientDocumentDto, { id: number; body: Record<string, unknown> }>({
      query: ({ id, body }) => ({ url: `/documents/${id}`, method: 'PATCH', body }),
      transformResponse: (r: { document: PatientDocumentDto }) => r.document,
      invalidatesTags: ['Document'],
    }),
    // Comments, tags and marks on a document (clinic-internal)
    listComments: build.query<DocumentCommentDto[], number>({
      query: (id) => `/documents/${id}/comments`,
      transformResponse: (r: { data: DocumentCommentDto[] }) => r.data,
      providesTags: ['Document'],
    }),
    addComment: build.mutation<DocumentCommentDto, { id: number; body: { body: string } }>({
      query: ({ id, body }) => ({ url: `/documents/${id}/comments`, method: 'POST', body }),
      transformResponse: (r: { comment: DocumentCommentDto }) => r.comment,
      invalidatesTags: ['Document'],
    }),
    updateComment: build.mutation<DocumentCommentDto, { id: number; commentId: number; body: { body: string } }>({
      query: ({ id, commentId, body }) => ({ url: `/documents/${id}/comments/${commentId}`, method: 'PATCH', body }),
      transformResponse: (r: { comment: DocumentCommentDto }) => r.comment,
      invalidatesTags: ['Document'],
    }),
    deleteComment: build.mutation<void, { id: number; commentId: number }>({
      query: ({ id, commentId }) => ({ url: `/documents/${id}/comments/${commentId}`, method: 'DELETE' }),
      invalidatesTags: ['Document'],
    }),
    setDocumentTags: build.mutation<{ tags: string[] }, { id: number; tags: string[] }>({
      query: ({ id, tags }) => ({ url: `/documents/${id}/tags`, method: 'PUT', body: { tags } }),
      invalidatesTags: ['Document'],
    }),
    listAnnotations: build.query<DocumentAnnotationDto[], number>({
      query: (id) => `/documents/${id}/annotations`,
      transformResponse: (r: { data: DocumentAnnotationDto[] }) => r.data,
      providesTags: ['Document'],
    }),
    addAnnotation: build.mutation<DocumentAnnotationDto, { id: number; body: DocumentAnnotationInput }>({
      query: ({ id, body }) => ({ url: `/documents/${id}/annotations`, method: 'POST', body }),
      transformResponse: (r: { annotation: DocumentAnnotationDto }) => r.annotation,
      invalidatesTags: ['Document'],
    }),
    updateAnnotation: build.mutation<DocumentAnnotationDto, { id: number; markId: number; body: { label?: string; x?: number; y?: number; w?: number; h?: number } }>({
      query: ({ id, markId, body }) => ({ url: `/documents/${id}/annotations/${markId}`, method: 'PATCH', body }),
      transformResponse: (r: { annotation: DocumentAnnotationDto }) => r.annotation,
      invalidatesTags: ['Document'],
    }),
    deleteAnnotation: build.mutation<void, { id: number; markId: number }>({
      query: ({ id, markId }) => ({ url: `/documents/${id}/annotations/${markId}`, method: 'DELETE' }),
      invalidatesTags: ['Document'],
    }),
    deleteDocument: build.mutation<void, number>({
      query: (id) => ({ url: `/documents/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Document', 'Trash'],
    }),
  }),
});

export const {
  useListDocumentsQuery, useUploadDocumentMutation, useUpdateDocumentMutation, useDeleteDocumentMutation,
  useListCommentsQuery, useAddCommentMutation, useUpdateCommentMutation, useDeleteCommentMutation, useSetDocumentTagsMutation,
  useListAnnotationsQuery, useAddAnnotationMutation, useUpdateAnnotationMutation, useDeleteAnnotationMutation,
} = documentsApi;
