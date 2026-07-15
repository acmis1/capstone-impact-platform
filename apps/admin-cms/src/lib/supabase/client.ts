import { createBrowserClient } from '@supabase/ssr';
import { getPublicEnv } from '../env';

let clientInstance: ReturnType<typeof createBrowserClient> | null = null;

/**
 * Creates and retrieves a browser-safe Supabase Client.
 * 
 * Rules:
 * - Only utilizes client-safe public keys validated at runtime (sb_publishable_... or legacy anon).
 * - Under no circumstances does this connection load the SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.
 * - Never imports server-only environment modules.
 */
export function createSupabaseBrowserClient() {
  if (clientInstance) {
    return clientInstance;
  }

  const publicEnv = getPublicEnv();

  clientInstance = createBrowserClient(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublicKey
  );

  return clientInstance;
}
