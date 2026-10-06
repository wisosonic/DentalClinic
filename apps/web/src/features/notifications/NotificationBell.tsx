import { useEffect, useState } from 'react';
import { Badge, Box, Button, Divider, IconButton, List, ListItemButton, ListItemText, Popover, Tooltip, Typography } from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { useTranslation } from 'react-i18next';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import type { NotificationDto } from '@aya/shared';
import { dateLocale } from '../../i18n';
import { api } from '../auth/authApi';
import { useMarkAllNotificationsReadMutation, useMarkNotificationReadMutation, useNotificationsQuery } from './notificationsApi';

/** How long ago, in the chosen language ("5 minutes ago"); a date once it is more than a week old. */
export function timeAgo(utc: string | null | undefined, now = Date.now()): string {
  if (!utc) return '';
  const then = Date.parse(`${utc.replace(' ', 'T')}Z`); // stored in UTC
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' });
  if (abs < 60) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86400) return rtf.format(Math.round(seconds / 86400), 'day');
  return new Intl.DateTimeFormat(dateLocale(), { dateStyle: 'medium', timeZone: 'UTC' }).format(then);
}

/**
 * Live delivery: a Server-Sent Events stream tells the page the moment something is created. If the stream
 * cannot be opened (or drops), the list is simply asked again every minute (`pollingInterval` below).
 */
function useNotificationStream(onNew: (n: NotificationDto) => void) {
  const dispatch = useDispatch();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined; // old browsers and tests: polling covers it
    const source = new EventSource('/api/v1/notifications/stream');
    source.addEventListener('notification', (e) => {
      try {
        onNew(JSON.parse((e as MessageEvent<string>).data) as NotificationDto);
      } catch {
        // a malformed event is ignored; the next poll catches up
      }
      dispatch(api.util.invalidateTags(['Notification']));
    });
    return () => source.close(); // the browser reconnects by itself, sending Last-Event-ID, until the page closes it
  }, [dispatch, onNew]);
}

/** The bell in the header: unread count, the latest notifications, and a way to mark them read. */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useNotificationsQuery(undefined, { pollingInterval: 60_000 });
  const [markRead] = useMarkNotificationReadMutation();
  const [markAll, markAllState] = useMarkAllNotificationsReadMutation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [announce, setAnnounce] = useState('');
  const unread = data?.unread ?? 0;

  useNotificationStream((n) => setAnnounce(`${n.title}. ${n.content}`));

  const open = (n: NotificationDto) => {
    if (n.status === 'unread') void markRead(n.id);
    setAnchor(null);
    if (n.link) navigate(n.link);
  };

  return (
    <>
      <Tooltip title={t('Notifications')}>
        <IconButton aria-label={unread ? t('Notifications, {{n}} unread', { n: unread }) : t('Notifications')} aria-haspopup="dialog" onClick={(e) => setAnchor(e.currentTarget)}>
          <Badge badgeContent={unread} color="error" max={99}>
            <NotificationsIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      {/* a screen reader hears each new one as it arrives */}
      <Box aria-live="polite" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{announce}</Box>

      <Popover
        open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 'min(380px, 92vw)', maxHeight: '70vh', display: 'flex', flexDirection: 'column' }, role: 'dialog', 'aria-label': t('Notifications') } }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 1.25, gap: 1 }}>
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>{t('Notifications')}</Typography>
          <Button size="small" disabled={unread === 0 || markAllState.isLoading} onClick={() => markAll()}>{t('Mark all as read')}</Button>
        </Box>
        <Divider />
        {data && data.data.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>{t('No notifications yet.')}</Typography>
        ) : (
          <List disablePadding aria-label={t('Notifications')} sx={{ overflowY: 'auto' }}>
            {(data?.data ?? []).map((n) => (
              <ListItemButton
                key={n.id} onClick={() => open(n)} alignItems="flex-start" divider
                sx={{ minHeight: 44, gap: 1, bgcolor: n.status === 'unread' ? 'action.selected' : undefined }}
              >
                <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', mt: 0.9, flexShrink: 0, bgcolor: n.status === 'unread' ? 'primary.main' : 'transparent' }} />
                <ListItemText
                  primary={n.title} secondary={<>{n.content}<br />{timeAgo(n.createdAt)}</>}
                  slotProps={{ primary: { fontWeight: n.status === 'unread' ? 700 : 500 }, secondary: { component: 'span' } }}
                />
                {n.status === 'unread' && <Box component="span" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{t('Unread')}</Box>}
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </>
  );
}
