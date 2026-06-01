import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClientCore } from './adminCore';

/**
 * ⚠️ WARNING: SECURE SERVER-ONLY SUPABASE ADMIN FACTORY
 * 
 * - This module is explicitly designated server-only via 'server-only' imports.
 * - NEVER import or execute this module inside client-side components.
 * - Under no circumstances should the admin key be exposed to browsers.
 * - Enforces server-only boundary, wrapping the shared admin client core creator.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  return createSupabaseAdminClientCore();
}
