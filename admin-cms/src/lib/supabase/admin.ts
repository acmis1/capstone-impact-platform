import { createClient } from '@supabase/supabase-js';
import { env } from '../env';

/**
 * ⚠️ WARNING: SERVER-SIDE ONLY CLIENT
 * 
 * - NEVER expose this client or the SUPABASE_SERVICE_ROLE_KEY to the browser.
 * - This client bypasses Row-Level Security (RLS) policies completely.
 * - Enforce RLS rules at the staging and database configurations; service role key bypasses RLS for operational convenience.
 * - This connection is designed for administrative backend jobs, sync tasks, and staging-only purposes.
 */
export const supabaseAdmin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-url.supabase.co',
  env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-role-key'
);
