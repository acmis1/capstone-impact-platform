/**
 * Hardened Same-Origin CSRF validation helper.
 * 
 * Rules:
 * - Checks incoming Origin header against the authoritative request origin (request.nextUrl.origin).
 * - On Render only, also accepts the canonical origin from RENDER_EXTERNAL_URL.
 * - Scheme, hostname, and effective port must match exactly.
 * - Missing, empty, or malformed origin headers are rejected (returns false).
 * - Forwarding headers are never trusted.
 */
function parseHttpOrigin(value: string | null | undefined): string | null {
  if (!value || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.href !== `${url.origin}/`) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function validateSameOrigin(originHeader: string | null, requestOrigin: string): boolean {
  const submittedOrigin = parseHttpOrigin(originHeader);
  if (!submittedOrigin) return false;

  const directOrigin = parseHttpOrigin(requestOrigin);
  if (directOrigin === submittedOrigin) return true;

  if (process.env.RENDER !== 'true') return false;

  const renderExternalOrigin = parseHttpOrigin(process.env.RENDER_EXTERNAL_URL);
  return renderExternalOrigin !== null && renderExternalOrigin === submittedOrigin;
}
