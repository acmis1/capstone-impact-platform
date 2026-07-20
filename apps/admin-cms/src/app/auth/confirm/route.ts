import { type NextRequest, NextResponse } from 'next/server';
import { validateConfirmationParams } from '../../../auth/invitationValidation';

export const dynamic = 'force-dynamic';

/**
 * Server-side Route Handler that captures invitation query params,
 * stores the token hash in a secure HttpOnly cookie, and redirects
 * to the explicit acceptance page to protect against email-link prefetching.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const { searchParams } = url;

  // Reject unexpected query-parameter names or duplicate keys
  const allowedParams = ['token_hash', 'type', 'next'];
  for (const key of Array.from(searchParams.keys())) {
    if (!allowedParams.includes(key)) {
      return NextResponse.redirect(new URL('/login?error=INVALID_PARAMETERS', request.url), 303);
    }
    if (searchParams.getAll(key).length > 1) {
      return NextResponse.redirect(new URL('/login?error=INVALID_PARAMETERS', request.url), 303);
    }
  }

  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next');

  // Enforce parameter validation rules
  const validation = validateConfirmationParams({ tokenHash: token_hash, type, next });

  if (!validation.isValid) {
    const errorClassification = validation.error || 'INVALID_PARAMETERS';
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorClassification)}`, request.url),
      303
    );
  }

  // Construct redirect to clean acceptance page
  const response = NextResponse.redirect(new URL('/auth/confirm/accept', request.url), 303);

  // Set prefetch-prevention headers
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');

  // Store trimmed token hash in secure HttpOnly cookie
  response.cookies.set('capstone_invitation_token_hash', (token_hash as string).trim(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/auth/confirm',
    maxAge: 600, // 10 minutes maximum
    secure: process.env.NODE_ENV === 'production',
  });

  return response;
}
