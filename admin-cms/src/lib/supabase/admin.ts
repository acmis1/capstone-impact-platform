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
 * - The SUPABASE_SECRET_KEY (or sb_secret_... key) is server-side only. It must never be used in browser code.
 * - It provides elevated backend access and bypasses RLS through the service role.
 * - Legacy service_role JWT keys may be used only as optional staging fallback.
 * - Under no circumstances should the secret key be exposed to browsers.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  if (adminInstance) {
    return adminInstance;
  }

  const serverEnv = getServerEnv();

  adminInstance = createClient(
    serverEnv.supabaseUrl,
    serverEnv.supabaseSecretKey
  );

  return adminInstance;
}
