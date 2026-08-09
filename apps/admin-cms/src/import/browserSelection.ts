/**
 * System noise filenames automatically ignored across operating systems.
 */
export const IGNORED_SYSTEM_FILENAMES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
]);

/**
 * Derive normalized MIME type and conflict warning from filename and browser mimeType.
 */
export function deriveMimeType(fileName: string, rawMimeType: string): { mimeType: string; warning?: string } {
  const lowerName = fileName.toLowerCase();
  const rawLower = (rawMimeType || '').toLowerCase().trim();

  let expectedMime = 'application/octet-stream';
  if (lowerName.endsWith('.xlsx')) {
    expectedMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (lowerName.endsWith('.json')) {
    expectedMime = 'application/json';
  } else if (lowerName.endsWith('.png')) {
    expectedMime = 'image/png';
  } else if (lowerName.endsWith('.pdf')) {
    expectedMime = 'application/pdf';
  }

  if (rawLower && rawLower !== 'application/octet-stream' && expectedMime !== 'application/octet-stream' && rawLower !== expectedMime) {
    return {
      mimeType: expectedMime,
      warning: `MIME type conflict detected for ${fileName}: Browser reported "${rawMimeType}", expected "${expectedMime}".`,
    };
  }

  return { mimeType: expectedMime };
}

/**
 * Normalize relative path to POSIX standard.
 * Rejects path traversal (`.`, `..`), null bytes, control characters, and absolute paths.
 */
export function normalizeRelativePath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;

  // Reject null bytes and control characters
  if (/[\0\x00-\x1F\x7F]/.test(rawPath)) {
    return null;
  }

  // Convert backslashes to forward slashes
  const path = rawPath.replace(/\\/g, '/');

  // Reject absolute paths (starting with / or Windows drive letters like C:)
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    return null;
  }

  const segments = path.split('/');
  const cleanSegments: string[] = [];

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed === '') continue;
    if (trimmed === '.' || trimmed === '..') {
      // Path traversal detected
      return null;
    }
    cleanSegments.push(trimmed);
  }

  if (cleanSegments.length === 0) return null;

  return cleanSegments.join('/');
}

/**
 * Check whether normalized relative path belongs to OS noise files.
 */
export function isIgnoredSystemFile(normalizedPath: string): boolean {
  if (!normalizedPath) return false;
  const parts = normalizedPath.split('/');
  const fileName = parts[parts.length - 1].toLowerCase();

  if (IGNORED_SYSTEM_FILENAMES.has(fileName)) return true;
  if (parts.some((p) => p.toLowerCase() === '__macosx')) return true;

  return false;
}

/**
 * Generate stable upload key for metadata file descriptor.
 */
export function generateUploadKey(normalizedPath: string): string {
  return normalizedPath.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}
