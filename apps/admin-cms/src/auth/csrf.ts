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
export function parseCanonicalHttpOrigin(value: string | null | undefined): string | null {
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
  const submittedOrigin = parseCanonicalHttpOrigin(originHeader);
  if (!submittedOrigin) return false;

  const directOrigin = parseCanonicalHttpOrigin(requestOrigin);
  if (directOrigin === submittedOrigin) return true;

  if (process.env.RENDER !== 'true') return false;

  const renderExternalOrigin = parseCanonicalHttpOrigin(process.env.RENDER_EXTERNAL_URL);
  return renderExternalOrigin !== null && renderExternalOrigin === submittedOrigin;
}

/**
 * Resolves the canonical origin safe to place into a URL that leaves this process.
 *
 * Unlike CSRF validation, a Render deployment must never use its direct/internal request origin:
 * only Render's platform-owned external URL is authoritative. Forwarding and Host headers are not
 * inputs to this function.
 */
export function resolveCanonicalPublicOrigin(requestOrigin: string): string | null {
  if (process.env.RENDER === 'true') {
    return parseCanonicalHttpOrigin(process.env.RENDER_EXTERNAL_URL);
  }
  return parseCanonicalHttpOrigin(requestOrigin);
}
