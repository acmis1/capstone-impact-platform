import { redirect } from 'next/navigation';
import { AuthPageShell } from '../../../components/auth/AuthPageShell';
import { Button } from '../../../components/ui/button';
import { RECOVERY_INVALID_CLEANUP_PATH } from '../../../auth/confirmationValidation';
import { getVerifiedPasswordRecoveryAccess } from '../../../auth/recoverySession';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { logoutAction } from '../../login/actions';
import { ResetPasswordForm } from './ResetPasswordForm';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage() {
  let allowed = false;
  try {
    const supabase = await createSupabaseServerClient();
    allowed = (await getVerifiedPasswordRecoveryAccess(supabase)) !== null;
  } catch {
    allowed = false;
  }

  if (!allowed) {
    redirect(RECOVERY_INVALID_CLEANUP_PATH);
  }

  return (
    <AuthPageShell
      title="Choose a new password"
      description="Use 12 to 128 characters. Your recovery session will end after the password is updated."
      footer="Your identity and email address are intentionally not displayed on this page."
    >
      <div className="space-y-4">
        <ResetPasswordForm />
        <form action={logoutAction}>
          <Button type="submit" variant="ghost" className="w-full">
            Cancel and return to sign in
          </Button>
        </form>
      </div>
    </AuthPageShell>
  );
}
