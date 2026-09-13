import {
  isLocalPublicFeedRollbackAvailable,
  type LocalPublicationEnvironment,
} from './localPublicationExecution';
import { assertVerifiedStagingRuntime } from '../security/stagingRuntimeIdentity';

export const STAGING_PUBLIC_FEED_ROLLBACK_ENABLED_VAR =
  'CAPSTONE_STAGING_PUBLIC_FEED_ROLLBACK_ENABLED';

export type PublicFeedRollbackExecutionTarget = 'local' | 'staging';

/**
 * Proves a named rollback environment. Local retains its existing loopback + explicit-flag
 * contract. Staging additionally requires the dedicated rollback flag and the canonical verified
 * staging Supabase identity. No production, live, or generic hosted target exists.
 */
export function assertPublicFeedRollbackEnvironmentAvailable(
  supabaseUrl: string,
  env: LocalPublicationEnvironment = process.env,
): PublicFeedRollbackExecutionTarget {
  if (isLocalPublicFeedRollbackAvailable(supabaseUrl, env)) return 'local';

  if (env[STAGING_PUBLIC_FEED_ROLLBACK_ENABLED_VAR] !== 'true') {
    throw new Error('Public feed rollback execution is not enabled.');
  }

  assertVerifiedStagingRuntime({
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  });
  return 'staging';
}

/** Fail-closed boolean form for route handlers and server-rendered operator controls. */
export function isPublicFeedRollbackEnvironmentAvailable(
  supabaseUrl: string,
  env: LocalPublicationEnvironment = process.env,
): boolean {
  try {
    assertPublicFeedRollbackEnvironmentAvailable(supabaseUrl, env);
    return true;
  } catch {
    return false;
  }
}
