import { render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';
import { BAR_COLORS, BarList } from '../features/dashboard/BarList';

const items = [{ key: 1, label: 'Hicham Cheaib', value: 600, display: '$600.00' }, { key: 2, label: 'Nour Haddad', value: 300, display: '$300.00' }];
const bars = () => [...document.querySelectorAll('[data-bar-color]')].map((b) => b.getAttribute('data-bar-color'));
const inMode = (mode: 'light' | 'dark', color?: Parameters<typeof BarList>[0]['color']) =>
  render(<ThemeProvider theme={createTheme({ palette: { mode } })}><BarList label="Biggest debts" items={items} color={color} /></ThemeProvider>);

describe('the ranked bars', () => {
  it('use the debts colour that was chosen for each mode', () => {
    const light = inMode('light', BAR_COLORS.debt);
    expect(bars()).toEqual([BAR_COLORS.debt.light, BAR_COLORS.debt.light]);
    light.unmount();
    inMode('dark', BAR_COLORS.debt);
    expect(bars()).toEqual([BAR_COLORS.debt.dark, BAR_COLORS.debt.dark]);
  });

  it('start from a blue that has its own dark step, and still accept one colour for every mode', () => {
    const dark = inMode('dark');
    expect(bars()).toEqual([BAR_COLORS.blue.dark, BAR_COLORS.blue.dark]);
    dark.unmount();
    inMode('light', '#123456');
    expect(bars()).toEqual(['#123456', '#123456']);
  });

  it('are real text first: the names and figures read in order, the bars are decoration', () => {
    inMode('light');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Hicham Cheaib$600.00', 'Nour Haddad$300.00']);
  });

  it('size each bar against the biggest', () => {
    inMode('light');
    const widths = [...document.querySelectorAll('[data-bar-color]')].map((b) => getComputedStyle(b).width);
    expect(widths).toEqual(['100%', '50%']);
  });
});
