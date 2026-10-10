import type { Router } from 'express';
import { z } from 'zod';
import {
  MAX_ANNOTATIONS_PER_DOCUMENT, annotationGeometryProblem, documentAnnotationSchema, documentAnnotationUpdateSchema, documentCommentSchema, documentTagsSchema, tagKey,
  type AnnotationKind, type DocumentAnnotationDto, type DocumentCommentDto,
} from '@aya/shared';
import type { AppContext } from '../../context';
import { sqlNow } from '../../db/connection';
import { HttpError, badRequest, forbidden, notFound } from '../../lib/errors';
import { requirePermission, requireUser, type AuthUser } from '../../middleware/auth';
import { audit } from '../audit/audit';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- DB row

const idParam = z.coerce.number().int().positive();

/** What the lists of documents also carry: tags and how many comments and marks each has. */
export async function noteSummaries(ctx: AppContext, ids: number[]): Promise<{ tags: Map<number, string[]>; comments: Map<number, number>; annotations: Map<number, number> }> {
  const out = { tags: new Map<number, string[]>(), comments: new Map<number, number>(), annotations: new Map<number, number>() };
  if (!ids.length) return out;
  for (const r of (await ctx.db('document_tags').whereIn('document_id', ids).orderBy('id').select('document_id', 'tag')) as Row[]) {
    out.tags.set(r.document_id, [...(out.tags.get(r.document_id) ?? []), r.tag]);
  }
  for (const r of (await ctx.db('document_comments').whereIn('document_id', ids).groupBy('document_id').select('document_id').count({ n: '*' })) as Row[]) out.comments.set(r.document_id, Number(r.n));
  for (const r of (await ctx.db('document_annotations').whereIn('document_id', ids).groupBy('document_id').select('document_id').count({ n: '*' })) as Row[]) out.annotations.set(r.document_id, Number(r.n));
  return out;
}

/**
 * Comments, tags and annotations on a document, mounted on `/documents/:id`. Anyone who may open the document and holds
 * `documents:update` may add them (this is collaboration, so it is not limited to the uploader); a comment or mark is
 * changed or removed by its author, and removed by an admin. Tags and marks are for pictures only. Everything here is
 * clinic-internal: no patient route reads it. The audit log gets ids and counts only, never the words.
 */
export function mountDocumentNotes(byId: Router, ctx: AppContext, load: (user: AuthUser, id: number) => Promise<Row>): void {
  const { db } = ctx;
  const mime = (row: Row) => String(row.mime);
  const needPicture = (row: Row) => {
    if (!mime(row).startsWith('image/')) throw new HttpError(409, 'NOT_AN_IMAGE', 'Tags and marks are for pictures only');
  };
  const who = (r: Row, key = 'user_id') => (r[key] ? { id: r[key] as number, name: (r.u_name as string | null) ?? '' } : null);

  // ----- comments ----------------------------------------------------------------------------------------------
  const commentDto = (r: Row, user: AuthUser): DocumentCommentDto => ({
    id: r.id, body: r.body, author: who(r), createdAt: r.created_at ?? null, edited: !!r.updated_at && r.updated_at !== r.created_at,
    canEdit: r.user_id === user.id, canDelete: r.user_id === user.id || user.role === 'admin',
  });
  const commentRows = () => db('document_comments as c').leftJoin('users as u', 'u.id', 'c.user_id').select('c.*', 'u.name as u_name');

  byId.get('/:id/comments', requirePermission('documents:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await load(user, id);
    const rows: Row[] = await commentRows().where('c.document_id', id).orderBy([{ column: 'c.created_at' }, { column: 'c.id' }]);
    res.json({ data: rows.map((r) => commentDto(r, user)) });
  });

  byId.post('/:id/comments', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = documentCommentSchema.parse(req.body);
    await load(user, id);
    const now = sqlNow();
    const [commentId] = await db('document_comments').insert({ document_id: id, user_id: user.id, body: input.body, created_at: now, updated_at: now });
    await audit(ctx, req, { userId: user.id, action: 'document.comment.add', entity: 'document', entityId: id, diff: { commentId } });
    res.status(201).json({ comment: commentDto(await commentRows().where('c.id', commentId!).first(), user) });
  });

  async function ownComment(user: AuthUser, docId: number, commentId: number): Promise<Row> {
    await load(user, docId);
    const row: Row | undefined = await db('document_comments').where({ id: commentId, document_id: docId }).first();
    if (!row) throw notFound('Comment not found');
    return row;
  }

  byId.patch('/:id/comments/:commentId', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const commentId = idParam.parse(req.params.commentId);
    const input = documentCommentSchema.parse(req.body);
    const row = await ownComment(user, id, commentId);
    if (row.user_id !== user.id) throw forbidden('Only the person who wrote a comment can edit it');
    await db('document_comments').where({ id: commentId }).update({ body: input.body, updated_at: sqlNow() });
    await audit(ctx, req, { userId: user.id, action: 'document.comment.update', entity: 'document', entityId: id, diff: { commentId } });
    res.json({ comment: commentDto(await commentRows().where('c.id', commentId).first(), user) });
  });

  byId.delete('/:id/comments/:commentId', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const commentId = idParam.parse(req.params.commentId);
    const row = await ownComment(user, id, commentId);
    if (row.user_id !== user.id && user.role !== 'admin') throw forbidden('Only the person who wrote a comment, or an admin, can delete it');
    await db('document_comments').where({ id: commentId }).del();
    await audit(ctx, req, { userId: user.id, action: 'document.comment.delete', entity: 'document', entityId: id, diff: { commentId } });
    res.status(204).end();
  });

  // ----- tags (pictures only) ----------------------------------------------------------------------------------
  byId.put('/:id/tags', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = documentTagsSchema.parse(req.body);
    needPicture(await load(user, id));
    const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');
    const unique = new Map<string, string>();
    for (const tag of input.tags) unique.set(tagKey(tag), tidy(tag)); // the same tag in another case is one tag
    const now = sqlNow();
    await db.transaction(async (trx) => {
      await trx('document_tags').where({ document_id: id }).del();
      if (unique.size) await trx('document_tags').insert([...unique].map(([key, tag]) => ({ document_id: id, tag, tag_key: key, created_by: user.id, created_at: now })));
    });
    await audit(ctx, req, { userId: user.id, action: 'document.tags.set', entity: 'document', entityId: id, diff: { count: unique.size } });
    res.json({ tags: [...unique.values()] });
  });

  // ----- annotations (pictures only) ---------------------------------------------------------------------------
  const markDto = (r: Row, user: AuthUser): DocumentAnnotationDto => ({
    id: r.id, kind: r.kind as AnnotationKind, x: Number(r.x), y: Number(r.y), w: r.w == null ? null : Number(r.w), h: r.h == null ? null : Number(r.h), label: r.label,
    author: who(r, 'created_by'), createdAt: r.created_at ?? null, canChange: r.created_by === user.id || user.role === 'admin',
  });
  const markRows = () => db('document_annotations as a').leftJoin('users as u', 'u.id', 'a.created_by').select('a.*', 'u.name as u_name');

  byId.get('/:id/annotations', requirePermission('documents:read'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    await load(user, id);
    const rows: Row[] = await markRows().where('a.document_id', id).orderBy('a.id');
    res.json({ data: rows.map((r) => markDto(r, user)) });
  });

  byId.post('/:id/annotations', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const input = documentAnnotationSchema.parse(req.body);
    needPicture(await load(user, id));
    const count = Number((await db('document_annotations').where({ document_id: id }).count({ n: '*' }).first())?.n ?? 0);
    if (count >= MAX_ANNOTATIONS_PER_DOCUMENT) throw new HttpError(409, 'TOO_MANY_ANNOTATIONS', 'This picture has as many marks as it can hold', { max: MAX_ANNOTATIONS_PER_DOCUMENT });
    const now = sqlNow();
    const [markId] = await db('document_annotations').insert({
      document_id: id, kind: input.kind, x: input.x, y: input.y, w: input.kind === 'box' ? input.w : null, h: input.kind === 'box' ? input.h : null,
      label: input.label, created_by: user.id, created_at: now, updated_at: now,
    });
    await audit(ctx, req, { userId: user.id, action: 'document.annotation.add', entity: 'document', entityId: id, diff: { annotationId: markId, kind: input.kind } });
    res.status(201).json({ annotation: markDto(await markRows().where('a.id', markId!).first(), user) });
  });

  async function ownMark(user: AuthUser, docId: number, markId: number): Promise<Row> {
    await load(user, docId);
    const row: Row | undefined = await db('document_annotations').where({ id: markId, document_id: docId }).first();
    if (!row) throw notFound('Mark not found');
    if (row.created_by !== user.id && user.role !== 'admin') throw forbidden('Only the person who made a mark, or an admin, can change it');
    return row;
  }

  byId.patch('/:id/annotations/:markId', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const markId = idParam.parse(req.params.markId);
    const input = documentAnnotationUpdateSchema.parse(req.body);
    const row = await ownMark(user, id, markId);
    const next = { kind: row.kind as AnnotationKind, x: input.x ?? Number(row.x), y: input.y ?? Number(row.y), w: input.w ?? (row.w == null ? null : Number(row.w)), h: input.h ?? (row.h == null ? null : Number(row.h)) };
    const problem = annotationGeometryProblem(next);
    if (problem) throw badRequest('INVALID_ANNOTATION', problem);
    await db('document_annotations').where({ id: markId }).update({
      ...(input.label !== undefined && { label: input.label }), x: next.x, y: next.y, w: next.w, h: next.h, updated_at: sqlNow(),
    });
    await audit(ctx, req, { userId: user.id, action: 'document.annotation.update', entity: 'document', entityId: id, diff: { annotationId: markId, fields: Object.keys(input) } });
    res.json({ annotation: markDto(await markRows().where('a.id', markId).first(), user) });
  });

  byId.delete('/:id/annotations/:markId', requirePermission('documents:update'), async (req, res) => {
    const user = requireUser(req);
    const id = idParam.parse(req.params.id);
    const markId = idParam.parse(req.params.markId);
    await ownMark(user, id, markId);
    await db('document_annotations').where({ id: markId }).del();
    await audit(ctx, req, { userId: user.id, action: 'document.annotation.delete', entity: 'document', entityId: id, diff: { annotationId: markId } });
    res.status(204).end();
  });
}
