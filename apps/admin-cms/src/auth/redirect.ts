/**
 * Sanitizes redirect paths to prevent open redirect vulnerabilities.
 * Allows only relative paths starting with a single '/' and rejects
 * absolute URLs, protocol-relative URLs (//), backslash paths (\\), 
 * and encoded variants.
 */
export function sanitizeRedirectPath(path: string | null | undefined): string {
  if (!path) return '/admin';

  let decoded = path.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return '/admin';
  }

  // Reject paths containing protocol schemes or absolute prefixes
  if (/^(https?:)?\/\//i.test(decoded)) {
    return '/admin';
  }

  // Reject backslashes to prevent backslash-based relative bypasses in some browsers
  if (decoded.includes('\\')) {
    return '/admin';
  }

  // Ensure it starts with exactly one '/' and is not protocol-relative (e.g. '//')
  if (decoded.startsWith('/') && !decoded.startsWith('//')) {
    return decoded;
  }

  return '/admin';
}
