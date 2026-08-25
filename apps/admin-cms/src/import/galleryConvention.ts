export const MAX_GALLERY_IMAGES = 10;

/**
 * Reads the deterministic gallery position from a snapshot-N filename.
 *
 * Examples:
 * snapshot-1.png   -> 1
 * snapshot-2.jpg   -> 2
 * snapshot-10.webp -> 10
 *
 * This function only parses the position.
 * Maximum gallery bounds are enforced by package validation.
 */
export function parseGalleryFilePosition(
  fileName: string,
): number | null {
  const match = /^snapshot-([1-9]\d*)\.[a-z0-9]+$/i.exec(
    fileName.trim(),
  );

  if (!match) {
    return null;
  }

  const position = Number(match[1]);

  if (!Number.isSafeInteger(position) || position < 1) {
    return null;
  }

  return position;
}

export function sortGalleryByPosition<T extends { position: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}