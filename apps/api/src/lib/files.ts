import { sniffImage } from './images';

export type DocumentKind = { mime: string; ext: string; image: boolean };

/**
 * Identifies an uploaded document by its first bytes, never by the name or Content-Type the client sent: a PNG,
 * JPEG or WebP picture, or a PDF. Nothing that can carry a script as a picture (SVG), no HTML, no archives.
 */
export function sniffDocument(b: Buffer): DocumentKind | null {
  const image = sniffImage(b);
  if (image) return { ...image, image: true };
  if (b.length > 16 && b.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', image: false };
  return null;
}
