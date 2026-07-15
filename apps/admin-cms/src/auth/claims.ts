import { AdminAuthError } from './authTypes';

/**
 * Validates and extracts the subject ('sub') claim from authenticated JWT claims.
 * 
 * Rules:
 * - Claims must be a non-null object.
 * - The 'sub' property must exist, be a string, and be a valid, non-empty UUID/identifier.
 * - Throws AdminAuthError with UNAUTHENTICATED code if invalid.
 */
export function extractSubClaim(claims: unknown): string {
  if (!claims || typeof claims !== 'object') {
    throw new AdminAuthError('UNAUTHENTICATED', 'No valid claims found in authentication session.');
  }

  const sub = (claims as Record<string, unknown>).sub;

  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new AdminAuthError('UNAUTHENTICATED', 'Missing or empty subject identifier in session claims.');
  }

  // Basic UUID format check: 8-4-4-4-12 hex chars (case-insensitive)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sub)) {
    throw new AdminAuthError('UNAUTHENTICATED', 'Invalid subject claim format.');
  }

  return sub;
}
