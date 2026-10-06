/**
 * Layout of the dental panorama: one flat illustration of all 32 teeth, identical for every patient.
 * The picture is drawn from this data (see components/DentalPanorama.tsx), so the clickable area of
 * each tooth and the tooth that is drawn can never drift apart, and there is no image file to license.
 *
 * Both jaws are laid out as a flat row of 16, the way a panoramic X-ray reads. The viewer's left is
 * the patient's right, so each row runs 18 .. 11, 21 .. 28 (upper) and 48 .. 41, 31 .. 38 (lower).
 * The left side is the exact mirror of the right side around x = 800.
 */
export const PANORAMA = { width: 1600, height: 470, midline: 800 } as const;

export type ToothKind = 'incisor' | 'canine' | 'premolar' | 'molar';

export interface Zone {
  /** FDI tooth number, e.g. "18". */
  index: string;
  jaw: 'upper' | 'lower';
  kind: ToothKind;
  /** The tooth's bounding box in picture units. */
  x: number;
  y: number;
  w: number;
  h: number;
}

// From the midline outward: 1 (central incisor) to 8 (wisdom tooth).
const KINDS: ToothKind[] = ['incisor', 'incisor', 'canine', 'premolar', 'premolar', 'molar', 'molar', 'molar'];
const WIDTH = [92, 76, 82, 80, 80, 106, 106, 92];
const HEIGHT = { upper: [150, 135, 150, 120, 120, 100, 100, 92], lower: [132, 120, 140, 116, 116, 100, 100, 92] };
const GAP = 6;
/** Upper teeth hang from this line; lower teeth stand on this one. */
const UPPER_TOP = 96;
const LOWER_BASE = 404;

function side(jaw: 'upper' | 'lower', quadrant: number): Zone[] {
  const zones: Zone[] = [];
  let offset = GAP / 2; // distance from the midline
  for (let n = 1; n <= 8; n++) {
    const w = WIDTH[n - 1]!;
    const h = HEIGHT[jaw][n - 1]!;
    zones.push({
      index: `${quadrant}${n}`, jaw, kind: KINDS[n - 1]!,
      x: PANORAMA.midline - offset - w, // the patient's right side is drawn left of the midline
      y: jaw === 'upper' ? UPPER_TOP : LOWER_BASE - h, w, h,
    });
    offset += w + GAP;
  }
  return zones;
}

const mirror = (z: Zone): Zone => ({ ...z, index: `${Number(z.index[0]) + 1}${z.index[1]}`, x: PANORAMA.width - (z.x + z.w) });

const byViewerLeft = (zones: Zone[]) => [...zones].sort((a, b) => a.x - b.x);

const upperRight = side('upper', 1);
const lowerRight = side('lower', 4);

/** Upper jaw 18 to 28 across the picture, then lower jaw 48 to 38. */
export const ZONES: Zone[] = [
  ...byViewerLeft(upperRight), ...byViewerLeft(upperRight.map(mirror)),
  ...byViewerLeft(lowerRight), ...byViewerLeft(lowerRight.map((z) => ({ ...mirror(z), index: `3${z.index[1]}` }))),
];

/** Where the gums are drawn, and where the tooth numbers sit. */
export const GUMS = {
  upper: { y: 38, h: 76 },
  lower: { y: LOWER_BASE - 14, h: 76 },
  upperLabelY: 76,
  lowerLabelY: LOWER_BASE + 40,
} as const;

/**
 * The outline of a tooth crown. Upper teeth are flat on top (the gum line) and rounded at the
 * biting edge; lower teeth are the same turned upside down. Canines come to a soft point.
 */
export function toothPath(z: Zone): string {
  const { x, y, w, h, kind, jaw } = z;
  const flip = jaw === 'lower';
  // Work in "upper" coordinates, then turn the y values over for the lower jaw.
  const Y = (v: number) => (flip ? y + h - (v - y) : v);
  const r = Math.min({ incisor: w * 0.42, canine: 0, premolar: w * 0.34, molar: w * 0.24 }[kind], h / 2);
  const p = (px: number, py: number) => `${px.toFixed(1)},${Y(py).toFixed(1)}`;
  if (kind === 'canine') {
    return `M${p(x, y)} L${p(x + w, y)} L${p(x + w, y + h * 0.6)} Q${p(x + w, y + h * 0.82)} ${p(x + w / 2, y + h)} Q${p(x, y + h * 0.82)} ${p(x, y + h * 0.6)} Z`;
  }
  const b = y + h;
  return `M${p(x, y)} L${p(x + w, y)} L${p(x + w, b - r)} Q${p(x + w, b)} ${p(x + w - r, b)} L${p(x + r, b)} Q${p(x, b)} ${p(x, b - r)} Z`;
}
