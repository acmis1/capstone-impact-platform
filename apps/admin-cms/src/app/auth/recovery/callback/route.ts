import { type NextRequest, NextResponse } from 'next/server';
import {
  RECOVERY_FAILURE_PATH,
  RECOVERY_PASSWORD_PATH,
} from '../../../../auth/confirmationValidation';
import { resolveCanonicalPublicOrigin } from '../../../../auth/csrf';
import { issueRecoveryContextCookie } from '../../../../auth/recoveryContext';
import { createSupabaseServerClient } from '../../../../lib/supabase/server';

export const dynamic = 'force-dynamic';

const RECOVERY_CODE_MAX_LENGTH = 2048;
const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9._~-]+$/;

function secureResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}

export async function GET(request: NextRequest) {
  const publicOrigin = resolveCanonicalPublicOrigin(request.nextUrl.origin);
  if (!publicOrigin) {
    return secureResponse(
      new NextResponse('Password recovery could not be completed.', { status: 400 }),
    );
  }

  const redirectResponse = (path: string) =>
    secureResponse(NextResponse.redirect(new URL(path, publicOrigin), 303));
  const { searchParams } = request.nextUrl;
  const keys = Array.from(searchParams.keys());
  if (
    keys.length !== 1 ||
    keys[0] !== 'code' ||
    searchParams.getAll('code').length !== 1
  ) {
    return redirectResponse(RECOVERY_FAILURE_PATH);
  }

  const code = searchParams.get('code');
  if (
    !code ||
    code.trim() !== code ||
    code.length > RECOVERY_CODE_MAX_LENGTH ||
    !RECOVERY_CODE_PATTERN.test(code)
  ) {
    return redirectResponse(RECOVERY_FAILURE_PATH);
  }

  let success = false;
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>> | null = null;
  try {
    supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user && data.session) {
      await issueRecoveryContextCookie(data.user.id);
      success = true;
    }
  } catch {
    success = false;
  }

  if (!success && supabase) {
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Best-effort cleanup of a partially established recovery session.
    }
  }

  return redirectResponse(success ? RECOVERY_PASSWORD_PATH : RECOVERY_FAILURE_PATH);
}
