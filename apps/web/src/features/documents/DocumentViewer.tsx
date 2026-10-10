import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { useTranslation } from 'react-i18next';
import {
  ANNOTATION_LABEL_MAX_LENGTH, COMMENT_MAX_LENGTH, MAX_TAGS_PER_DOCUMENT, MIN_BOX_SIZE, TAG_MAX_LENGTH, tagKey,
  type DocumentAnnotationDto, type DocumentCommentDto, type PatientDocumentDto,
} from '@aya/shared';
import { errorMessage } from '../../lib/baseQuery';
import { formatDateTime } from '../../lib/format';
import { useGetMeQuery } from '../auth/authApi';
import {
  useAddAnnotationMutation, useAddCommentMutation, useDeleteAnnotationMutation, useDeleteCommentMutation, useListAnnotationsQuery, useListCommentsQuery,
  useSetDocumentTagsMutation, useUpdateAnnotationMutation, useUpdateCommentMutation,
} from './documentsApi';
import { DOCUMENT_CATEGORY_LABEL } from './labels';

const fileUrl = (d: PatientDocumentDto) => `/api/v1/documents/${d.id}/file`;
const thumbUrl = (d: PatientDocumentDto) => `/api/v1/documents/${d.id}/thumbnail`;

type Mode = 'view' | 'pin' | 'box';
interface Draft { kind: 'pin' | 'box'; x: number; y: number; w?: number; h?: number }

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/** A mark's number badge: round, high contrast on any picture (an x-ray is dark, a photo is not). */
const badgeSx = {
  width: 22, height: 22, borderRadius: '50%', bgcolor: 'warning.main', color: 'common.black', border: '2px solid', borderColor: 'common.white', boxShadow: 2,
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, lineHeight: 1, p: 0, minWidth: 0,
} as const;

/** Whether the person may write notes (comments, tags, marks): the server decides, this only hides what would be refused. */
function useCanNote(): boolean {
  const permissions = useGetMeQuery().data?.permissions;
  return !permissions || permissions.includes('documents:update');
}

/**
 * The picture with the clinic's marks on it. A mark is stored as fractions of the picture, so it sits in the same place at
 * any size. To add one: choose Pin or Box, then click (pin) or drag (box) on the picture, and write what it is. The
 * original picture is never changed: marks are drawn over it.
 */
function Stage({ doc, marks, mode, draft, drag, selected, onSelect, onDraft, onDrag }: {
  doc: PatientDocumentDto; marks: DocumentAnnotationDto[]; mode: Mode; draft: Draft | null; drag: Draft | null; selected: number | null;
  onSelect: (id: number | null) => void; onDraft: (d: Draft | null) => void; onDrag: (d: Draft | null) => void;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const point = (e: ReactPointerEvent): { x: number; y: number } => {
    const r = frame.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / (r.width || 1)), y: clamp((e.clientY - r.top) / (r.height || 1)) };
  };
  const down = (e: ReactPointerEvent) => {
    const p = point(e);
    start.current = p;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onDrag(mode === 'box' ? { kind: 'box', x: p.x, y: p.y, w: 0, h: 0 } : null);
  };
  const move = (e: ReactPointerEvent) => {
    if (mode !== 'box' || !start.current) return;
    const p = point(e);
    const s = start.current;
    onDrag({ kind: 'box', x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const up = (e: ReactPointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const p = point(e);
    if (mode === 'pin') onDraft({ kind: 'pin', x: p.x, y: p.y });
    else if (mode === 'box') {
      const w = Math.abs(p.x - s.x);
      const h = Math.abs(p.y - s.y);
      onDraft(w >= MIN_BOX_SIZE && h >= MIN_BOX_SIZE ? { kind: 'box', x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w, h } : null); // a tap is not a box
    }
    onDrag(null);
  };

  const shape = (m: { kind: 'pin' | 'box'; x: number; y: number; w?: number | null; h?: number | null }, props: { dashed?: boolean; number?: number; active?: boolean }) =>
    m.kind === 'pin' ? (
      <Box
        aria-hidden sx={{ ...badgeSx, position: 'absolute', left: pct(m.x), top: pct(m.y), transform: 'translate(-50%, -50%)', outline: props.active ? '3px solid' : 'none', outlineColor: 'primary.main', borderStyle: props.dashed ? 'dashed' : 'solid', pointerEvents: 'none' }}
      >{props.number ?? ''}</Box>
    ) : (
      <Box
        aria-hidden
        sx={{ position: 'absolute', left: pct(m.x), top: pct(m.y), width: pct(m.w ?? 0), height: pct(m.h ?? 0), border: '2px', borderStyle: props.dashed ? 'dashed' : 'solid', borderColor: 'warning.main', boxShadow: (theme) => (props.active ? `0 0 0 3px ${theme.palette.primary.main}` : '0 0 0 1px rgba(0,0,0,0.6)'), pointerEvents: 'none' }}
      >
        {props.number !== undefined && <Box sx={{ ...badgeSx, position: 'absolute', top: -11, insetInlineStart: -11 }}>{props.number}</Box>}
      </Box>
    );

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <Box ref={frame} sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%', lineHeight: 0 }} dir="ltr">
        <Box component="img" src={fileUrl(doc)} alt={doc.title} draggable={false} sx={{ display: 'block', maxWidth: '100%', maxHeight: '58vh', userSelect: 'none' }} />
        {marks.map((m, i) => shape(m, { number: i + 1, active: m.id === selected }))}
        {draft && shape(draft, { dashed: true, number: marks.length + 1, active: true })}
        {drag && shape(drag, { dashed: true })}
        {/* In view mode a mark can be picked; in the drawing modes this layer takes the pointer instead */}
        {mode === 'view' ? marks.map((m, i) => (
          <Box
            key={m.id} component="button" type="button" onClick={() => onSelect(m.id === selected ? null : m.id)} aria-label={t('Mark {{n}}: {{label}}', { n: i + 1, label: m.label })} aria-pressed={m.id === selected}
            sx={m.kind === 'pin'
              ? { position: 'absolute', left: pct(m.x), top: pct(m.y), width: 28, height: 28, transform: 'translate(-50%, -50%)', borderRadius: '50%', border: 0, bgcolor: 'transparent', cursor: 'pointer', p: 0 }
              : { position: 'absolute', left: pct(m.x), top: pct(m.y), width: pct(m.w ?? 0), height: pct(m.h ?? 0), border: 0, bgcolor: 'transparent', cursor: 'pointer', p: 0 }}
          />
        )) : (
          <Box
            data-testid="mark-surface" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { start.current = null; onDrag(null); }}
            sx={{ position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none', zIndex: 2 }}
          />
        )}
      </Box>
    </Box>
  );
}

/** Tags of a picture: short labels such as "tooth 36" or "follow-up", added and removed here. */
function Tags({ doc, canNote }: { doc: PatientDocumentDto; canNote: boolean }) {
  const { t } = useTranslation();
  const [save, state] = useSetDocumentTagsMutation();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  const set = (tags: string[]) => save({ id: doc.id, tags });
  const add = async () => {
    const tag = text.trim().replace(/\s+/g, ' ');
    if (!tag) return;
    if (doc.tags.some((x) => tagKey(x) === tagKey(tag))) return setProblem(t('This tag is already there'));
    if (doc.tags.length >= MAX_TAGS_PER_DOCUMENT) return setProblem(t('At most {{n}} tags', { n: MAX_TAGS_PER_DOCUMENT }));
    setProblem('');
    const r = await set([...doc.tags, tag]);
    if (!('error' in r && r.error)) setText('');
  };
  return (
    <Box component="section" aria-label={t('Tags')}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('Tags')}</Typography>
      {state.error != null && <Alert severity="error" role="alert" sx={{ mb: 1 }}>{errorMessage(state.error)}</Alert>}
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: canNote ? 1 : 0 }}>
        {doc.tags.length === 0 && <Typography variant="body2" color="text.secondary">{t('No tags yet.')}</Typography>}
        {doc.tags.map((tag) => (
          <Chip key={tag} size="small" label={tag} {...(canNote ? { onDelete: () => set(doc.tags.filter((x) => x !== tag)), deleteIcon: <CloseIcon aria-label={t('Remove the tag {{tag}}', { tag })} /> } : {})} />
        ))}
      </Box>
      {canNote && (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small" label={t('Add a tag')} value={text} margin="none" error={!!problem} helperText={problem || undefined} sx={{ flexGrow: 1 }}
            onChange={(e) => { setText(e.target.value); setProblem(''); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
            slotProps={{ htmlInput: { maxLength: TAG_MAX_LENGTH } }}
          />
          <Button onClick={add} disabled={!text.trim() || state.isLoading}>{t('Add')}</Button>
        </Box>
      )}
    </Box>
  );
}

/** The marks on the picture, listed (the list is the text version of the drawing), with their words editable by their author. */
function Marks({ doc, marks, mode, onMode, draft, onDraft, selected, onSelect, canNote }: {
  doc: PatientDocumentDto; marks: DocumentAnnotationDto[]; mode: Mode; onMode: (m: Mode) => void; draft: Draft | null; onDraft: (d: Draft | null) => void;
  selected: number | null; onSelect: (id: number | null) => void; canNote: boolean;
}) {
  const { t } = useTranslation();
  const [add, addState] = useAddAnnotationMutation();
  const [update, updateState] = useUpdateAnnotationMutation();
  const [remove, removeState] = useDeleteAnnotationMutation();
  const [label, setLabel] = useState('');
  const [editing, setEditing] = useState<{ id: number; label: string } | null>(null);

  const save = async () => {
    if (!draft || !label.trim()) return;
    const r = await add({ id: doc.id, body: { kind: draft.kind, x: draft.x, y: draft.y, ...(draft.kind === 'box' ? { w: draft.w, h: draft.h } : {}), label: label.trim() } });
    if (!('error' in r && r.error)) { setLabel(''); onDraft(null); }
  };
  const error = addState.error ?? updateState.error ?? removeState.error;

  return (
    <Box component="section" aria-label={t('Marks on the picture')}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('Marks on the picture')}</Typography>
      {canNote && (
        <>
          <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, v: Mode | null) => { if (v) { onMode(v); onDraft(null); } }} aria-label={t('Drawing tool')} sx={{ mb: 1, flexWrap: 'wrap' }}>
            <ToggleButton value="view">{t('Look')}</ToggleButton>
            <ToggleButton value="pin">{t('Add a pin')}</ToggleButton>
            <ToggleButton value="box">{t('Draw a box')}</ToggleButton>
          </ToggleButtonGroup>
          {mode === 'pin' && !draft && (
            <Box sx={{ mb: 1 }}>
              <Typography variant="caption" color="text.secondary" display="block">{t('Click the picture where the mark goes.')}</Typography>
              <Button size="small" onClick={() => onDraft({ kind: 'pin', x: 0.5, y: 0.5 })}>{t('Place a pin in the middle')}</Button>
            </Box>
          )}
          {mode === 'box' && !draft && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t('Drag on the picture to draw a box.')}</Typography>}
        </>
      )}
      {error != null && <Alert severity="error" role="alert" sx={{ mb: 1 }}>{errorMessage(error)}</Alert>}
      {draft && (
        <Paper variant="outlined" sx={{ p: 1.25, mb: 1 }}>
          <TextField
            autoFocus fullWidth size="small" margin="none" label={t('What is this mark?')} value={label} onChange={(e) => setLabel(e.target.value)} slotProps={{ htmlInput: { maxLength: ANNOTATION_LABEL_MAX_LENGTH } }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
          />
          <Box sx={{ display: 'flex', gap: 1, mt: 1, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={() => { onDraft(null); setLabel(''); }} disabled={addState.isLoading}>{t('Cancel')}</Button>
            <Button size="small" variant="contained" onClick={save} disabled={!label.trim() || addState.isLoading}>{t('Save the mark')}</Button>
          </Box>
        </Paper>
      )}
      {marks.length === 0 && !draft && <Typography variant="body2" color="text.secondary">{t('No marks yet.')}</Typography>}
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0.75 }}>
        {marks.map((m, i) => (
          <Box
            component="li" key={m.id} onClick={() => onSelect(m.id === selected ? null : m.id)}
            sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, p: 0.75, borderRadius: 1, cursor: 'pointer', bgcolor: m.id === selected ? 'action.selected' : 'transparent', '&:hover': { bgcolor: 'action.hover' } }}
          >
            <Box aria-hidden sx={{ ...badgeSx, flexShrink: 0 }}>{i + 1}</Box>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              {editing?.id === m.id ? (
                <TextField
                  autoFocus fullWidth size="small" margin="none" value={editing.label} onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditing({ id: m.id, label: e.target.value })} slotProps={{ htmlInput: { maxLength: ANNOTATION_LABEL_MAX_LENGTH, 'aria-label': t('What is this mark?') } }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void update({ id: doc.id, markId: m.id, body: { label: editing.label.trim() } }).then((r) => { if (!('error' in r && r.error)) setEditing(null); }); } if (e.key === 'Escape') setEditing(null); }}
                />
              ) : (
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{m.label}</Typography>
              )}
              <Typography variant="caption" color="text.secondary">{m.kind === 'pin' ? t('Pin') : t('Box')}{m.author?.name ? ` · ${m.author.name}` : ''}</Typography>
            </Box>
            {m.canChange && canNote && (
              <Box sx={{ display: 'flex', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                {editing?.id === m.id ? (
                  <Tooltip title={t('Save')}>
                    <IconButton size="small" aria-label={t('Save mark {{n}}', { n: i + 1 })} disabled={!editing.label.trim() || updateState.isLoading}
                      onClick={async () => { const r = await update({ id: doc.id, markId: m.id, body: { label: editing.label.trim() } }); if (!('error' in r && r.error)) setEditing(null); }}><CheckIcon fontSize="small" /></IconButton>
                  </Tooltip>
                ) : (
                  <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit mark {{n}}', { n: i + 1 })} onClick={() => setEditing({ id: m.id, label: m.label })}><EditIcon fontSize="small" /></IconButton></Tooltip>
                )}
                <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete mark {{n}}', { n: i + 1 })} disabled={removeState.isLoading} onClick={() => { if (selected === m.id) onSelect(null); void remove({ id: doc.id, markId: m.id }); }}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** The comments on a document, oldest first, for the people at the clinic to leave each other context. */
function Comments({ doc, canNote }: { doc: PatientDocumentDto; canNote: boolean }) {
  const { t } = useTranslation();
  const { data: comments = [], error: loadError } = useListCommentsQuery(doc.id);
  const [add, addState] = useAddCommentMutation();
  const [update, updateState] = useUpdateCommentMutation();
  const [remove, removeState] = useDeleteCommentMutation();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const error = loadError ?? addState.error ?? updateState.error ?? removeState.error;

  const post = async () => {
    if (!text.trim()) return;
    const r = await add({ id: doc.id, body: { body: text.trim() } });
    if (!('error' in r && r.error)) setText('');
  };
  const edit = (c: DocumentCommentDto) => (
    editing?.id === c.id ? (
      <Box sx={{ mt: 0.5 }}>
        <TextField fullWidth multiline minRows={2} size="small" margin="none" value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} slotProps={{ htmlInput: { maxLength: COMMENT_MAX_LENGTH, 'aria-label': t('Edit the comment') } }} />
        <Box sx={{ display: 'flex', gap: 1, mt: 0.75, justifyContent: 'flex-end' }}>
          <Button size="small" onClick={() => setEditing(null)}>{t('Cancel')}</Button>
          <Button size="small" variant="contained" disabled={!editing.body.trim() || updateState.isLoading}
            onClick={async () => { const r = await update({ id: doc.id, commentId: c.id, body: { body: editing.body.trim() } }); if (!('error' in r && r.error)) setEditing(null); }}>{t('Save changes')}</Button>
        </Box>
      </Box>
    ) : <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.body}</Typography>
  );

  return (
    <Box component="section" aria-label={t('Comments')}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('Comments')}</Typography>
      {error != null && <Alert severity="error" role="alert" sx={{ mb: 1 }}>{errorMessage(error)}</Alert>}
      {comments.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('No comments yet.')}</Typography>}
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 1, mb: 1 }}>
        {comments.map((c) => (
          <Paper component="li" key={c.id} variant="outlined" sx={{ p: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                {c.author?.name || t('Someone')} · {c.createdAt ? formatDateTime(c.createdAt) : ''}{c.edited ? ` · ${t('edited')}` : ''}
              </Typography>
              {c.canEdit && editing?.id !== c.id && <Tooltip title={t('Edit')}><IconButton size="small" aria-label={t('Edit the comment')} onClick={() => setEditing({ id: c.id, body: c.body })}><EditIcon fontSize="small" /></IconButton></Tooltip>}
              {c.canDelete && <Tooltip title={t('Delete')}><IconButton size="small" aria-label={t('Delete the comment')} disabled={removeState.isLoading} onClick={() => remove({ id: doc.id, commentId: c.id })}><DeleteOutlineIcon fontSize="small" /></IconButton></Tooltip>}
            </Box>
            {edit(c)}
          </Paper>
        ))}
      </Box>
      {canNote && (
        <>
          <TextField fullWidth multiline minRows={2} size="small" margin="none" label={t('Write a comment')} value={text} onChange={(e) => setText(e.target.value)} slotProps={{ htmlInput: { maxLength: COMMENT_MAX_LENGTH } }} />
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.75 }}>
            <Button variant="contained" size="small" onClick={post} disabled={!text.trim() || addState.isLoading}>{addState.isLoading ? t('Saving…') : t('Add comment')}</Button>
          </Box>
        </>
      )}
    </Box>
  );
}

/**
 * A document, larger, with what the clinic has noted about it: tags, marks drawn on the picture and comments. Opens a
 * picture or a PDF (a PDF has comments only; it opens in the browser's own viewer). Previous and next walk through the
 * list, and a strip of small previews shows where you are. Everything here is for the clinic: patients never see it.
 */
export function DocumentViewerDialog({ docs, index, onClose, onMove }: { docs: PatientDocumentDto[]; index: number; onClose: () => void; onMove: (index: number) => void }) {
  const { t } = useTranslation();
  const doc = docs[index]!;
  const canNote = useCanNote();
  const { data: marks = [] } = useListAnnotationsQuery(doc.id, { skip: !doc.isImage });
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => { setMode('view'); setDraft(null); setDrag(null); setSelected(null); }, [doc.id]);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xl">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>{doc.title}</Box>
        <Chip size="small" label={t(DOCUMENT_CATEGORY_LABEL[doc.category])} />
      </DialogTitle>
      <DialogContent dividers sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 340px' }, gap: 2.5, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
          {doc.isImage ? (
            <Stage doc={doc} marks={marks} mode={canNote ? mode : 'view'} draft={draft} drag={drag} selected={selected} onSelect={setSelected} onDraft={setDraft} onDrag={setDrag} />
          ) : (
            <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
              <PictureAsPdfIcon color="action" sx={{ fontSize: 48 }} />
              <Typography sx={{ my: 1 }}>{t('This is a PDF. It opens in your browser’s own viewer.')}</Typography>
              <Button variant="contained" component="a" href={fileUrl(doc)} target="_blank" rel="noopener" startIcon={<OpenInNewIcon />}>{t('Open the PDF')}</Button>
            </Paper>
          )}
          {doc.note && <Typography variant="body2" sx={{ mt: 1.5, whiteSpace: 'pre-wrap' }}>{doc.note}</Typography>}
          {docs.length > 1 && (
            <Box component="nav" aria-label={t('Documents')} sx={{ display: 'flex', gap: 0.75, mt: 2, overflowX: 'auto', pb: 0.5 }}>
              {docs.map((d, i) => (
                <Box
                  key={d.id} component="button" type="button" onClick={() => onMove(i)} aria-label={t('Show {{title}}', { title: d.title })} aria-current={i === index ? 'true' : undefined}
                  sx={{ width: 52, height: 52, flexShrink: 0, p: 0, borderRadius: 1, overflow: 'hidden', cursor: 'pointer', bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid', borderColor: i === index ? 'primary.main' : 'transparent' }}
                >
                  {d.isImage ? <Box component="img" src={thumbUrl(d)} alt="" loading="lazy" sx={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <PictureAsPdfIcon color="action" />}
                </Box>
              ))}
            </Box>
          )}
        </Box>
        <Box sx={{ display: 'grid', gap: 2.5, minWidth: 0 }}>
          {doc.isImage && <Tags doc={doc} canNote={canNote} />}
          {doc.isImage && <Marks doc={doc} marks={marks} mode={mode} onMode={setMode} draft={draft} onDraft={setDraft} selected={selected} onSelect={setSelected} canNote={canNote} />}
          <Comments doc={doc} canNote={canNote} />
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button disabled={index === 0} onClick={() => onMove(index - 1)}>{t('Previous')}</Button>
        <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>{index + 1} / {docs.length}</Typography>
        <Button disabled={index === docs.length - 1} onClick={() => onMove(index + 1)}>{t('Next')}</Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button component="a" href={fileUrl(doc)} target="_blank" rel="noopener" startIcon={<OpenInNewIcon />}>{t('Open in a new tab')}</Button>
        <Button onClick={onClose}>{t('Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
