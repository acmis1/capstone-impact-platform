import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getServerEnv, type ServerEnv } from '../env';

// Cache core admin instance to prevent multiple client instantiations
let adminInstance: SupabaseClient | null = null;

export type SupabaseAdminServerEnvironment = Pick<
  ServerEnv,
  'supabaseUrl' | 'supabaseDatabaseAdminKey'
>;

/** Constructs an uncached client from one already-resolved immutable server environment. */
export function createSupabaseAdminClientCoreForServerEnv(
  serverEnv: SupabaseAdminServerEnvironment,
): SupabaseClient {
  return createClient(serverEnv.supabaseUrl, serverEnv.supabaseDatabaseAdminKey);
}

/**
 * Shared administrative client creator decoupled from server-only checks.
 * Bypasses RLS utilizing the resolved database admin key.
 */
export function createSupabaseAdminClientCore(): SupabaseClient {
  if (adminInstance) {
    return adminInstance;
  }

  const serverEnv = getServerEnv();

  adminInstance = createSupabaseAdminClientCoreForServerEnv(serverEnv);

  return adminInstance;
}
