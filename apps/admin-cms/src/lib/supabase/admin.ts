import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getServerEnv } from '../env';

// Cache server admin instance
let adminInstance: SupabaseClient | null = null;

/**
 * ⚠️ WARNING: SECURE SERVER-ONLY SUPABASE ADMIN FACTORY
 * 
 * - This module is explicitly designated server-only via 'server-only' imports.
 * - NEVER import or execute this module inside client-side components.
 * - Under no circumstances should the admin key be exposed to browsers.
 * - For database admin operations (PostgREST requests), this prefers the legacy JWT-based
 *   SUPABASE_SERVICE_ROLE_KEY to bypass RLS, falling back to SUPABASE_SECRET_KEY.
 */
export function createSupabaseAdminClient(): SupabaseClient {
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
