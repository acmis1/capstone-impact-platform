import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerEnv } from '../env';
import {
  createSupabaseAdminClientCore,
  createSupabaseAdminClientCoreForServerEnv,
} from './adminCore';

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

/**
 * Mutation-bound factory: the caller supplies the same resolved snapshot it already verified.
 * This deliberately bypasses the process-wide cached singleton so target A can never satisfy a
 * request whose immutable environment snapshot was verified for target B.
 */
export function createSupabaseAdminClientForServerEnv(
  serverEnv: Pick<ServerEnv, 'supabaseUrl' | 'supabaseDatabaseAdminKey'>,
): SupabaseClient {
  return createSupabaseAdminClientCoreForServerEnv(serverEnv);
}
