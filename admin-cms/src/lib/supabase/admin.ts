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
 * - Under no circumstances should the SUPABASE_SERVICE_ROLE_KEY be exposed to browsers.
 * - Bypasses database Row-Level Security (RLS) entirely for administrative operations.
 * - Staging only for now.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  if (adminInstance) {
    return adminInstance;
  }

  const serverEnv = getServerEnv();

  adminInstance = createClient(
    serverEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv.SUPABASE_SERVICE_ROLE_KEY
  );

  return adminInstance;
}
