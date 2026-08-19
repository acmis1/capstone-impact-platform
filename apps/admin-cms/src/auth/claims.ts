import { AdminAuthError } from './authTypes';

export interface VerifiedAuthClaims {
  userId: string;
  sessionId: string;
  authenticationMethods: string[];
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_AUTHENTICATION_METHOD_LENGTH = 64;
const MAX_AUTHENTICATION_METHODS = 16;

function unauthenticated(): never {
  throw new AdminAuthError('UNAUTHENTICATED', 'Authentication required.');
}

/** Compatibility helper for callers that need only a strict subject UUID. */
export function extractSubClaim(claims: unknown): string {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) unauthenticated();

  const sub = (claims as Record<string, unknown>).sub;
  if (typeof sub !== 'string' || !UUID_PATTERN.test(sub)) unauthenticated();
  return sub;
}

/** Strictly parses only verified identity, session, and authentication-method claims. */
export function extractVerifiedAuthClaims(claims: unknown): VerifiedAuthClaims {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) unauthenticated();
  const record = claims as Record<string, unknown>;
  const userId = extractSubClaim(record);
  const sessionId = record.session_id;
  const amr = record.amr;

  if (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)) unauthenticated();
  if (!Array.isArray(amr) || amr.length > MAX_AUTHENTICATION_METHODS) unauthenticated();

  const authenticationMethods = amr.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) unauthenticated();
    const methodRecord = entry as Record<string, unknown>;
    const keys = Object.keys(methodRecord).sort();
    if (keys.length !== 2 || keys[0] !== 'method' || keys[1] !== 'timestamp') unauthenticated();
    const { method, timestamp } = methodRecord;
    if (
      typeof method !== 'string' ||
      method.length === 0 ||
      method.length > MAX_AUTHENTICATION_METHOD_LENGTH ||
      method.trim() !== method ||
      !Number.isSafeInteger(timestamp) ||
      (timestamp as number) < 0
    ) {
      unauthenticated();
    }
    return method;
  });

  return { userId, sessionId, authenticationMethods };
}
