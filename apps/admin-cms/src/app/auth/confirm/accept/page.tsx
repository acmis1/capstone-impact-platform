import React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { acceptInvitationAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Server Component representing the explicit Acceptance Page.
 * 
 * Rules:
 * - Reads only the presence of the secure HttpOnly cookie.
 * - Redirects immediately to login if the cookie is missing.
 * - Performs no automatic execution, network checks, or token verification during render.
 * - Displays a generic security confirmation form.
 * - Renders zero token values or PII.
 */
export default async function AcceptInvitationPage() {
  const cookieStore = await cookies();
  const hasTokenCookie = cookieStore.has('capstone_invitation_token_hash');

  if (!hasTokenCookie) {
    redirect('/login?error=INVITATION_SESSION_MISSING');
  }

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '1.5rem',
    }}>
      <div style={{
        backgroundColor: '#111827',
        border: '1px solid #1F2937',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '440px',
        padding: '2.5rem',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
        textAlign: 'center'
      }}>
        <h2 style={{ color: '#F3F4F6', fontSize: '1.5rem', fontWeight: 800, marginBottom: '1rem' }}>
          Confirm Invitation
        </h2>
        <p style={{ color: '#9CA3AF', fontSize: '0.875rem', lineHeight: '1.5', marginBottom: '2rem' }}>
          Please click below to accept your invitation to the administrative console. This step verifies your email address and will direct you to set up your password.
        </p>

        <form action={acceptInvitationAction}>
          <button
            type="submit"
            style={{
              backgroundColor: '#E61E2A',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: '6px',
              padding: '0.85rem 1.5rem',
              fontSize: '1rem',
              fontWeight: 700,
              cursor: 'pointer',
              width: '100%',
              transition: 'background-color 0.2s',
            }}
          >
            Accept invitation
          </button>
        </form>

        <div style={{ marginTop: '2rem', fontSize: '0.75rem', color: '#6B7280' }}>
          By continuing, you establish a secure session to set your new credentials.
        </div>
      </div>
    </div>
  );
}
