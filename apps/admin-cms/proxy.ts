import { type NextRequest } from 'next/server';
import { updateSession } from './src/lib/supabase/proxy';

/**
 * Next.js 16 Proxy Entry Point.
 * Intercepts incoming requests to refresh or validate sessions.
 * Real authorization boundaries are managed within requireAdmin() and the routes.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - ordinary static image assets (svg, png, jpg, jpeg, gif, webp)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
