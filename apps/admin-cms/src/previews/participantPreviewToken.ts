import crypto from 'node:crypto';

const RAW_TOKEN_BYTES = 32; // 256 bits of cryptographically secure randomness
const HEX_64_REGEX = /^[0-9a-f]{64}$/;
const MAX_CANDIDATE_LENGTH = 512; // guards against hashing pathologically large route params

/**
 * Generates a fresh, cryptographically secure, opaque preview token server-side.
 * The raw value is 256 bits of randomness encoded as 64 lowercase hex characters.
 */
export function generateRawPreviewToken(): string {
  return crypto.randomBytes(RAW_TOKEN_BYTES).toString('hex');
}

/**
 * One-way SHA-256 hash of a raw preview token. Only this hash is ever persisted;
 * the raw token itself must never be stored in the database or written to logs.
 */
export function hashPreviewToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Cheap shape check on an untrusted route-param candidate before it is hashed and looked up.
 * Not a source of truth for validity — the database resolution RPC is authoritative.
 */
export function isPlausibleRawPreviewToken(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.length <= MAX_CANDIDATE_LENGTH && HEX_64_REGEX.test(candidate);
}
