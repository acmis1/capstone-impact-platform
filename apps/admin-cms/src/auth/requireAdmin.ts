import 'server-only';

import { createSupabaseServerClient } from '../lib/supabase/server';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { AdminAuthError, AuthenticatedAdminContext } from './authTypes';
import { parseClaimsResult } from './claimsResult';
import { resolveAdminContextFromAuthUser } from './adminContext';
import { inspectRecoveryContextForSession, type RecoveryContextStatus } from './recoveryContext';
import {
  classifyAdminAuthenticationProvenance,
  getCurrentPasswordRecoverySessionState,
  type RecoverySessionState,
} from './recoverySession';
import type { VerifiedAuthClaims } from './claims';

export function enforceAdminRecoveryGate(
  claims: VerifiedAuthClaims,
  recoveryState: RecoverySessionState,
  recoveryContext: RecoveryContextStatus,
): void {
  const decision = classifyAdminAuthenticationProvenance({
    claims,
    recoveryState,
    recoveryContext,
  });
  if (decision === 'PASSWORD_RECOVERY_REQUIRED') {
    throw new AdminAuthError('PASSWORD_RECOVERY_REQUIRED', 'Password recovery must be completed.');
  }
  if (decision !== 'ALLOW_ADMIN') {
    throw new AdminAuthError(
      'AUTHENTICATION_PROVENANCE_INVALID',
      'Authentication cannot be used for administrative access.',
    );
  }
}

/**
 * Server-only helper that authenticates the user session and authorizes administrative privileges.
 * 
 * Trust order:
 * A. Resolve the cookie-bound session client.
 * B. Strictly parse the verified getClaims() identity, session, and AMR values.
 * C. Query durable recovery provenance and verify any signed recovery context.
 * D. Fail closed unless this is a supported password session with no recovery state.
 * E. Only then create the Admin client and resolve profile, roles, and permissions.
 */
export async function requireAdmin(): Promise<AuthenticatedAdminContext> {
  let supabaseSession;
  
  // A. Server session client creation boundary
  try {
    supabaseSession = await createSupabaseServerClient();
  } catch {
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  let claims: VerifiedAuthClaims;

  // B. Verified getClaims result validation boundary.
  try {
    const result = await supabaseSession.auth.getClaims();
    claims = parseClaimsResult(result);
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) throw err;
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  // C-E. Durable lookup, exact signed-context binding, and complete fail-closed provenance gate.
  let recoveryState: RecoverySessionState;
  let recoveryContext: RecoveryContextStatus;
  try {
    recoveryState = await getCurrentPasswordRecoverySessionState(supabaseSession);
    recoveryContext = await inspectRecoveryContextForSession(claims.userId, claims.sessionId);
  } catch {
    throw new AdminAuthError(
      'AUTHENTICATION_PROVENANCE_INVALID',
      'Authentication cannot be used for administrative access.',
    );
  }
  enforceAdminRecoveryGate(claims, recoveryState, recoveryContext);

  // F-G. Only an allowed password session may create the Admin client and resolve authority.
  try {
    const supabaseAdmin = createSupabaseAdminClient();
    return await resolveAdminContextFromAuthUser(claims.userId, supabaseAdmin);
  } catch (error) {
    if (error instanceof AdminAuthError) throw error;
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }
}
