import { type NextRequest, NextResponse } from 'next/server';
import {
  validateConfirmationParams,
  INVITATION_COOKIE_NAME,
  INVITATION_COOKIE_PATH,
  INVITATION_COOKIE_MAX_AGE_SECONDS,
  INVITATION_ACCEPT_PATH
} from '../../../auth/invitationValidation';

export const dynamic = 'force-dynamic';

/**
 * Server-side Route Handler that captures invitation query params,
 * stores the token hash in a secure HttpOnly cookie, and redirects
 * to the explicit acceptance page to protect against email-link prefetching.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const { searchParams } = url;

  // Local helper to decorate response with required security headers
  function secureResponse(res: NextResponse): NextResponse {
    res.headers.set('Cache-Control', 'no-store, max-age=0');
    res.headers.set('Pragma', 'no-cache');
    res.headers.set('Referrer-Policy', 'no-referrer');
    res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res;
  }

  // Local helper to expire the stale cookie
  function expireCookie(res: NextResponse): void {
    res.cookies.set(INVITATION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: INVITATION_COOKIE_PATH,
      maxAge: 0,
      secure: process.env.NODE_ENV === 'production',
    });
  }

  // Parameter keys and duplicates verification
  const allowedParams = ['token_hash', 'type', 'next'];
  for (const key of Array.from(searchParams.keys())) {
    if (!allowedParams.includes(key) || searchParams.getAll(key).length > 1) {
      const failRes = NextResponse.redirect(new URL('/login?error=INVALID_PARAMETERS', request.url), 303);
      expireCookie(failRes);
      return secureResponse(failRes);
    }
  }

  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next');

  // Enforce parameter validation rules
  const validation = validateConfirmationParams({ tokenHash: token_hash, type, next });

  if (!validation.isValid) {
    const errorClassification = validation.error || 'INVALID_PARAMETERS';
    const failRes = NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorClassification)}`, request.url),
      303
    );
    expireCookie(failRes);
    return secureResponse(failRes);
  }

  // Construct redirect to clean acceptance page
  const successRes = NextResponse.redirect(new URL(INVITATION_ACCEPT_PATH, request.url), 303);
  secureResponse(successRes);

  // Store trimmed token hash in secure HttpOnly cookie
  successRes.cookies.set(INVITATION_COOKIE_NAME, (token_hash as string).trim(), {
    httpOnly: true,
    sameSite: 'lax',
    path: INVITATION_COOKIE_PATH,
    maxAge: INVITATION_COOKIE_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  });

  return successRes;
}
