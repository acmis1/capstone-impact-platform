import { type NextRequest } from 'next/server';
import { updateSession } from './src/lib/supabase/proxy';
import {
  evaluateStagingMaintenanceGate,
  stagingMaintenanceUnavailableResponse,
} from './src/security/stagingMaintenanceGate';

/**
 * Next.js 16 Proxy Entry Point.
 * Intercepts incoming requests to refresh or validate sessions.
 * Real authorization boundaries are managed within requireAdmin() and the routes.
 *
 * The rollout maintenance gate is evaluated first and fails closed. When it blocks, the request
 * ends here: before updateSession(), before any Supabase Auth session refresh, before
 * requireAdmin(), before any database read or service-role client, and before any route handler
 * or Server Action runs. It reads no schema, so it behaves identically while the database sits
 * at any migration state. When the gate is disabled it is a single string comparison and the
 * existing session behaviour is unchanged.
 */
export async function proxy(request: NextRequest) {
  const maintenance = evaluateStagingMaintenanceGate({
    method: request.method,
    pathname: request.nextUrl.pathname,
  });
  if (maintenance === 'BLOCKED') {
    return stagingMaintenanceUnavailableResponse();
  }

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
