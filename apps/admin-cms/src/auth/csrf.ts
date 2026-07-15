/**
 * Hardened Same-Origin CSRF validation helper.
 * 
 * Rules:
 * - Checks incoming Origin header against the authoritative request origin (request.nextUrl.origin).
 * - Scheme, hostname, and port must match exactly.
 * - Missing, empty, or malformed origin headers are rejected (returns false).
 * - Case-normalized comparisons prevent encoding bypasses.
 */
export function validateSameOrigin(originHeader: string | null, requestOrigin: string): boolean {
  if (!originHeader || originHeader.trim() === '') {
    return false;
  }

  try {
    const originUrl = new URL(originHeader);
    const reqOriginUrl = new URL(requestOrigin);

    const originScheme = originUrl.protocol.toLowerCase();
    const reqScheme = reqOriginUrl.protocol.toLowerCase();

    const originHostname = originUrl.hostname.toLowerCase();
    const reqHostname = reqOriginUrl.hostname.toLowerCase();

    const getPort = (url: URL) => {
      if (url.port) return url.port;
      return url.protocol === 'https:' ? '443' : '80';
    };

    const originPort = getPort(originUrl);
    const reqPort = getPort(reqOriginUrl);

    return (
      originScheme === reqScheme &&
      originHostname === reqHostname &&
      originPort === reqPort
    );
  } catch {
    return false;
  }
}
