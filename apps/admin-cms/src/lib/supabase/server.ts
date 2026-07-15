import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getPublicEnv } from '../env';

/**
 * Creates a server-side Supabase Client bound to Next.js cookie storage.
 * 
 * Rules:
 * - Never uses the administrative service-role or secret key.
 * - Restricts access to standard session identity.
 * - Supports Server Components, Server Actions, and Route Handlers.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const publicEnv = getPublicEnv();

  return createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublicKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignore cookie changes if called from Server Components
          }
        },
      },
    }
  );
}
