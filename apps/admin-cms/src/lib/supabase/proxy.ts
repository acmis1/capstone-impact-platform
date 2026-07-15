import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getPublicEnv } from '../env';

/**
 * Validates and refreshes the Supabase Auth session inside Next.js Middleware.
 * 
 * Rules:
 * - Updates request and response cookies to maintain an active session.
 * - Call supabase.auth.getUser() to trigger session refresh and token verification.
 * - Excludes static assets from processing (managed by matcher in middleware).
 * - Do not rely on this proxy as the sole authorization boundary.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const publicEnv = getPublicEnv();

  const supabase = createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublicKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Validate token integrity and refresh session cookie
  await supabase.auth.getUser();

  return response;
}
