import 'server-only';

import { createSupabaseServerClient } from '../lib/supabase/server';
import { createSupabaseAdminClient } from '../lib/supabase/admin';
import { AdminAuthError, AuthenticatedAdminContext } from './authTypes';
import { parseClaimsResult } from './claimsResult';
import { resolveAdminContextFromAuthUser } from './adminContext';
import { inspectRecoveryContextForClient } from './recoveryContext';

export function enforceAdminRecoveryGate(
  recoveryContext: Awaited<ReturnType<typeof inspectRecoveryContextForClient>>,
): void {
  if (recoveryContext !== 'absent') {
    throw new AdminAuthError('PASSWORD_RECOVERY_REQUIRED', 'Password recovery must be completed.');
  }
}

/**
 * Server-only helper that authenticates the user session and authorizes administrative privileges.
 * 
 * Flow:
 * A. Resolves Server session client (failures map to CONFIGURATION_FAILURE).
 * B. Triggers getClaims() and validates claims envelope (failures map to UNAUTHENTICATED or CONFIGURATION_FAILURE).
 * C. Queries database admin profile (failures map to CONFIGURATION_FAILURE).
 * D. Checks admin provisioning (failures map to ADMIN_NOT_PROVISIONED).
 * E. Verifies user roles and permissions (failures map to PERMISSION_DENIED).
 */
export async function requireAdmin(): Promise<AuthenticatedAdminContext> {
  let supabaseSession;
  
  // A. Server session client creation boundary
  try {
    supabaseSession = await createSupabaseServerClient();
  } catch {
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  let authUserId: string;

  // B & C. getClaims result validation & execution boundary
  try {
    const recoveryContext = await inspectRecoveryContextForClient(supabaseSession);
    enforceAdminRecoveryGate(recoveryContext);

    const result = await supabaseSession.auth.getClaims();
    authUserId = parseClaimsResult(result);
  } catch (err: unknown) {
    if (err instanceof AdminAuthError) throw err;
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }

  // D-G. Resolve the linked administrator profile, recognized roles, and exact permission union.
  try {
    const supabaseAdmin = createSupabaseAdminClient();
    return await resolveAdminContextFromAuthUser(authUserId, supabaseAdmin);
  } catch (error) {
    if (error instanceof AdminAuthError) throw error;
    throw new AdminAuthError('CONFIGURATION_FAILURE', 'Authentication service unavailable.');
  }
}
