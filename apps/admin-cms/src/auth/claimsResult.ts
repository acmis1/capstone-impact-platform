import { AdminAuthError } from './authTypes';
import { extractSubClaim } from './claims';

/**
 * Pure helper to parse and validate the complete getClaims() response envelope.
 * 
 * Rules:
 * - Expects structure: { data: { claims: { sub: "..." } }, error: null }
 * - Rejects if error field is populated or data/claims are missing.
 * - Delegate sub claim validation to extractSubClaim.
 * - Does not import Next.js, cookies, Supabase client/network calls, or env configurations.
 */
export function parseClaimsResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    throw new AdminAuthError('UNAUTHENTICATED', 'Authentication required.');
  }

  const envelope = result as { data?: { claims?: unknown } | null; error?: unknown };

  if (envelope.error) {
    throw new AdminAuthError('UNAUTHENTICATED', 'Authentication required.');
  }

  const data = envelope.data;
  if (!data || typeof data !== 'object') {
    throw new AdminAuthError('UNAUTHENTICATED', 'Authentication required.');
  }

  const claims = data.claims;
  if (!claims) {
    throw new AdminAuthError('UNAUTHENTICATED', 'Authentication required.');
  }

  return extractSubClaim(claims);
}
