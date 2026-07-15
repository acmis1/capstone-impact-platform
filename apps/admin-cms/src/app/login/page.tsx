'use client';

import React, { useActionState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { loginAction } from './actions';

function LoginForm() {
  const searchParams = useSearchParams();
  const redirectTo = searchParams ? (searchParams.get('next') || searchParams.get('redirectTo') || '/admin') : '/admin';

  const [state, formAction, isPending] = useActionState(loginAction, null);

  return (
    <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <input type="hidden" name="redirectTo" value={redirectTo} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label htmlFor="email" style={{ fontSize: '0.85rem', fontWeight: 600, color: '#9CA3AF' }}>
          Administrative Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="admin@example.local"
          style={{
            backgroundColor: '#1F2937',
            border: '1px solid #374151',
            borderRadius: '6px',
            color: '#F9FAFB',
            padding: '0.75rem',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color 0.2s',
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label htmlFor="password" style={{ fontSize: '0.85rem', fontWeight: 600, color: '#9CA3AF' }}>
          Security Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          style={{
            backgroundColor: '#1F2937',
            border: '1px solid #374151',
            borderRadius: '6px',
            color: '#F9FAFB',
            padding: '0.75rem',
            fontSize: '0.95rem',
            outline: 'none',
            transition: 'border-color 0.2s',
          }}
        />
      </div>

      {state?.error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: '#F87171',
          padding: '0.75rem',
          borderRadius: '6px',
          fontSize: '0.85rem',
          textAlign: 'center',
        }}>
          {state.error}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending}
        style={{
          backgroundColor: '#E61E2A',
          color: '#FFFFFF',
          border: 'none',
          borderRadius: '6px',
          padding: '0.75rem',
          fontSize: '0.95rem',
          fontWeight: 700,
          cursor: isPending ? 'not-allowed' : 'pointer',
          opacity: isPending ? 0.7 : 1,
          transition: 'background-color 0.2s',
        }}
      >
        {isPending ? 'Authenticating...' : 'Sign In to Console'}
      </button>
    </form>
  );
}

export default function LoginPage() {
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
            Admin/CMS Gateway
          </h2>
          <p style={{ color: '#9CA3AF', fontSize: '0.85rem', margin: 0 }}>
            Capstone Impact Platform — Staging Console Identity
          </p>
        </div>

        <Suspense fallback={<div style={{ color: '#9CA3AF', textAlign: 'center' }}>Loading form...</div>}>
          <LoginForm />
        </Suspense>

        <div style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#6B7280' }}>
          Restricted administrative access channel. Self-registration is disabled.
        </div>
      </div>
    </div>
  );
}
