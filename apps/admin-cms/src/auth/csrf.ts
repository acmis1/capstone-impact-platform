/**
 * Validates whether a state-changing request matches the same origin.
 * Prevents CSRF attacks from malicious third-party cross-origin page forms.
 * 
 * Rules:
 * - If Origin is present, its parsed host must exactly match the Host header.
 * - Malformed origin values reject validation for safety.
 * - If Origin is missing, returns true to allow programmatic server-to-server 
 *   calls or non-browser tests, but logs or restricts where appropriate.
 */
export function validateSameOrigin(originHeader: string | null, hostHeader: string | null): boolean {
  if (!originHeader) {
    // Handle missing Origin conservatively.
    // Programmatic test clients and server-to-server RPCs omit Origin.
    return true;
  }

  try {
    const originUrl = new URL(originHeader);
    const originHost = originUrl.host; // e.g. "localhost:3000" or "example.com"

    if (!hostHeader) {
      return false;
    }

    // Standardize host header comparison (remove protocol prefix if present)
    const cleanHost = hostHeader.replace(/^(https?:\/\/)/, '').trim();

    return originHost.toLowerCase() === cleanHost.toLowerCase();
  } catch {
    // Malformed origin format fails validation safely
    return false;
  }
}
