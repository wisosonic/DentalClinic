import { useEffect, useRef, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { BRAND } from '../../theme';
import { useGetWaitingDisplayQuery } from './waitingApi';

/** Two short tones. The browser only allows sound after the page was clicked once, which is what the sound button is for. */
function chime(audio: AudioContext): void {
  const now = audio.currentTime;
  const gain = audio.createGain();
  gain.connect(audio.destination);
  gain.gain.setValueAtTime(0.25, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
  for (const [freq, at] of [[880, 0], [660, 0.3]] as const) {
    const osc = audio.createOscillator();
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(now + at);
    osc.stop(now + at + 0.4);
  }
}

/**
 * The screen in the waiting room (no sign-in: the secret is in its address). It shows the numbers being called now and the
 * dental unit to go to, the newest call large, and how many are still waiting. It never shows a name, and it reads the
 * server every few seconds by itself.
 */
export function WaitingDisplayPage() {
  const { t } = useTranslation();
  const key = useSearchParams()[0].get('key') ?? '';
  const { data, error } = useGetWaitingDisplayQuery(key, { skip: !key, pollingInterval: 3000, skipPollingIfUnfocused: false });
  const [sound, setSound] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => { document.title = t('Waiting room'); }, [t]);

  // A call the screen has not shown before is announced with a chime (not the ones already there when the page opened).
  useEffect(() => {
    if (!data) return;
    const signatures = data.calls.map((c) => `${c.number}|${c.unit}|${c.callCount}|${c.calledAt}`);
    if (seen.current && sound && audio.current && signatures.some((s) => !seen.current!.has(s))) chime(audio.current);
    seen.current = new Set(signatures);
  }, [data, sound]);

  const toggleSound = () => {
    if (!sound && typeof AudioContext !== 'undefined') {
      audio.current ??= new AudioContext();
      void audio.current.resume();
      chime(audio.current); // so whoever turns it on hears that it works
    }
    setSound((on) => !on);
  };

  const invalid = !key || (error as { status?: number } | undefined)?.status === 404;
  const [first, ...others] = data?.calls ?? [];

  return (
    <Box
      component="main"
      sx={{ minHeight: '100dvh', color: '#fff', background: BRAND.gradient, display: 'flex', flexDirection: 'column', p: { xs: 2, md: 5 }, gap: 3 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography component="h1" sx={{ flexGrow: 1, fontWeight: 800, fontSize: { xs: '1.5rem', md: '2.4rem' } }}>{data?.clinic ?? t('Waiting room')}</Typography>
        {typeof AudioContext !== 'undefined' && (
          <Button onClick={toggleSound} aria-pressed={sound} startIcon={sound ? <VolumeUpIcon /> : <VolumeOffIcon />} sx={{ color: '#fff', borderColor: 'rgba(255,255,255,0.6)' }} variant="outlined">
            {sound ? t('Sound on') : t('Turn the sound on')}
          </Button>
        )}
      </Box>

      {invalid ? (
        <Box sx={{ m: 'auto', textAlign: 'center', maxWidth: 640 }} role="alert">
          <Typography sx={{ fontSize: { xs: '1.5rem', md: '2.2rem' }, fontWeight: 700 }}>{t('This screen’s address is not valid.')}</Typography>
          <Typography sx={{ mt: 1, opacity: 0.85 }}>{t('Ask the clinic for the right address: an administrator finds it in Settings, under Waiting room.')}</Typography>
        </Box>
      ) : !data ? (
        <Typography sx={{ m: 'auto', fontSize: '1.5rem' }} role="status">{t('Loading')}…</Typography>
      ) : !first ? (
        <Box sx={{ m: 'auto', textAlign: 'center' }}>
          <Typography sx={{ fontSize: { xs: '2rem', md: '4rem' }, fontWeight: 800 }}>{t('Please wait for your number to be called.')}</Typography>
        </Box>
      ) : (
        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Box aria-live="polite" sx={{ flexGrow: 1, display: 'grid', placeItems: 'center', textAlign: 'center', bgcolor: 'rgba(255,255,255,0.14)', borderRadius: 1, p: 3 }}>
            <Box>
              <Typography sx={{ fontSize: { xs: '1.4rem', md: '2.6rem' }, fontWeight: 700, opacity: 0.9 }}>{t('Now calling')}</Typography>
              <Typography
                key={`${first.number}-${first.callCount}-${first.calledAt}`}
                aria-label={t('Number {{n}}', { n: first.number })}
                sx={{ fontSize: { xs: '9rem', md: '20rem' }, fontWeight: 900, lineHeight: 1, '@keyframes pop': { from: { transform: 'scale(0.7)', opacity: 0.2 }, to: { transform: 'scale(1)', opacity: 1 } }, animation: 'pop 0.6s ease-out' }}
              >
                {first.number}
              </Typography>
              {first.unit && <Typography sx={{ fontSize: { xs: '1.8rem', md: '4rem' }, fontWeight: 800 }}>{t('Please go to {{unit}}', { unit: first.unit })}</Typography>}
            </Box>
          </Box>
          {others.length > 0 && (
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(auto-fit, minmax(240px, 1fr))' }, gap: 2 }}>
              {others.map((c) => (
                <Box component="li" key={`${c.number}-${c.unit}`} sx={{ bgcolor: 'rgba(255,255,255,0.14)', borderRadius: 1, p: 2, textAlign: 'center' }}>
                  <Typography sx={{ fontSize: { xs: '3rem', md: '5rem' }, fontWeight: 900, lineHeight: 1 }}>{c.number}</Typography>
                  {c.unit && <Typography sx={{ fontSize: { xs: '1.1rem', md: '1.8rem' }, fontWeight: 700 }}>{c.unit}</Typography>}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      {data && (
        <Typography sx={{ textAlign: 'center', fontSize: { xs: '1.1rem', md: '1.8rem' }, opacity: 0.9 }}>
          {data.waiting === 0 ? t('Nobody is waiting.') : t('{{n}} waiting', { n: data.waiting })}
        </Typography>
      )}
    </Box>
  );
}
