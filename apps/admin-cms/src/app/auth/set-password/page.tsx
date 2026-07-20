import React from 'react';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { SetPasswordForm } from './SetPasswordForm';

export const dynamic = 'force-dynamic';

/**
 * Server component representing the protected Set Password page.
 * 
 * Rules:
 * - Requires a valid authenticated Supabase session.
 * - Redirects unauthenticated requests to /login immediately.
 * - Restricts access server-side before rendering the credential form.
 */
export default async function SetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login?error=SESSION_EXPIRED');
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
      }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h2 style={{ color: '#F3F4F6', fontSize: '1.5rem', fontWeight: 800, margin: '0 0 0.5rem 0' }}>
            Setup Password
          </h2>
          <p style={{ color: '#9CA3AF', fontSize: '0.85rem', margin: 0 }}>
            Establish credentials for: {user.email}
          </p>
        </div>

        <SetPasswordForm />

        <div style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#6B7280' }}>
          Password update terminates current session. You will be redirected to sign in afterward.
        </div>
      </div>
    </div>
  );
}
