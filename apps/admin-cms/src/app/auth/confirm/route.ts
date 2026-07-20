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
 * - Rejects unexpected query-parameter names.
 * - Requires type=invite.
 * - Enforces that next is absent or exactly /auth/set-password.
 * - Never uses caller input as the final redirect destination.
 * - Invokes redirect only outside try/catch blocks.
 * - Never logs or redirects raw secrets, tokens, or PII.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Reject unexpected query-parameter names
  const allowedParams = ['token_hash', 'type', 'next'];
  for (const key of Array.from(searchParams.keys())) {
    if (!allowedParams.includes(key)) {
      redirect('/login?error=INVALID_PARAMETERS');
    }
  }

  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next');

  // Perform parameter validation
  const validation = validateConfirmationParams({ tokenHash: token_hash, type, next });

  if (!validation.isValid) {
    const errorClassification = validation.error || 'INVALID_PARAMETERS';
    redirect(`/login?error=${encodeURIComponent(errorClassification)}`);
  }

  let verificationSuccess = false;

  // Execute OTP verification inside try/catch without calling redirect
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({
      type: 'invite',
      token_hash: (token_hash as string).trim(),
    });

    if (!error) {
      verificationSuccess = true;
    }
  } catch {
    verificationSuccess = false;
  }

  // Redirect based on verification outcome outside the try/catch block
  if (verificationSuccess) {
    redirect('/auth/set-password');
  } else {
    redirect('/login?error=VERIFICATION_FAILED');
  }
}
