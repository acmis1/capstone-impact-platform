import { type NextRequest, NextResponse } from 'next/server';
import {
  type ConfirmationType,
  getConfirmationFlow,
  validateConfirmationParams,
  INVITATION_COOKIE_NAME,
  INVITATION_COOKIE_PATH,
  RECOVERY_TOKEN_COOKIE_NAME,
  RECOVERY_TOKEN_COOKIE_PATH,
  RECOVERY_FAILURE_PATH,
} from '../../../auth/confirmationValidation';
import { resolveCanonicalPublicOrigin } from '../../../auth/csrf';

export const dynamic = 'force-dynamic';

/**
 * Captures a validated invitation or recovery token hash into its dedicated HttpOnly cookie,
 * then redirects to the matching explicit acceptance page without consuming the token.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const publicOrigin = resolveCanonicalPublicOrigin(request.nextUrl.origin);

  // Local helper to decorate response with required security headers
  function secureResponse(res: NextResponse): NextResponse {
    res.headers.set('Cache-Control', 'no-store, max-age=0');
    res.headers.set('Pragma', 'no-cache');
    res.headers.set('Referrer-Policy', 'no-referrer');
    res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res;
  }

  function expireCookie(res: NextResponse, name: string, path: string): void {
    res.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      path,
      maxAge: 0,
      secure: process.env.NODE_ENV === 'production',
    });
  }

  function expireRelevantCookies(res: NextResponse, requestedType: string | null): void {
    if (requestedType === 'invite') {
      expireCookie(res, INVITATION_COOKIE_NAME, INVITATION_COOKIE_PATH);
      return;
    }
    if (requestedType === 'recovery') {
      expireCookie(res, RECOVERY_TOKEN_COOKIE_NAME, RECOVERY_TOKEN_COOKIE_PATH);
      return;
    }
    expireCookie(res, INVITATION_COOKIE_NAME, INVITATION_COOKIE_PATH);
    expireCookie(res, RECOVERY_TOKEN_COOKIE_NAME, RECOVERY_TOKEN_COOKIE_PATH);
  }

  if (!publicOrigin) {
    const failClosed = new NextResponse('Authentication request could not be completed.', {
      status: 400,
    });
    expireRelevantCookies(failClosed, searchParams.get('type'));
    return secureResponse(failClosed);
  }

  const redirectUrl = (path: string) => new URL(path, publicOrigin);
  const requestedType = searchParams.get('type');
  const failurePath = (error: string) =>
    requestedType === 'recovery'
      ? RECOVERY_FAILURE_PATH
      : `/login?error=${encodeURIComponent(error)}`;

  // Parameter keys and duplicates verification
  const allowedParams = ['token_hash', 'type', 'next'];
  for (const key of Array.from(searchParams.keys())) {
    if (!allowedParams.includes(key) || searchParams.getAll(key).length > 1) {
      const failRes = NextResponse.redirect(redirectUrl(failurePath('INVALID_PARAMETERS')), 303);
      expireRelevantCookies(failRes, requestedType);
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
    const failRes = NextResponse.redirect(redirectUrl(failurePath(errorClassification)), 303);
    expireRelevantCookies(failRes, requestedType);
    return secureResponse(failRes);
  }

  const confirmationType = validation.type as ConfirmationType;
  const flow = getConfirmationFlow(confirmationType);
  const successRes = NextResponse.redirect(redirectUrl(flow.acceptPath), 303);
  secureResponse(successRes);

  successRes.cookies.set(flow.cookieName, (token_hash as string).trim(), {
    httpOnly: true,
    sameSite: 'lax',
    path: flow.cookiePath,
    maxAge: flow.cookieMaxAgeSeconds,
    secure: process.env.NODE_ENV === 'production',
  });

  return successRes;
}
