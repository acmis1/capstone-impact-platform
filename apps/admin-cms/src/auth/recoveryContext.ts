import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const RECOVERY_CONTEXT_COOKIE_NAME = 'capstone_password_recovery_context';
export const RECOVERY_CONTEXT_MAX_AGE_SECONDS = 600;
export const RECOVERY_CONTEXT_PURPOSE = 'password_recovery';
export const RECOVERY_CONTEXT_VERSION = 1;
export const RECOVERY_CONTEXT_ALLOWED_CLOCK_SKEW_SECONDS = 30;

const MAX_CONTEXT_TOKEN_LENGTH = 2048;
const MAX_SECRET_BYTES = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface RecoveryContextPayload {
  version: typeof RECOVERY_CONTEXT_VERSION;
  purpose: typeof RECOVERY_CONTEXT_PURPOSE;
  userId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export type RecoveryContextVerification =
  | { valid: true; payload: RecoveryContextPayload }
  | { valid: false };

export type RecoveryContextStatus = 'absent' | 'valid' | 'invalid';

export interface RecoveryContextCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

function requireStrongSecret(secretOverride?: string): string {
  const secret = secretOverride ?? process.env.CAPSTONE_AUTH_FLOW_SECRET;
  const byteLength = typeof secret === 'string' ? Buffer.byteLength(secret, 'utf8') : 0;
  if (!secret || byteLength < 32 || byteLength > MAX_SECRET_BYTES) {
    throw new Error('Password recovery context configuration is unavailable.');
  }
  return secret;
}

function strictBase64UrlDecode(value: string): Buffer | null {
  if (!value || !BASE64URL_PATTERN.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
}

function signatureFor(payloadPart: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadPart, 'utf8').digest('base64url');
}

/** Always uses timingSafeEqual, including malformed or wrong-length submitted signatures. */
export function constantTimeSignatureMatches(received: string, expected: string): boolean {
  const expectedBuffer = strictBase64UrlDecode(expected) ?? Buffer.alloc(32);
  const receivedBuffer = strictBase64UrlDecode(received) ?? Buffer.alloc(0);
  const comparable = Buffer.alloc(expectedBuffer.length);
  receivedBuffer.copy(comparable, 0, 0, expectedBuffer.length);
  return timingSafeEqual(comparable, expectedBuffer) && receivedBuffer.length === expectedBuffer.length;
}

function hasExactPayloadShape(value: unknown): value is RecoveryContextPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['expiresAt', 'issuedAt', 'nonce', 'purpose', 'sessionId', 'userId', 'version'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return false;
  }
  return (
    record.version === RECOVERY_CONTEXT_VERSION &&
    record.purpose === RECOVERY_CONTEXT_PURPOSE &&
    typeof record.userId === 'string' &&
    UUID_PATTERN.test(record.userId) &&
    typeof record.sessionId === 'string' &&
    UUID_PATTERN.test(record.sessionId) &&
    Number.isInteger(record.issuedAt) &&
    Number.isInteger(record.expiresAt) &&
    typeof record.nonce === 'string' &&
    record.nonce.length >= 16 &&
    record.nonce.length <= 128 &&
    BASE64URL_PATTERN.test(record.nonce)
  );
}

export function signRecoveryContext(
  userId: string,
  sessionId: string,
  options: { secret?: string; nowSeconds?: number; nonce?: string } = {},
): string {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(sessionId)) {
    throw new Error('Password recovery context identity is invalid.');
  }
  const secret = requireStrongSecret(options.secret);
  const issuedAt = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(issuedAt) || issuedAt < 0) {
    throw new Error('Password recovery context time is invalid.');
  }
  const nonce = options.nonce ?? randomBytes(18).toString('base64url');
  if (!BASE64URL_PATTERN.test(nonce) || nonce.length < 16 || nonce.length > 128) {
    throw new Error('Password recovery context nonce is invalid.');
  }

  const payload: RecoveryContextPayload = {
    version: RECOVERY_CONTEXT_VERSION,
    purpose: RECOVERY_CONTEXT_PURPOSE,
    userId,
    sessionId,
    issuedAt,
    expiresAt: issuedAt + RECOVERY_CONTEXT_MAX_AGE_SECONDS,
    nonce,
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadPart}.${signatureFor(payloadPart, secret)}`;
}

export function verifyRecoveryContext(
  token: string | null | undefined,
  options: {
    secret?: string;
    nowSeconds?: number;
    expectedUserId?: string;
    expectedSessionId?: string;
  } = {},
): RecoveryContextVerification {
  const secret = requireStrongSecret(options.secret);
  if (!token || typeof token !== 'string' || token.length > MAX_CONTEXT_TOKEN_LENGTH) {
    return { valid: false };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const [payloadPart, submittedSignature] = parts;
  const expectedSignature = signatureFor(payloadPart, secret);
  if (!constantTimeSignatureMatches(submittedSignature, expectedSignature)) {
    return { valid: false };
  }

  const payloadBuffer = strictBase64UrlDecode(payloadPart);
  if (!payloadBuffer || payloadBuffer.length > 1024) return { valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    return { valid: false };
  }
  if (!hasExactPayloadShape(parsed)) return { valid: false };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(now) || now < 0) return { valid: false };
  if (parsed.issuedAt > now + RECOVERY_CONTEXT_ALLOWED_CLOCK_SKEW_SECONDS) return { valid: false };
  if (parsed.expiresAt <= now) return { valid: false };
  if (
    parsed.expiresAt <= parsed.issuedAt ||
    parsed.expiresAt - parsed.issuedAt > RECOVERY_CONTEXT_MAX_AGE_SECONDS
  ) {
    return { valid: false };
  }
  if (options.expectedUserId && parsed.userId !== options.expectedUserId) {
    return { valid: false };
  }
  if (options.expectedSessionId && parsed.sessionId !== options.expectedSessionId) {
    return { valid: false };
  }
  return { valid: true, payload: parsed };
}

export function getRecoveryContextCookieOptions(maxAge = RECOVERY_CONTEXT_MAX_AGE_SECONDS): RecoveryContextCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

export async function issueRecoveryContextCookie(userId: string, sessionId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(
    RECOVERY_CONTEXT_COOKIE_NAME,
    signRecoveryContext(userId, sessionId),
    getRecoveryContextCookieOptions(),
  );
}

export async function clearRecoveryContextCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(
    RECOVERY_CONTEXT_COOKIE_NAME,
    '',
    getRecoveryContextCookieOptions(0),
  );
}

export async function readRecoveryContextCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(RECOVERY_CONTEXT_COOKIE_NAME)?.value ?? null;
}

export async function inspectRecoveryContextForSession(
  userId: string,
  sessionId: string,
): Promise<RecoveryContextStatus> {
  const token = await readRecoveryContextCookie();
  if (!token) return 'absent';
  return verifyRecoveryContext(token, {
    expectedUserId: userId,
    expectedSessionId: sessionId,
  }).valid ? 'valid' : 'invalid';
}
