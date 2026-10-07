import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Paper, Tab, Tabs, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { RoleDto } from '@aya/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { SortCell, sortRows, useSort } from '../../components/SortHead';
import { errorMessage } from '../../lib/baseQuery';
import { useGetRolesQuery, useResetRoleMutation, useSaveRoleMutation } from './rolesApi';

const ACTIONS = ['read', 'create', 'update', 'delete'] as const;
type Action = (typeof ACTIONS)[number];
const ACTION_LABEL: Record<Action, string> = { read: 'View', create: 'Add', update: 'Change', delete: 'Delete' };

/** The areas of the app, in plain words. An area the server lists that is not here shows under its own name. */
const AREA_LABEL: Record<string, string> = {
  waiting: 'Waiting room',
  patients: 'Patients', appointments: 'Appointments', visits: 'Visit reports', teeth: 'Teeth', categories: 'Procedures',
  medications: 'Medications', documents: 'Documents', offers: 'Treatment offers', labs: 'Labs', suppliers: 'Suppliers', payments: 'Payments',
  expenses: 'Expenses', doctors: 'Doctors', clinics: 'Clinics', events: 'Events', promotions: 'Promotions', notifications: 'Notifications', reports: 'Reports',
};

type SortKey = 'area' | Action;

/** Admin only: what each kind of account may do. Doctor and staff can be changed; admin and patient are shown as they are. */
export function RolesPage() {
  const { t } = useTranslation();
  const { data, error } = useGetRolesQuery();
  const [save, saveState] = useSaveRoleMutation();
  const [reset, resetState] = useResetRoleMutation();
  const [selected, setSelected] = useState<RoleDto['role']>('doctor');
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [confirmReset, setConfirmReset] = useState(false);
  const sort = useSort<SortKey>('area');

  const role = data?.roles.find((r) => r.role === selected);
  // Start again from what the server says whenever the role, or what was saved, changes.
  const saved = role ? role.permissions.join(',') : '';
  useEffect(() => { setDraft(new Set(saved ? saved.split(',') : [])); }, [selected, saved]);

  const switchable = useMemo(() => new Set(data?.switchable ?? []), [data]);
  const revokeOnly = useMemo(() => new Set(data?.revokeOnly ?? []), [data]);
  const areas = useMemo(() => [...new Set((data?.switchable ?? []).map((p) => p.split(':')[0]!))], [data]);
  const label = (area: string) => t(AREA_LABEL[area] ?? area);

  const rows = sortRows(areas, (area) => (sort.key === 'area' ? label(area) : draft.has(`${area}:${sort.key}`) ? 1 : 0), sort.order);

  const defaults = useMemo(() => new Set(role?.defaults ?? []), [role]);
  const dirty = !!role && (draft.size !== role.permissions.length || role.permissions.some((p) => !draft.has(p)));
  const changed = [...switchable].filter((p) => draft.has(p) !== defaults.has(p)).length;
  const atDefaults = !!role && role.permissions.join() === [...role.defaults].sort().join();
  const problem = error ?? saveState.error ?? resetState.error;

  const toggle = (permission: string) => setDraft((d) => {
    const next = new Set(d);
    const area = permission.split(':')[0]!;
    if (next.has(permission)) {
      next.delete(permission);
      if (permission.endsWith(':read')) for (const a of ACTIONS) next.delete(`${area}:${a}`); // nothing to change if it cannot be seen
    } else {
      next.add(permission);
      if (!permission.endsWith(':read') && switchable.has(`${area}:read`)) next.add(`${area}:read`);
    }
    return next;
  });

  const submit = async () => { if (role) await save({ role: role.role, permissions: [...draft].sort() }); };
  const doReset = async () => { if (role) { setConfirmReset(false); await reset(role.role); } };

  return (
    <>
      <PageHeader
        title={t('Roles')}
        subtitle={t('What each kind of account may do. A change applies at once to everyone with that role.')}
      />
      {problem != null && <Alert severity="error" sx={{ mb: 2 }} role="alert">{errorMessage(problem)}</Alert>}

      {data && (
        <>
          <Paper sx={{ mb: 2 }}>
            <Tabs value={selected} onChange={(_e, v) => setSelected(v)} variant="scrollable" scrollButtons="auto" aria-label={t('Roles')}>
              {data.roles.map((r) => (
                <Tab
                  key={r.role} value={r.role}
                  label={<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>{t(r.role)}<Chip size="small" label={r.users === 1 ? t('1 account') : t('{{n}} accounts', { n: r.users })} /></Box>}
                />
              ))}
            </Tabs>
          </Paper>

          {role && !role.editable && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {role.role === 'admin' ? t('The admin role always keeps every permission.') : t('A patient only ever sees their own records. That is not changed here.')}
            </Alert>
          )}

          <TableContainer component={Paper}>
            <Table aria-label={t('Permissions of {{role}}', { role: t(selected) })}>
              <TableHead>
                <TableRow>
                  <SortCell field="area" sort={sort}>{t('Area')}</SortCell>
                  {ACTIONS.map((a) => <SortCell key={a} field={a} sort={sort} align="center">{t(ACTION_LABEL[a])}</SortCell>)}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((area) => (
                  <TableRow key={area} hover>
                    <TableCell component="th" scope="row">{label(area)}</TableCell>
                    {ACTIONS.map((a) => {
                      const p = `${area}:${a}`;
                      if (!switchable.has(p)) return <TableCell key={a} align="center">—</TableCell>;
                      const on = draft.has(p);
                      const stuck = revokeOnly.has(p) && !defaults.has(p); // money cannot be given where the role lacks it
                      const differs = on !== defaults.has(p);
                      return (
                        <TableCell key={a} align="center" sx={differs ? { bgcolor: 'action.hover' } : undefined}>
                          <Tooltip title={stuck ? t('This can be taken away but not given') : differs ? t('Changed from the built-in setting') : ''}>
                            <span>
                              <Checkbox
                                checked={on} disabled={!role?.editable || stuck} onChange={() => toggle(p)}
                                inputProps={{ 'aria-label': t('{{action}} {{area}}', { action: t(ACTION_LABEL[a]), area: label(area) }) }}
                              />
                            </span>
                          </Tooltip>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            {t('Users, Settings, Trash, the Activity log and Roles are always for administrators only.')}{' '}
            {t('Money and supplier access can be taken away but not given: who sees which record (for example a doctor’s own patients) is decided by the record itself.')}
          </Typography>

          {role?.editable && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mt: 2.5, alignItems: 'center' }}>
              <Button variant="contained" onClick={submit} disabled={!dirty || saveState.isLoading}>{saveState.isLoading ? t('Saving…') : t('Save changes')}</Button>
              <Button onClick={() => setDraft(new Set(role.permissions))} disabled={!dirty || saveState.isLoading}>{t('Discard changes')}</Button>
              <Button color="warning" onClick={() => setConfirmReset(true)} disabled={saveState.isLoading || atDefaults}>{t('Back to the built-in permissions')}</Button>
              {changed > 0 && <Chip size="small" color="warning" label={changed === 1 ? t('1 change from the built-in setting') : t('{{n}} changes from the built-in setting', { n: changed })} />}
            </Box>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmReset} title={t('Put {{role}} back to the built-in permissions?', { role: t(selected) })}
        message={t('Every change made to this role is undone, for everyone who has it.')}
        confirmLabel={t('Put back')} busy={resetState.isLoading} onClose={() => setConfirmReset(false)} onConfirm={doReset}
      />
    </>
  );
}
