import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DentalPanorama } from '../components/DentalPanorama';
import { PANORAMA, ZONES, toothPath } from '../lib/panoramaZones';
import { renderApp } from './mockApi';

const ALL = ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28', '48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'];
const TEETH = ALL.map((index, i) => ({ id: i + 1, index, name: `Tooth ${index}`, type: 'Molar' }));
const id = (index: string) => TEETH.find((t) => t.index === index)!.id;

describe('panorama zone map', () => {
  it('has exactly one zone for each of the 32 teeth, in the picture order', () => {
    expect(ZONES.map((z) => z.index)).toEqual(ALL);
  });

  it('keeps every zone inside the picture', () => {
    for (const z of ZONES) {
      expect(z.w, z.index).toBeGreaterThanOrEqual(70); // wide enough to tap once the picture is at phone size
      expect(z.h, z.index).toBeGreaterThanOrEqual(90);
      expect(z.x, z.index).toBeGreaterThanOrEqual(0);
      expect(z.y, z.index).toBeGreaterThanOrEqual(0);
      expect(z.x + z.w, z.index).toBeLessThanOrEqual(PANORAMA.width);
      expect(z.y + z.h, z.index).toBeLessThanOrEqual(PANORAMA.height);
    }
  });

  it('puts the patient’s right on the viewer’s left, and mirrors the two sides', () => {
    const z = (i: string) => ZONES.find((x) => x.index === i)!;
    for (const [right, left] of [['11', '21'], ['18', '28'], ['41', '31'], ['48', '38']] as const) {
      expect(z(right).x).toBeLessThan(PANORAMA.midline);
      expect(z(left).x).toBeGreaterThanOrEqual(PANORAMA.midline - 1);
      expect(z(right).x + z(right).w + z(left).x).toBeCloseTo(PANORAMA.width, 0);
      expect(z(right).y).toBe(z(left).y);
    }
  });

  it('has a closed outline for every tooth', () => {
    for (const z of ZONES) {
      const d = toothPath(z);
      expect(d, z.index).toMatch(/^M/);
      expect(d, z.index).toMatch(/Z$/);
      expect(d, z.index).not.toContain('NaN');
    }
  });

  it('puts the right teeth in the right jaw and keeps incisors in the middle', () => {
    const z = (i: string) => ZONES.find((x) => x.index === i)!;
    expect(ZONES.filter((x) => x.jaw === 'upper').map((x) => x.index[0]).every((q) => q === '1' || q === '2')).toBe(true);
    expect(ZONES.filter((x) => x.jaw === 'lower').map((x) => x.index[0]).every((q) => q === '3' || q === '4')).toBe(true);
    expect(z('11').kind).toBe('incisor');
    expect(z('13').kind).toBe('canine');
    expect(z('18').kind).toBe('molar');
    expect(Math.abs(z('11').x + z('11').w - PANORAMA.midline)).toBeLessThan(10);
  });

  it('does not let neighbouring zones of one jaw overlap', () => {
    for (const jaw of [ALL.slice(0, 16), ALL.slice(16)]) {
      const zones = jaw.map((i) => ZONES.find((z) => z.index === i)!);
      for (let i = 1; i < zones.length; i++) expect(zones[i]!.x, zones[i]!.index).toBeGreaterThanOrEqual(zones[i - 1]!.x + zones[i - 1]!.w - 1);
    }
  });
});

describe('the dental panorama', () => {
  it('draws one flat illustration with a crown for each of the 32 teeth, and no picture file', () => {
    const { container } = renderApp(<DentalPanorama teeth={TEETH} />);
    expect([...container.querySelectorAll('path[data-tooth]')].map((p) => p.getAttribute('data-tooth'))).toEqual(ALL);
    expect(container.querySelector('image')).toBeNull();
  });

  it('highlights teeth with history and chosen teeth, and any tooth can be chosen', async () => {
    const clicked: number[] = [];
    renderApp(<DentalPanorama teeth={TEETH} marked={new Set([id('18')])} selected={new Set([id('21')])} onToggle={(t) => clicked.push(t)} />);
    expect(screen.getByRole('button', { name: /^Tooth 18, Tooth 18, has notes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Tooth 21.*selected/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /^Tooth 11,/ }));
    expect(clicked).toEqual([id('11')]);
  });

  it('in history mode only teeth with history can be opened', async () => {
    const clicked: number[] = [];
    renderApp(<DentalPanorama clickable="marked" teeth={TEETH} marked={new Set([id('36')])} onToggle={(t) => clicked.push(t)} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /^Tooth 36,.*has notes/ }));
    expect(clicked).toEqual([id('36')]);
    expect(screen.getByRole('img', { name: /^Tooth 37,/ })).toBeInTheDocument();
  });

  it('works from the keyboard', async () => {
    const clicked: number[] = [];
    renderApp(<DentalPanorama teeth={TEETH} onToggle={(t) => clicked.push(t)} />);
    screen.getByRole('button', { name: /^Tooth 26,/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(clicked).toEqual([id('26')]);
  });

  it('is read-only when nothing handles clicks', () => {
    renderApp(<DentalPanorama teeth={TEETH} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
