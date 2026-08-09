/**
 * Client-safe browser folder selection and path normalization contract.
 * 
 * IMPORTANT: This module MUST remain 100% client-safe and pure.
 * Do NOT import Node fs, path, Buffer, ExcelJS, Supabase, or server-only modules here.
 */

export interface SelectedFileDescriptor {
  uploadKey: string;
  normalizedPath: string;
  originalPath: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  packagePath: string;
}

export interface SelectionManifest {
  selectedRootName: string;
  fileCount: number;
  declaredTotalBytes: number;
  descriptors: SelectedFileDescriptor[];
  ignoredSystemFilesCount: number;
}

const CANONICAL_MIME_MAP: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.json': 'application/json',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Normalizes a browser relative path (e.g. webkitRelativePath).
 * 
 * Rules:
 * - Converts backslashes \ to /.
 * - Rejects null bytes \0 and control characters.
 * - Rejects absolute paths (starting with / or drive letters like C:).
 * - Rejects empty segments (e.g. foo//bar).
 * - Rejects . and .. path traversal segments.
 * - Returns normalized path string or null if invalid.
 */
export function normalizeRelativePath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') {
    return null;
  }

  // Reject null bytes and control characters
  if (/[\x00-\x1F\x7F]/.test(rawPath)) {
    return null;
  }

  // Convert backslashes to forward slashes
  const path = rawPath.replace(/\\/g, '/');

  // Reject absolute paths (starting with / or Windows drive letters like C:)
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    return null;
  }

  const segments = path.split('/');

  // Reject empty segments, . or ..
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return null;
    }
  }

  return segments.join('/');
}

/**
 * Checks if a normalized path represents an operating-system noise file.
 * Ignored files: .DS_Store, Thumbs.db, desktop.ini, or anything beneath __MACOSX
 */
export function isIgnoredSystemFile(normalizedPath: string): boolean {
  if (!normalizedPath) return false;
  const segments = normalizedPath.split('/');
  const fileName = segments[segments.length - 1].toLowerCase();

  if (fileName === '.ds_store' || fileName === 'thumbs.db' || fileName === 'desktop.ini') {
    return true;
  }

  for (const seg of segments) {
    if (seg === '__MACOSX') {
      return true;
    }
  }

  return false;
}

/**
 * Derives and validates MIME type for canonical package files.
 */
export function deriveMimeType(fileName: string, browserMime?: string): { mimeType: string; warning?: string } {
  const lower = fileName.toLowerCase();
  let ext = '';

  for (const key of Object.keys(CANONICAL_MIME_MAP)) {
    if (lower.endsWith(key)) {
      ext = key;
      break;
    }
  }

  const expectedMime = ext ? CANONICAL_MIME_MAP[ext] : undefined;
  const cleanedBrowserMime = browserMime ? browserMime.trim().toLowerCase() : '';

  if (!cleanedBrowserMime && expectedMime) {
    return { mimeType: expectedMime };
  }

  if (expectedMime && cleanedBrowserMime && cleanedBrowserMime !== expectedMime) {
    return {
      mimeType: expectedMime,
      warning: 'File MIME type conflict detected. Using canonical MIME type for validation.',
    };
  }

  return {
    mimeType: cleanedBrowserMime || expectedMime || 'application/octet-stream',
  };
}

/**
 * Generates a stable upload key for a file descriptor.
 */
export function generateUploadKey(normalizedPath: string, fileSizeBytes: number): string {
  return `${normalizedPath.toLowerCase()}::${fileSizeBytes}`;
}
