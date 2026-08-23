import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import {
  assertVerifiedStagingRuntime,
  type StagingRuntimeEnvironment,
} from '../security/stagingRuntimeIdentity';

export type PublicationExecutionTarget = 'local' | 'staging';

export const STAGING_PUBLICATION_ENABLED_VAR = 'CAPSTONE_STAGING_PUBLICATION_ENABLED';

/** Only an exact server-side `true` enables the staging publication capability. */
export function isStagingPublicationEnabledValue(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/**
 * Proves the web application is explicitly enabled for publication and bound to the configured
 * non-production staging target. The actual Supabase URL used by the publication client is passed
 * into the shared identity guard, so a client cannot select or override the target.
 */
export function assertStagingPublicationExecutionAvailable(
  supabaseUrl: string,
  env: StagingRuntimeEnvironment = process.env,
): void {
  if (!isStagingPublicationEnabledValue(env[STAGING_PUBLICATION_ENABLED_VAR])) {
    throw new Error('Staging publication execution is not enabled.');
  }

  assertVerifiedStagingRuntime({
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  });
}

export function isStagingPublicationExecutionAvailable(
  supabaseUrl: string,
  env: StagingRuntimeEnvironment = process.env,
): boolean {
  try {
    assertStagingPublicationExecutionAvailable(supabaseUrl, env);
    return true;
  } catch {
    return false;
  }
}

/** Named fail-closed targets only; there is deliberately no unrestricted execution mode. */
export function assertPublicationExecutionTarget(params: {
  target: PublicationExecutionTarget;
  supabaseUrl: string;
  env?: StagingRuntimeEnvironment;
}): void {
  if (params.target === 'local') {
    if (!isLoopbackUrl(params.supabaseUrl)) {
      throw new Error('Controlled publication requires a proven loopback Supabase environment.');
    }
    return;
  }

  assertStagingPublicationExecutionAvailable(params.supabaseUrl, params.env);
}
