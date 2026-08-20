import { isLoopbackUrl } from '../../local-development/localEnvironmentFile';
import { getServerEnv } from '../../lib/env';

/**
 * Checks whether assistive validation execution is supported in the current environment.
 *
 * Current Architecture Boundary (PP1 Phase 5):
 * The Phase 4 asynchronous coordinator and worker execution run strictly on local loopback infrastructure.
 * Hosted Admin/CMS environments can read historical/persisted assistive results, but cannot enqueue
 * active jobs because no hosted worker daemon is deployed.
 */
export function isAssistiveExecutionAvailable(supabaseUrl?: string): boolean {
  try {
    const url = supabaseUrl ?? getServerEnv().NEXT_PUBLIC_SUPABASE_URL;
    if (!url) return false;
    return isLoopbackUrl(url);
  } catch {
    return false;
  }
}
