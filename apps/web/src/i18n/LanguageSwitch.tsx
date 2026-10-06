import { Button } from '@mui/material';
import LanguageIcon from '@mui/icons-material/Language';
import { useLanguage } from './index';

/**
 * Switches between English and Arabic. The label is always in the *other* language, written in
 * that language, so someone who can't read the current one can still find it.
 */
export function LanguageSwitch({ color = 'inherit' }: { color?: 'inherit' | 'primary' }) {
  const { lang, setLanguage } = useLanguage();
  const next = lang === 'ar' ? 'en' : 'ar';
  return (
    <Button
      color={color}
      size="small"
      startIcon={<LanguageIcon />}
      onClick={() => void setLanguage(next)}
      lang={next}
      aria-label={next === 'ar' ? 'العربية' : 'English'}
      sx={{ minWidth: 0 }}
    >
      {next === 'ar' ? 'العربية' : 'English'}
    </Button>
  );
}
