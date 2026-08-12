import { isLoopbackUrl } from '../local-development/localEnvironmentFile';

/** Local publication is available only when the configured Supabase API is loopback. */
export function isLocalPublicationExecutionAvailable(supabaseUrl: string): boolean {
  return isLoopbackUrl(supabaseUrl);
}
