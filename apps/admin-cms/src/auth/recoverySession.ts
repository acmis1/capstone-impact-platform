import type { VerifiedAuthClaims } from './claims';
import { parseClaimsResult } from './claimsResult';
import {
  inspectRecoveryContextForSession,
  type RecoveryContextStatus,
} from './recoveryContext';

export const REGISTER_PASSWORD_RECOVERY_SESSION_RPC = 'register_password_recovery_session';
export const GET_CURRENT_PASSWORD_RECOVERY_SESSION_STATE_RPC =
  'get_current_password_recovery_session_state';

export type RecoveryRegistrationResultCode =
  | 'REGISTERED'
  | 'ALREADY_REGISTERED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_USER_MISMATCH'
  | 'VALIDATION_FAILED';

export type RecoverySessionState =
  | 'RECOVERY_SESSION'
  | 'NOT_REGISTERED'
  | 'INVALID_CONTEXT';

export type AdminProvenanceDecision =
  | 'ALLOW_ADMIN'
  | 'PASSWORD_RECOVERY_REQUIRED'
  | 'AUTHENTICATION_PROVENANCE_INVALID';

export interface RecoveryRpcClient {
  rpc: (
    functionName: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
}

interface CurrentRecoveryClient extends RecoveryRpcClient {
  auth: {
    getClaims: () => Promise<unknown>;
  };
}

function parseBoundedResultCode<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Password recovery session response is invalid.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 1 ||
    keys[0] !== 'resultCode' ||
    typeof record.resultCode !== 'string' ||
    !allowed.includes(record.resultCode as T)
  ) {
    throw new Error('Password recovery session response is invalid.');
  }
  return record.resultCode as T;
}

export function parseRecoveryRegistrationResult(value: unknown): RecoveryRegistrationResultCode {
  return parseBoundedResultCode(value, [
    'REGISTERED',
    'ALREADY_REGISTERED',
    'SESSION_NOT_FOUND',
    'SESSION_USER_MISMATCH',
    'VALIDATION_FAILED',
  ] as const);
}

export function parseRecoverySessionState(value: unknown): RecoverySessionState {
  return parseBoundedResultCode(value, [
    'RECOVERY_SESSION',
    'NOT_REGISTERED',
    'INVALID_CONTEXT',
  ] as const);
}

export async function registerPasswordRecoverySession(
  client: RecoveryRpcClient,
  claims: VerifiedAuthClaims,
): Promise<RecoveryRegistrationResultCode> {
  const { data, error } = await client.rpc(REGISTER_PASSWORD_RECOVERY_SESSION_RPC, {
    p_session_id: claims.sessionId,
    p_auth_user_id: claims.userId,
  });
  if (error) throw new Error('Password recovery session registration failed.');
  return parseRecoveryRegistrationResult(data);
}

export async function getCurrentPasswordRecoverySessionState(
  client: RecoveryRpcClient,
): Promise<RecoverySessionState> {
  const { data, error } = await client.rpc(GET_CURRENT_PASSWORD_RECOVERY_SESSION_STATE_RPC);
  if (error) throw new Error('Password recovery session lookup failed.');
  return parseRecoverySessionState(data);
}

/**
 * Exact verified recovery-entry provenance. Local custom TokenHash recovery
 * (`verifyOtp({ type: 'recovery' })`) proves `otp`, and Supabase's documented `amr` contract also
 * defines `recovery`, which the hosted default-template PKCE exchange emits. Each is accepted only
 * as the sole verified method - never by prefix, substring, or within a mixed set.
 */
const RECOVERY_ENTRY_METHODS: readonly string[] = ['otp', 'recovery'];

export function hasRecoveryAcceptanceProvenance(claims: VerifiedAuthClaims): boolean {
  return (
    claims.authenticationMethods.length === 1 &&
    RECOVERY_ENTRY_METHODS.includes(claims.authenticationMethods[0])
  );
}

export function hasSupportedAdminPasswordProvenance(claims: VerifiedAuthClaims): boolean {
  return claims.authenticationMethods.length === 1 && claims.authenticationMethods[0] === 'password';
}

export function isSuccessfulRecoveryRegistration(
  code: RecoveryRegistrationResultCode,
): boolean {
  return code === 'REGISTERED' || code === 'ALREADY_REGISTERED';
}

export async function getVerifiedPasswordRecoveryAccess(
  client: CurrentRecoveryClient,
): Promise<VerifiedAuthClaims | null> {
  try {
    const claims = parseClaimsResult(await client.auth.getClaims());
    const state = await getCurrentPasswordRecoverySessionState(client);
    const context = await inspectRecoveryContextForSession(claims.userId, claims.sessionId);
    return state === 'RECOVERY_SESSION' &&
      context === 'valid' &&
      hasRecoveryAcceptanceProvenance(claims)
      ? claims
      : null;
  } catch {
    return null;
  }
}

export function classifyAdminAuthenticationProvenance(input: {
  claims: VerifiedAuthClaims;
  recoveryState: RecoverySessionState;
  recoveryContext: RecoveryContextStatus;
}): AdminProvenanceDecision {
  if (input.recoveryState === 'RECOVERY_SESSION') return 'PASSWORD_RECOVERY_REQUIRED';
  if (input.recoveryState === 'INVALID_CONTEXT') return 'AUTHENTICATION_PROVENANCE_INVALID';
  if (input.recoveryContext !== 'absent') return 'AUTHENTICATION_PROVENANCE_INVALID';
  return hasSupportedAdminPasswordProvenance(input.claims)
    ? 'ALLOW_ADMIN'
    : 'AUTHENTICATION_PROVENANCE_INVALID';
}
