import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { PATIENT, empty, errorBody, json, renderApp, useFakeApi, user } from './mockApi';

const api = useFakeApi();

const CONFIG = { defaultDuration: 30, durationStep: 15, minDuration: 15, maxDuration: 480, cancelMinHours: 24, timezone: 'Asia/Beirut', today: '2026-10-09' };
const doc = (extra: object = {}) => ({
  id: 1, patientId: 7, category: 'xray', title: 'Upper right', takenOn: '2026-10-01', note: null, fileName: 'scan.png', mime: 'image/png', sizeBytes: 2_500_000, isImage: true,
  appointment: null, patientVisible: false, uploadedBy: { id: 4, name: 'Sam Staff' }, createdAt: '2026-10-01 09:00:00', canChange: true,
  tags: [], commentCount: 0, annotationCount: 0, ...extra,
});
const pdfDoc = (extra: object = {}) => doc({ id: 2, category: 'blood_test', title: 'Blood results', mime: 'application/pdf', isImage: false, sizeBytes: 90_000, takenOn: '2026-09-20', ...extra });
const comment = (extra: object = {}) => ({ id: 31, body: 'Compare with last year', author: { id: 4, name: 'Sam Staff' }, createdAt: '2026-10-02 10:00:00', edited: false, canEdit: true, canDelete: true, ...extra });
const mark = (extra: object = {}) => ({ id: 51, kind: 'pin', x: 0.4, y: 0.5, w: null, h: null, label: 'Caries under the filling', author: { id: 4, name: 'Sam Staff' }, createdAt: '2026-10-02 10:00:00', canChange: true, ...extra });
const list = (data: unknown[]) => json(200, { data, meta: { page: 1, pageSize: 200, total: data.length } });
const calls = (method: string, path: string) => api.calls.filter((c) => c.method === method && c.path === path);

interface Options { docs?: unknown[]; comments?: unknown[]; marks?: unknown[]; me?: object }
const open = async ({ docs = [doc({ tags: ['follow-up'], commentCount: 1, annotationCount: 1 }), pdfDoc()], comments = [comment()], marks = [mark()], me = {} }: Options = {}) => {
  api.routes['GET /auth/me'] = () => json(200, { user: user('staff', me) });
  api.routes['GET /config'] = () => json(200, CONFIG);
  api.routes['GET /patients/7'] = () => json(200, { patient: PATIENT });
  api.routes['GET /patients/7/timeline'] = () => json(200, { data: [], meta: { page: 1, pageSize: 50, total: 0 } });
  api.routes['GET /patients/7/chart'] = () => json(200, { data: [] });
  api.routes['GET /teeth'] = () => json(200, { data: [] });
  api.routes['GET /patients/7/documents'] = () => list(docs);
  api.routes['GET /documents/1/comments'] = () => json(200, { data: comments });
  api.routes['GET /documents/1/annotations'] = () => json(200, { data: marks });
  api.routes['GET /documents/2/comments'] = () => json(200, { data: [] });
  renderApp(<App />, '/patients/7/documents');
  await screen.findByRole('heading', { name: 'Documents' });
};
const viewer = async (title = 'Upper right') => {
  await userEvent.click(await screen.findByRole('button', { name: `Comments, tags and marks of ${title}` }));
  return within(await screen.findByRole('dialog'));
};

/** A pointer event with a position (jsdom builds pointer events without one). */
const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', el: Element, x: number, y: number) => {
  const event = createEvent[type](el, { pointerId: 1 });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } });
  fireEvent(el, event);
};

/** Gives the picture a size, as a browser would (jsdom has none). */
const surfaceOf = async (v: ReturnType<typeof within>) => {
  const surface = await v.findByTestId('mark-surface');
  (surface.parentElement as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  return surface;
};

describe('the list', () => {
  it('shows each document’s tags and how many marks and comments it has, and a button to its notes', async () => {
    await open();
    const row = (await screen.findByText('Upper right')).closest('tr') as HTMLElement;
    expect(within(row).getByText('follow-up')).toBeInTheDocument();
    expect(within(row).getByLabelText('1 marks on the picture')).toBeInTheDocument();
    expect(within(row).getByLabelText('1 comments')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comments, tags and marks of Blood results' })).toBeInTheDocument(); // a PDF too
  });

  it('filters by a tag, from the list of tags or by clicking one', async () => {
    await open();
    const row = (await screen.findByText('Upper right')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByText('follow-up'));
    await waitFor(() => expect(calls('GET', '/patients/7/documents').at(-1)!.query.get('tag')).toBe('follow-up'));
    expect(await screen.findByRole('combobox', { name: 'Tag' })).toHaveTextContent('follow-up');
  });
});

describe('the viewer', () => {
  it('shows the picture with its tags, its marks (numbered) and its comments, and steps through the other documents', async () => {
    await open();
    const v = await viewer();
    expect(v.getByRole('img', { name: 'Upper right' })).toHaveAttribute('src', '/api/v1/documents/1/file');
    expect(within(v.getByRole('region', { name: 'Tags' })).getByText('follow-up')).toBeInTheDocument();
    const marks = within(await v.findByRole('region', { name: 'Marks on the picture' }));
    expect(marks.getByText('Caries under the filling')).toBeInTheDocument();
    expect(v.getByRole('button', { name: 'Mark 1: Caries under the filling' })).toBeInTheDocument();
    const comments = within(await v.findByRole('region', { name: 'Comments' }));
    expect(comments.getByText('Compare with last year')).toBeInTheDocument();
    expect(comments.getByText(/Sam Staff/)).toBeInTheDocument();
    expect(v.getByRole('button', { name: 'Show Upper right' })).toHaveAttribute('aria-current', 'true'); // the strip of small previews
    await userEvent.click(v.getByRole('button', { name: 'Show Blood results' }));
    expect(await v.findByText('Open the PDF')).toBeInTheDocument();
    expect(v.queryByRole('region', { name: 'Tags' })).not.toBeInTheDocument(); // tags and marks are for pictures
    expect(v.queryByRole('region', { name: 'Marks on the picture' })).not.toBeInTheDocument();
    expect(v.getByRole('region', { name: 'Comments' })).toBeInTheDocument();
  });

  it('is read only for someone who may not write notes', async () => {
    await open({ me: { permissions: ['documents:read'] } });
    const v = await viewer();
    await v.findByText('Compare with last year');
    expect(v.queryByLabelText('Write a comment')).not.toBeInTheDocument();
    expect(v.queryByLabelText('Add a tag')).not.toBeInTheDocument();
    expect(v.queryByRole('button', { name: 'Add a pin' })).not.toBeInTheDocument();
    expect(v.queryByRole('button', { name: 'Edit mark 1' })).not.toBeInTheDocument();
  });
});

describe('comments', () => {
  it('adds one, and cannot add an empty one', async () => {
    await open();
    api.routes['POST /documents/1/comments'] = () => json(201, { comment: comment({ id: 32, body: 'New one' }) });
    const v = await viewer();
    const add = v.getByRole('button', { name: 'Add comment' });
    expect(add).toBeDisabled();
    await userEvent.type(v.getByLabelText('Write a comment'), '  New one ');
    await userEvent.click(add);
    await waitFor(() => expect(calls('POST', '/documents/1/comments')).toHaveLength(1));
    expect(calls('POST', '/documents/1/comments')[0]!.body).toEqual({ body: 'New one' });
    expect(await screen.findByText('Comment added')).toBeInTheDocument();
    await waitFor(() => expect(v.getByLabelText('Write a comment')).toHaveValue(''));
  });

  it('edits and deletes one’s own, and offers neither on someone else’s', async () => {
    await open({ comments: [comment(), comment({ id: 32, body: 'From the doctor', author: { id: 9, name: 'Dr Aya' }, canEdit: false, canDelete: false })] });
    api.routes['PATCH /documents/1/comments/31'] = () => json(200, { comment: comment({ body: 'Changed', edited: true }) });
    api.routes['DELETE /documents/1/comments/31'] = () => empty();
    const v = await viewer();
    await v.findByText('From the doctor');
    expect(v.getAllByRole('button', { name: 'Edit the comment' })).toHaveLength(1);
    expect(v.getAllByRole('button', { name: 'Delete the comment' })).toHaveLength(1);
    await userEvent.click(v.getByRole('button', { name: 'Edit the comment' }));
    const box = v.getByRole('textbox', { name: 'Edit the comment' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Changed');
    await userEvent.click(v.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PATCH', '/documents/1/comments/31')[0]!.body).toEqual({ body: 'Changed' }));
    await userEvent.click(v.getByRole('button', { name: 'Delete the comment' }));
    await waitFor(() => expect(calls('DELETE', '/documents/1/comments/31')).toHaveLength(1));
  });

  it('shows the server’s refusal', async () => {
    await open();
    api.routes['POST /documents/1/comments'] = () => json(404, errorBody('NOT_FOUND', 'Document not found'));
    const v = await viewer();
    await userEvent.type(v.getByLabelText('Write a comment'), 'Hello');
    await userEvent.click(v.getByRole('button', { name: 'Add comment' }));
    expect(await v.findByRole('alert')).toHaveTextContent('Document not found');
  });
});

describe('tags', () => {
  it('adds a tag with Enter, sending the whole set, and refuses one that is already there', async () => {
    await open();
    api.routes['PUT /documents/1/tags'] = (c) => json(200, { tags: (c.body as { tags: string[] }).tags });
    const v = await viewer();
    const input = v.getByLabelText('Add a tag');
    await userEvent.type(input, 'Tooth 36{Enter}');
    await waitFor(() => expect(calls('PUT', '/documents/1/tags')).toHaveLength(1));
    expect(calls('PUT', '/documents/1/tags')[0]!.body).toEqual({ tags: ['follow-up', 'Tooth 36'] });
    expect(await screen.findByText('Tags saved')).toBeInTheDocument();
    await userEvent.type(input, 'FOLLOW-UP{Enter}');
    expect(await v.findByText('This tag is already there')).toBeInTheDocument();
    expect(calls('PUT', '/documents/1/tags')).toHaveLength(1);
  });

  it('removes a tag', async () => {
    await open({ docs: [doc({ tags: ['follow-up', 'cbct'] })] });
    api.routes['PUT /documents/1/tags'] = (c) => json(200, { tags: (c.body as { tags: string[] }).tags });
    const v = await viewer();
    await userEvent.click(v.getByLabelText('Remove the tag follow-up'));
    await waitFor(() => expect(calls('PUT', '/documents/1/tags')[0]!.body).toEqual({ tags: ['cbct'] }));
  });
});

describe('marks on the picture', () => {
  it('adds a pin where the picture is clicked, as fractions of its size, once it has words', async () => {
    await open({ marks: [] });
    api.routes['POST /documents/1/annotations'] = () => json(201, { annotation: mark({ id: 52, x: 0.25, y: 0.5, label: 'Crack' }) });
    const v = await viewer();
    await userEvent.click(v.getByRole('button', { name: 'Add a pin' }));
    const surface = await surfaceOf(v);
    pointer('pointerDown', surface, 50, 50);
    pointer('pointerUp', surface, 50, 50);
    const save = await v.findByRole('button', { name: 'Save the mark' });
    expect(save).toBeDisabled(); // a mark needs its words
    await userEvent.type(v.getByLabelText('What is this mark?'), 'Crack');
    await userEvent.click(save);
    await waitFor(() => expect(calls('POST', '/documents/1/annotations')).toHaveLength(1));
    expect(calls('POST', '/documents/1/annotations')[0]!.body).toEqual({ kind: 'pin', x: 0.25, y: 0.5, label: 'Crack' });
    expect(await screen.findByText('Mark added')).toBeInTheDocument();
    await waitFor(() => expect(v.queryByLabelText('What is this mark?')).not.toBeInTheDocument());
  });

  it('draws a box by dragging, in any direction, and ignores a tap', async () => {
    await open({ marks: [] });
    api.routes['POST /documents/1/annotations'] = () => json(201, { annotation: mark({ id: 53, kind: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'Bone loss' }) });
    const v = await viewer();
    await userEvent.click(v.getByRole('button', { name: 'Draw a box' }));
    const surface = await surfaceOf(v);
    pointer('pointerDown', surface, 100, 60);
    pointer('pointerUp', surface, 100, 60); // a tap: no box
    expect(v.queryByLabelText('What is this mark?')).not.toBeInTheDocument();
    pointer('pointerDown', surface, 80, 60); // from the lower right to the upper left
    pointer('pointerMove', surface, 40, 30);
    pointer('pointerUp', surface, 20, 20);
    await userEvent.type(await v.findByLabelText('What is this mark?'), 'Bone loss');
    await userEvent.click(v.getByRole('button', { name: 'Save the mark' }));
    await waitFor(() => expect(calls('POST', '/documents/1/annotations')).toHaveLength(1));
    const body = calls('POST', '/documents/1/annotations')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'box', label: 'Bone loss' });
    expect(body.x).toBeCloseTo(0.1); // 20 of 200
    expect(body.y).toBeCloseTo(0.2); // 20 of 100
    expect(body.w).toBeCloseTo(0.3); // 60 of 200
    expect(body.h).toBeCloseTo(0.4); // 40 of 100
  });

  it('can place a pin in the middle without a pointer, and cancel it', async () => {
    await open({ marks: [] });
    const v = await viewer();
    await userEvent.click(v.getByRole('button', { name: 'Add a pin' }));
    await userEvent.click(v.getByRole('button', { name: 'Place a pin in the middle' }));
    expect(await v.findByLabelText('What is this mark?')).toBeInTheDocument();
    await userEvent.click(v.getByRole('button', { name: 'Cancel' }));
    expect(v.queryByLabelText('What is this mark?')).not.toBeInTheDocument();
    expect(calls('POST', '/documents/1/annotations')).toHaveLength(0);
  });

  it('renames and deletes a mark that is the person’s own, and offers nothing on another’s', async () => {
    await open({ marks: [mark(), mark({ id: 52, label: 'Not mine', canChange: false })] });
    api.routes['PATCH /documents/1/annotations/51'] = () => json(200, { annotation: mark({ label: 'Renamed' }) });
    api.routes['DELETE /documents/1/annotations/51'] = () => empty();
    const v = await viewer();
    await v.findByText('Not mine');
    expect(v.getAllByRole('button', { name: /^Edit mark/ })).toHaveLength(1);
    await userEvent.click(v.getByRole('button', { name: 'Edit mark 1' }));
    const box = v.getByRole('textbox', { name: 'What is this mark?' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Renamed{Enter}');
    await waitFor(() => expect(calls('PATCH', '/documents/1/annotations/51')[0]!.body).toEqual({ label: 'Renamed' }));
    await userEvent.click(v.getByRole('button', { name: 'Delete mark 1' }));
    await waitFor(() => expect(calls('DELETE', '/documents/1/annotations/51')).toHaveLength(1));
  });

  it('picks a mark on the picture and in the list together', async () => {
    await open();
    const v = await viewer();
    const onPicture = await v.findByRole('button', { name: 'Mark 1: Caries under the filling' });
    expect(onPicture).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(within(v.getByRole('region', { name: 'Marks on the picture' })).getByText('Caries under the filling'));
    expect(onPicture).toHaveAttribute('aria-pressed', 'true');
  });
});
