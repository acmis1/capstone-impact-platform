import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getServerEnv } from '../env';

// Cache core admin instance to prevent multiple client instantiations
let adminInstance: SupabaseClient | null = null;

/**
 * Shared administrative client creator decoupled from server-only checks.
 * Bypasses RLS utilizing the resolved database admin key.
 */
export function createSupabaseAdminClientCore(): SupabaseClient {
  if (adminInstance) {
    return adminInstance;
  }

  const serverEnv = getServerEnv();

  adminInstance = createClient(
    serverEnv.supabaseUrl,
    serverEnv.supabaseDatabaseAdminKey
  );

  return adminInstance;
}
