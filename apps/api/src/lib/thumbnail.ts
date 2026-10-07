import sharp from 'sharp';

/** Longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 256;

/**
 * A small WebP preview of a picture, or null when it cannot be made (a damaged file, or one with an unreasonable
 * number of pixels: a decompression bomb). The picture is turned upright from its orientation mark, and sharp drops
 * all other metadata (GPS position, camera, names), so the preview carries only the pixels.
 */
export async function makeThumbnail(file: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(file, { limitInputPixels: 100_000_000, failOn: 'error' })
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
  } catch {
    return null;
  }
}
