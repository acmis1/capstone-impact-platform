import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getPublicEnv } from '../env';

// Cache browser client instance to prevent multiple client creations in Next.js runtime
let clientInstance: SupabaseClient | null = null;

/**
 * Creates and retrieves a browser-safe Supabase Client.
 * 
 * Rules:
 * - Only utilizes client-safe public keys validated at runtime.
 * - Under no circumstances does this connection load the SUPABASE_SERVICE_ROLE_KEY.
 * - Throws a clear runtime configuration error if client variables are unconfigured.
 */
export function createSupabaseBrowserClient(): SupabaseClient {
  if (clientInstance) {
    return clientInstance;
  }

  const publicEnv = getPublicEnv();

  clientInstance = createClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  return clientInstance;
}
