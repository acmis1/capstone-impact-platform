import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AuthPageShell } from '../../../../components/auth/AuthPageShell';
import { Button } from '../../../../components/ui/button';
import {
  RECOVERY_FAILURE_PATH,
  RECOVERY_TOKEN_COOKIE_NAME,
} from '../../../../auth/confirmationValidation';
import { acceptRecoveryAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function AcceptRecoveryPage() {
  const cookieStore = await cookies();
  if (!cookieStore.has(RECOVERY_TOKEN_COOKIE_NAME)) {
    redirect(RECOVERY_FAILURE_PATH);
  }

  return (
    <AuthPageShell
      title="Continue password reset"
      description="Confirm that you want to continue. Your reset link is not used until you press the button below."
      footer="This explicit step protects reset links from automated email-link previews."
    >
      <form action={acceptRecoveryAction} className="flex flex-col gap-4">
        <Button type="submit" size="lg" className="w-full">
          Continue to reset password
        </Button>
        <Link
          href="/login"
          className="rounded-sm text-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Back to sign in
        </Link>
      </form>
    </AuthPageShell>
  );
}
