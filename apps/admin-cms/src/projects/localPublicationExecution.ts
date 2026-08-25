import { isLoopbackUrl } from '../local-development/localEnvironmentFile';

/** Local publication is available only when the configured Supabase API is loopback. */
export function isLocalPublicationExecutionAvailable(supabaseUrl: string): boolean {
  return isLoopbackUrl(supabaseUrl);
}

export const LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED_VAR = 'CAPSTONE_LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED';

/**
 * Rollback has a stronger identity boundary than ordinary Local publication: loopback alone is
 * insufficient. The server process must also declare the Local runtime and explicitly enable
 * this disposable-only capability. The database head independently defaults rollback disabled.
 */
export function isLocalPublicFeedRollbackAvailable(
  supabaseUrl: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isLoopbackUrl(supabaseUrl)
    && env.CAPSTONE_RUNTIME_ENV?.trim().toLowerCase() === 'local'
    && env[LOCAL_PUBLIC_FEED_ROLLBACK_ENABLED_VAR]?.trim().toLowerCase() === 'true';
}
