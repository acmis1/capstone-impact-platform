import { NextResponse, type NextRequest } from 'next/server';
import {
  evaluateStagingMaintenanceGate,
  stagingMaintenanceUnavailableResponse,
} from './security/stagingMaintenanceGate';

/**
 * Executed Next.js 16 Proxy entry point.
 *
 * Next resolves the proxy/middleware convention file by scanning `path.join(appDir, '..')`. This
 * application keeps its App Router at `src/app`, so that scan directory is `src/` and only
 * `src/proxy.ts` is ever detected. The pre-existing root-level `apps/admin-cms/proxy.ts` is
 * outside the scanned directory and therefore does not run — verified both by reading Next's own
 * build-time detection and by observing a production `next start` build, where a gate placed only
 * at the root had no effect and the identical gate placed here returned 503.
 *
 * Consequences, stated rather than silently repaired:
 *
 * - The rollout maintenance gate must live here to exist at all, so this file is the additional
 *   boundary the gate needs. It fails closed and ends a blocked request before updateSession(),
 *   before any Supabase Auth session refresh, before requireAdmin(), before any database read or
 *   service-role client construction, and before any route handler or Server Action runs.
 * - `updateSession()` has consequently never executed in this application. That is a pre-existing
 *   defect, not one this change introduces, and it is deliberately left alone: restoring proxy
 *   session refresh alters live authentication behaviour and belongs in its own reviewed change,
 *   not in an operational control shipped for a migration window. This file therefore does not
 *   call it, and with maintenance disabled it is a transparent pass-through that leaves current
 *   request behaviour exactly as it is today.
 *
 * The root file keeps the same gate wiring so the two entry points state one contract and the
 * gate survives any later relocation.
 */
export async function proxy(request: NextRequest) {
  const maintenance = evaluateStagingMaintenanceGate({
    method: request.method,
    pathname: request.nextUrl.pathname,
  });
  if (maintenance === 'BLOCKED') {
    return stagingMaintenanceUnavailableResponse();
  }

  return NextResponse.next();
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
