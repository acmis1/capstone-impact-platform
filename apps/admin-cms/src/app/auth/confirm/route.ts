import { type NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { validateConfirmationParams } from '../../../auth/invitationValidation';

export const dynamic = 'force-dynamic';

/**
 * Server-side route handler to verify Supabase invitation tokens.
 * 
 * Rules:
 * - Accepts only token_hash, type, next.
 * - Requires type=invite.
 * - Validates next path against allow-list to prevent open redirect.
 * - Invokes verifyOtp server-side.
 * - Relies on SSR cookies storage.
 * - Never logs or redirects raw secrets, tokens, or PII.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next');

  const validation = validateConfirmationParams({ tokenHash: token_hash, type, next });

  if (!validation.isValid || !validation.data) {
    const errorClassification = validation.error || 'INVALID_PARAMETERS';
    redirect(`/login?error=${encodeURIComponent(errorClassification)}`);
  }

  const { tokenHash, type: validatedType, next: safeNext } = validation.data;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({
      type: validatedType,
      token_hash: tokenHash,
    });

    if (error) {
      redirect('/login?error=VERIFICATION_FAILED');
    }
  } catch {
    redirect('/login?error=VERIFICATION_FAILED');
  }

  redirect(safeNext);
}
