import { type NextRequest, NextResponse } from 'next/server';
import { RECOVERY_FAILURE_PATH } from '../../../../auth/confirmationValidation';
import { resolveCanonicalPublicOrigin } from '../../../../auth/csrf';
import { clearRecoveryContextCookie } from '../../../../auth/recoveryContext';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';

export const dynamic = 'force-dynamic';

function secureResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}

export async function GET(request: NextRequest) {
  let terminated = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    terminated = error === null;
  } catch {
    terminated = false;
  }
  if (terminated) {
    try {
      await clearRecoveryContextCookie();
    } catch {
      // The signed context expires naturally after its bounded lifetime.
    }
  }

  const publicOrigin = resolveCanonicalPublicOrigin(request.nextUrl.origin);
  if (!publicOrigin) {
    return secureResponse(
      new NextResponse('Password recovery could not be completed.', { status: 400 }),
    );
  }
  return secureResponse(
    NextResponse.redirect(new URL(RECOVERY_FAILURE_PATH, publicOrigin), 303),
  );
}
