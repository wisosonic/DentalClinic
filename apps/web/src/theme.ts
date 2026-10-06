import { alpha, createTheme } from '@mui/material/styles';
import { TEXT_SIZE_PX, type ColorMode, type TextSize } from '@aya/shared';

// Brand colours come from the logo: a teal and a deep petrol blue.
export const BRAND = {
  teal: '#0b7a75',
  tealLight: '#40bfb9',
  petrol: '#0f6478',
  deep: '#0a3d4d',
  /** The signature gradient used for the sidebar, hero cards and primary buttons. */
  gradient: 'linear-gradient(135deg, #0b7a75 0%, #0f6478 100%)',
  gradientDeep: 'linear-gradient(170deg, #0f6478 0%, #0a3d4d 100%)',
};

/** The one corner radius, in px: inputs, buttons, Paper (cards), dialogs, menus, alerts and tables all use it. In `sx`, a `borderRadius` of 1 is this size. */
export const RADIUS = 10;
/** The colours that change between light and dark; everything else in the theme is the same in both. */
const TOKENS = {
  light: {
    bg: '#eef4f6', paper: '#ffffff', text: '#10242b', textSecondary: '#4f656b', line: 'rgba(15, 100, 120, 0.12)', outline: 'rgba(15, 100, 120, 0.25)',
    primary: BRAND.teal, primaryLight: BRAND.tealLight, primaryDark: BRAND.petrol, secondary: BRAND.petrol, headText: BRAND.petrol, headBg: alpha(BRAND.teal, 0.07),
    shadowSm: '0 1px 2px rgba(10, 61, 77, 0.06), 0 4px 14px rgba(10, 61, 77, 0.06)', shadowMd: '0 2px 6px rgba(10, 61, 77, 0.08), 0 12px 32px rgba(10, 61, 77, 0.10)',
    glow: 'radial-gradient(1200px 500px at 100% -10%, rgba(64,191,185,0.16), transparent 60%), radial-gradient(900px 400px at -10% 110%, rgba(15,100,120,0.10), transparent 60%)',
    appBar: 'rgba(255,255,255,0.75)', appBarEdge: 'rgba(15,100,120,0.10)',
  },
  dark: {
    bg: '#0c1a1f', paper: '#13262d', text: '#e8f2f4', textSecondary: '#9fb6bc', line: 'rgba(255, 255, 255, 0.12)', outline: 'rgba(255, 255, 255, 0.25)',
    primary: BRAND.tealLight, primaryLight: '#7fd8d3', primaryDark: BRAND.teal, secondary: '#7fc0d6', headText: BRAND.tealLight, headBg: alpha(BRAND.tealLight, 0.12),
    shadowSm: '0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.30)', shadowMd: '0 2px 6px rgba(0, 0, 0, 0.40), 0 12px 32px rgba(0, 0, 0, 0.40)',
    glow: 'radial-gradient(1200px 500px at 100% -10%, rgba(64,191,185,0.10), transparent 60%), radial-gradient(900px 400px at -10% 110%, rgba(15,100,120,0.16), transparent 60%)',
    appBar: 'rgba(19,38,45,0.78)', appBarEdge: 'rgba(255,255,255,0.08)',
  },
} as const;

export interface ThemeOptions {
  /** Light or dark, for the whole clinic (Settings > Appearance). */
  mode?: ColorMode;
  /** The size of one rem: the whole interface scales with it. */
  textSize?: TextSize;
}

export const makeTheme = (direction: 'ltr' | 'rtl' = 'ltr', { mode = 'light', textSize = 'medium' }: ThemeOptions = {}) => {
  const c = TOKENS[mode];
  const LINE = c.line;
  const SHADOW_SM = c.shadowSm;
  const SHADOW_MD = c.shadowMd;
  return createTheme({
    direction,
    palette: {
      mode,
      primary: { main: c.primary, light: c.primaryLight, dark: c.primaryDark, contrastText: '#ffffff' },
      secondary: { main: c.secondary },
      success: { main: '#2e7d32' },
      warning: { main: '#ed6c02' },
      error: { main: '#d32f2f' },
      background: { default: c.bg, paper: c.paper },
      text: { primary: c.text, secondary: c.textSecondary },
      divider: LINE,
    },
    // One corner radius for everything: inputs, buttons, cards (Paper), dialogs, menus, alerts and tables.
    shape: { borderRadius: RADIUS },
    // Compact scale: spacing steps are 7px instead of 8px, and text and icons (rem) follow the 14px root below.
    spacing: 7,
    typography: {
      // Arabic falls back to fonts that ship with Windows, macOS, Android and iOS.
      fontFamily: '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, "Noto Sans Arabic", "Tahoma", Arial, sans-serif',
      h4: { fontWeight: 800, letterSpacing: '-0.025em' },
      h5: { fontWeight: 800, letterSpacing: '-0.02em' },
      h6: { fontWeight: 700, letterSpacing: '-0.01em' },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 700 },
      button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: { fontSize: `${(TEXT_SIZE_PX[textSize] / 16) * 100}%` }, // medium is a 14px root: everything sized in rem becomes 12.5% smaller
          body: {
            WebkitFontSmoothing: 'antialiased',
            backgroundImage: c.glow,
            backgroundAttachment: 'fixed',
          },
        },
      },
      // Touch targets of at least 44px on phones.
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { minHeight: 38, borderRadius: RADIUS, paddingInline: 16, '@media (max-width:599.95px)': { minHeight: 44 }, transition: 'transform .15s ease, box-shadow .15s ease, background .15s ease' },
          containedPrimary: {
            background: BRAND.gradient,
            boxShadow: '0 6px 16px rgba(11,122,117,0.30)',
            '&:hover': { background: BRAND.gradient, filter: 'brightness(1.08)', boxShadow: '0 8px 22px rgba(11,122,117,0.38)', transform: 'translateY(-1px)' },
            '&.Mui-disabled': { background: 'rgba(0,0,0,0.12)', boxShadow: 'none' },
          },
          outlined: { borderWidth: 1.5, '&:hover': { borderWidth: 1.5 } },
        },
      },
      MuiIconButton: { styleOverrides: { root: { minWidth: 38, minHeight: 38, '@media (max-width:599.95px)': { minWidth: 44, minHeight: 44 } } } },
      MuiTextField: { defaultProps: { fullWidth: true, margin: 'dense', size: 'small' } },
      MuiTable: { defaultProps: { size: 'small' } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: RADIUS,
            backgroundColor: c.paper,
            '@media (max-width:599.95px)': { minHeight: 44 }, // comfortable to tap on a phone
            '&.Mui-focused': { boxShadow: `0 0 0 4px ${alpha(c.primary, 0.18)}` },
          },
          notchedOutline: { borderColor: c.outline },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          outlined: { border: 'none', boxShadow: SHADOW_SM },
          elevation1: { boxShadow: SHADOW_SM },
        },
      },
      MuiDialog: {
        styleOverrides: { paper: { borderRadius: RADIUS, boxShadow: '0 24px 80px rgba(10,61,77,0.35)' } },
      },
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: 'rgba(10, 61, 77, 0.45)', backdropFilter: 'blur(3px)' } } },
      MuiDialogTitle: { styleOverrides: { root: { fontWeight: 800, paddingBlock: 16, fontSize: '1.15rem' } } },
      MuiDialogActions: { styleOverrides: { root: { padding: '10px 20px 18px' } } },
      MuiChip: { styleOverrides: { root: { fontWeight: 700, borderRadius: 999 } } },
      MuiTableContainer: { styleOverrides: { root: { borderRadius: RADIUS, overflow: 'hidden' } } },
      MuiTableHead: {
        styleOverrides: {
          root: {
            '& .MuiTableCell-root': {
              backgroundColor: c.headBg,
              fontWeight: 700,
              color: c.headText,
              fontSize: '0.78rem',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              borderBottom: 'none',
            },
          },
        },
      },
      MuiTableRow: { styleOverrides: { root: { transition: 'background .12s', '&:hover': { backgroundColor: alpha(c.primary, 0.06) }, '&:last-child td': { borderBottom: 0 } } } },
      MuiTableCell: { styleOverrides: { root: { borderBottomColor: LINE } } },
      MuiAppBar: {
        styleOverrides: {
          root: { backgroundColor: c.appBar, backdropFilter: 'blur(14px)', color: c.text, boxShadow: `0 1px 0 ${c.appBarEdge}` },
        },
      },
      MuiListItemIcon: { styleOverrides: { root: { minWidth: 42, color: 'inherit' } } },
      MuiTab: { styleOverrides: { root: { minHeight: 42, fontWeight: 700 } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: RADIUS } } },
      MuiMenu: { styleOverrides: { paper: { borderRadius: RADIUS, boxShadow: SHADOW_MD } } },
      MuiTooltip: { styleOverrides: { tooltip: { borderRadius: 8, backgroundColor: BRAND.deep } } },
    },
  });
};

export const theme = makeTheme('ltr');
