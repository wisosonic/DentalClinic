import { useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, MenuItem, Paper,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyIcon from '@mui/icons-material/Key';
import LinkIcon from '@mui/icons-material/Link';
import SearchIcon from '@mui/icons-material/Search';
import { useTranslation } from 'react-i18next';
import { STAFF_ROLES, emailSchema, type PublicUser } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { formatDate } from '../../lib/format';
import { validate } from '../../lib/zodForm';
import { useGetMeQuery } from '../auth/authApi';
import {
  useCreateResetLinkMutation, useCreateUserMutation, useListUsersQuery, useResetUserPasswordMutation, useUpdateUserMutation,
} from '../clinical/clinicalApi';

/** Something an admin must pass on to a person in person or by phone: shown once, with a copy button. */
interface Handover { title: string; intro: string; secret: string; note: string }

function HandoverDialog({ handover, onClose }: { handover: Handover | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(handover!.secret);
      setCopied(true);
    } catch {
      // the text is selectable, so it can still be copied by hand
    }
  };
  return (
    <Dialog open={!!handover} onClose={onClose} fullWidth maxWidth="sm" TransitionProps={{ onExited: () => setCopied(false) }}>
      <DialogTitle>{handover?.title}</DialogTitle>
      <DialogContent>
        <Typography sx={{ mb: 2 }}>{handover?.intro}</Typography>
        <TextField
          value={handover?.secret ?? ''} margin="none" label={t('Copy and hand this over')}
          slotProps={{
            htmlInput: { readOnly: true, dir: 'ltr', onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.target.select() },
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title={copied ? t('Copied') : t('Copy')}>
                    <IconButton aria-label={t('Copy')} onClick={copy}><ContentCopyIcon /></IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            },
          }}
        />
        <Alert severity="warning" sx={{ mt: 2 }}>{handover?.note}</Alert>
      </DialogContent>
      <DialogActions><Button variant="contained" onClick={onClose}>{t('Done')}</Button></DialogActions>
    </Dialog>
  );
}

function CreateUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (h: Handover) => void }) {
  const { t } = useTranslation();
  const [create, { isLoading, error, reset }] = useCreateUserMutation();
  const [values, setValues] = useState({ name: '', email: '', role: 'staff' });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const close = () => { setValues({ name: '', email: '', role: 'staff' }); setErrors({}); reset(); onClose(); };
  const submit = async () => {
    const found: Record<string, string> = {};
    if (!values.name.trim()) found.name = t('Name is required');
    const email = validate(emailSchema, values.email.trim().toLowerCase());
    if (!email.data) found.email = t('Enter a valid email address');
    if (Object.keys(found).length) return setErrors(found);
    const result = await create({ name: values.name.trim(), email: email.data!, role: values.role });
    if ('data' in result && result.data) {
      const { user, temporaryPassword } = result.data;
      close();
      onCreated({
        title: t('Account created for {{name}}', { name: user.name }),
        intro: t('Give them this temporary password. They must choose their own the first time they sign in.'),
        secret: temporaryPassword ?? '',
        note: t('This is shown only once. If it is lost, make a new one from the list.'),
      });
    }
  };

  return (
    <Dialog open={open} onClose={isLoading ? undefined : close} fullWidth maxWidth="sm">
      <DialogTitle>{t('New account')}</DialogTitle>
      <DialogContent>
        {error != null && <Alert severity="error" sx={{ mb: 1 }} role="alert">{errorMessage(error)}</Alert>}
        <TextField
          label={t('Name')} value={values.name} autoFocus required error={!!errors.name} helperText={errors.name}
          onChange={(e) => { setValues((v) => ({ ...v, name: e.target.value })); setErrors((x) => ({ ...x, name: '' })); }}
        />
        <TextField
          label={t('Email')} type="email" value={values.email} required error={!!errors.email} helperText={errors.email}
          slotProps={{ htmlInput: { dir: 'ltr' } }}
          onChange={(e) => { setValues((v) => ({ ...v, email: e.target.value })); setErrors((x) => ({ ...x, email: '' })); }}
        />
        <TextField
          select label={t('Role')} value={values.role} onChange={(e) => setValues((v) => ({ ...v, role: e.target.value }))}
          helperText={values.role === 'doctor' ? t('After creating it, link this account to the doctor under Doctors > Edit.') : undefined}
        >
          {STAFF_ROLES.map((r) => <MenuItem key={r} value={r}>{t(r)}</MenuItem>)}
        </TextField>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={isLoading}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={submit} disabled={isLoading}>{isLoading ? t('Saving…') : t('Create account')}</Button>
      </DialogActions>
    </Dialog>
  );
}

type SortKey = 'name' | 'email' | 'role' | 'status' | 'lastLogin';

/** Admin only: the people who can sign in, and how to get someone back in without email. */
export function UsersPage() {
  const { t } = useTranslation();
  const { data: me } = useGetMeQuery();
  const { data, error } = useListUsersQuery();
  const [update, updateState] = useUpdateUserMutation();
  const [resetPassword, resetState] = useResetUserPasswordMutation();
  const [makeLink, linkState] = useCreateResetLinkMutation();
  const sort = useSort<SortKey>('name');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [handover, setHandover] = useState<Handover | null>(null);
  const [confirmPassword, setConfirmPassword] = useState<PublicUser | null>(null);
  const [confirmOff, setConfirmOff] = useState<PublicUser | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const found = (data?.data ?? []).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    const value = (u: PublicUser) =>
      ({ name: u.name, email: u.email, role: u.role, status: u.isActive ? 1 : 0, lastLogin: u.lastLoginAt })[sort.key];
    return sortRows(found, value, sort.order);
  }, [data, search, sort.key, sort.order]);

  const problem = error ?? updateState.error ?? resetState.error ?? linkState.error;

  const link = async (u: PublicUser) => {
    const r = await makeLink(u.id);
    if ('data' in r && r.data) {
      setHandover({
        title: t('Reset link for {{name}}', { name: u.name }),
        intro: t('Send this link to them. It lets them choose a new password.'),
        secret: r.data.link,
        note: t('It works once and expires in {{hours}} hours. Making a new link cancels this one.', { hours: r.data.expiresInHours }),
      });
    }
  };
  const temporary = async (u: PublicUser) => {
    setConfirmPassword(null);
    const r = await resetPassword(u.id);
    if ('data' in r && r.data) {
      setHandover({
        title: t('Temporary password for {{name}}', { name: u.name }),
        intro: t('Give them this password. They must choose their own the next time they sign in, and they are signed out everywhere now.'),
        secret: r.data.temporaryPassword,
        note: t('This is shown only once. If it is lost, make a new one.'),
      });
    }
  };

  return (
    <>
      <PageHeader
        title={t('Users')}
        subtitle={t('Who can sign in, and how to get someone back in. There is no email: hand links and passwords over in person or by phone.')}
        actions={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)}>{t('New account')}</Button>}
      />
      <TextField
        value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search users')} margin="none" sx={{ mb: 2, maxWidth: 420 }}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }, htmlInput: { 'aria-label': t('Search users') } }}
      />
      {problem != null && <Alert severity="error" sx={{ mb: 2 }}>{errorMessage(problem)}</Alert>}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <SortCell field="name" sort={sort}>{t('Name')}</SortCell>
              <SortCell field="email" sort={sort}>{t('Email')}</SortCell>
              <SortCell field="role" sort={sort}>{t('Role')}</SortCell>
              <SortCell field="status" sort={sort}>{t('Status')}</SortCell>
              <SortCell field="lastLogin" sort={sort}>{t('Last sign-in')}</SortCell>
              <TableCell align="right">{t('Actions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  {u.name}
                  {u.role === 'doctor' && !u.doctor && <Chip size="small" color="warning" label={t('Not linked to a doctor')} sx={{ marginInlineStart: 1 }} />}
                </TableCell>
                <TableCell><bdi dir="ltr">{u.email}</bdi></TableCell>
                <TableCell><Chip size="small" label={t(u.role)} sx={{ textTransform: 'capitalize' }} /></TableCell>
                <TableCell>
                  <Chip size="small" color={u.isActive ? 'success' : 'default'} variant={u.isActive ? 'filled' : 'outlined'} label={u.isActive ? t('Active') : t('Switched off')} />
                </TableCell>
                <TableCell>{u.lastLoginAt ? formatDate(u.lastLoginAt) : '—'}</TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  <Tooltip title={t('Reset link')}>
                    <span><IconButton aria-label={t('Reset link for {{name}}', { name: u.name })} disabled={!u.isActive || linkState.isLoading} onClick={() => link(u)}><LinkIcon /></IconButton></span>
                  </Tooltip>
                  <Tooltip title={t('Temporary password')}>
                    <span><IconButton aria-label={t('Temporary password for {{name}}', { name: u.name })} disabled={resetState.isLoading} onClick={() => setConfirmPassword(u)}><KeyIcon /></IconButton></span>
                  </Tooltip>
                  {u.id !== me?.id && (
                    <Button size="small" color={u.isActive ? 'error' : 'primary'} onClick={() => (u.isActive ? setConfirmOff(u) : update({ id: u.id, body: { isActive: true } }))}>
                      {u.isActive ? t('Switch off') : t('Switch on')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ mt: 1 }}><Typography variant="caption" color="text.secondary">{rows.length === 1 ? t('1 account') : t('{{n}} accounts', { n: rows.length })}</Typography></Box>

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} onCreated={setHandover} />
      <HandoverDialog handover={handover} onClose={() => setHandover(null)} />
      <ConfirmDialog
        open={!!confirmPassword} destructive title={t('Make a temporary password for {{name}}?', { name: confirmPassword?.name ?? '' })}
        message={t('Their current password stops working and they are signed out everywhere.')}
        confirmLabel={t('Make password')} busy={resetState.isLoading} onClose={() => setConfirmPassword(null)}
        onConfirm={() => temporary(confirmPassword!)}
      />
      <ConfirmDialog
        open={!!confirmOff} destructive title={t('Switch off {{name}}?', { name: confirmOff?.name ?? '' })}
        message={t('They are signed out and can no longer sign in. Their records are kept, and you can switch them on again.')}
        confirmLabel={t('Switch off')} busy={updateState.isLoading} onClose={() => setConfirmOff(null)}
        onConfirm={async () => { await update({ id: confirmOff!.id, body: { isActive: false } }); setConfirmOff(null); }}
      />
    </>
  );
}
