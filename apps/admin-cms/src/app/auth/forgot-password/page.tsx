import { AuthPageShell } from '../../../components/auth/AuthPageShell';
import { ForgotPasswordForm } from './ForgotPasswordForm';

export default function ForgotPasswordPage() {
  return (
    <AuthPageShell
      title="Reset your password"
      description="Enter your staff email address. If an account is eligible, Supabase will send a secure reset link."
      footer="For your privacy, this page does not confirm whether an account exists."
    >
      <ForgotPasswordForm />
    </AuthPageShell>
  );
}
