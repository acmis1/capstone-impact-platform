import { isLoopbackUrl } from '../local-development/localEnvironmentFile';
import {
  assertVerifiedProductionRuntime,
  assertVerifiedStagingRuntime,
  type StagingRuntimeEnvironment,
} from '../security/stagingRuntimeIdentity';

export type PublicationExecutionTarget = 'local' | 'staging' | 'production';

export const STAGING_PUBLICATION_ENABLED_VAR = 'CAPSTONE_STAGING_PUBLICATION_ENABLED';
export const PRODUCTION_PUBLICATION_ENABLED_VAR = 'CAPSTONE_PRODUCTION_PUBLICATION_ENABLED';

/** Only an exact server-side `true` enables the staging publication capability. */
export function isStagingPublicationEnabledValue(value: string | undefined | null): boolean {
  return value === 'true';
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

/** Only an exact server-side `true` enables the production publication capability. */
export function isProductionPublicationEnabledValue(value: string | undefined | null): boolean {
  return value === 'true';
}

export function assertProductionPublicationExecutionAvailable(
  supabaseUrl: string,
  env: StagingRuntimeEnvironment = process.env,
): void {
  if (!isProductionPublicationEnabledValue(env[PRODUCTION_PUBLICATION_ENABLED_VAR])) {
    throw new Error('Production publication execution is not enabled.');
  }

  assertVerifiedProductionRuntime({
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  });
}

export function isProductionPublicationExecutionAvailable(
  supabaseUrl: string,
  env: StagingRuntimeEnvironment = process.env,
): boolean {
  try {
    assertProductionPublicationExecutionAvailable(supabaseUrl, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves only a server-proven named execution target. The order preserves existing Local and
 * staging behavior, while each hosted branch still requires its own exact identity and flag.
 */
export function resolvePublicationExecutionTarget(
  supabaseUrl: string,
  env: StagingRuntimeEnvironment = process.env,
): PublicationExecutionTarget | null {
  if (env.CAPSTONE_RUNTIME_ENV === 'staging') {
    return isStagingPublicationExecutionAvailable(supabaseUrl, env) ? 'staging' : null;
  }
  if (env.CAPSTONE_RUNTIME_ENV === 'production') {
    return isProductionPublicationExecutionAvailable(supabaseUrl, env) ? 'production' : null;
  }
  if (isLoopbackUrl(supabaseUrl)) return 'local';
  return null;
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

  if (params.target === 'staging') {
    assertStagingPublicationExecutionAvailable(params.supabaseUrl, params.env);
    return;
  }

  if (params.target === 'production') {
    assertProductionPublicationExecutionAvailable(params.supabaseUrl, params.env);
    return;
  }

  throw new Error('Controlled publication requires a recognized execution target.');
}
