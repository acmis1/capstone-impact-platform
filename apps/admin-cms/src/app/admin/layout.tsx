import React from 'react';
import { requireAdmin } from '../../auth/requireAdmin';
import { logoutAction } from '../login/actions';
import { redirect } from 'next/navigation';
import { AdminAuthError } from '../../auth/authTypes';
import { getPublicAuthErrorMessage } from '../../auth/authHttp';

/**
 * Server Component layout serving as authorization guard for all administrative sub-pages.
 * 
 * Rules:
 * - Enforces session requirements and admin role provisioning before children render.
 * - Displays the current administrator's credentials and assigned roles.
 * - Provides a server action trigger to handle secure logouts.
 * - Maps all authorization/connection errors to generic, production-safe messages.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let adminContext;
  try {
    adminContext = await requireAdmin();
  } catch (error: unknown) {
    if (error instanceof AdminAuthError) {
      if (error.type === 'UNAUTHENTICATED') {
        redirect('/login?redirectTo=/admin');
      }

      const publicMessage = getPublicAuthErrorMessage(error.type);
      const isConfigFailure = error.type === 'CONFIGURATION_FAILURE';
      const heading = isConfigFailure ? 'Service Outage' : 'Access Denied';

      // Safe error screen for unprovisioned/unauthorized authenticated identities
      return (
        <div style={{
          minHeight: '100vh',
          backgroundColor: '#0B0F19',
          color: '#F3F4F6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Inter, system-ui, sans-serif',
          padding: '2rem',
        }}>
          <div style={{
            backgroundColor: '#111827',
            border: '1px solid #1F2937',
            borderRadius: '12px',
            padding: '2.5rem',
            maxWidth: '500px',
            width: '100%',
            textAlign: 'center',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
          }}>
            <h1 style={{ color: '#EF4444', fontSize: '1.5rem', fontWeight: 800, margin: '0 0 1rem 0' }}>
              {heading}
            </h1>
            <p style={{ color: '#9CA3AF', fontSize: '0.9rem', lineHeight: '1.6', marginBottom: '1.5rem' }}>
              {publicMessage}
            </p>
            <form action={logoutAction}>
              <button type="submit" style={{
                backgroundColor: '#374151',
                color: '#F9FAFB',
                border: 'none',
                borderRadius: '6px',
                padding: '0.6rem 1.2rem',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}>
                Sign Out
              </button>
            </form>
          </div>
        </div>
      );
    }

    // Default safety fallback for unknown exceptions (redirect safely or show internal error message)
    const publicMessage = getPublicAuthErrorMessage('UNKNOWN');
    return (
      <div style={{
        minHeight: '100vh',
        backgroundColor: '#0B0F19',
        color: '#F3F4F6',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: '2rem',
      }}>
        <div style={{
          backgroundColor: '#111827',
          border: '1px solid #1F2937',
          borderRadius: '12px',
          padding: '2.5rem',
          maxWidth: '500px',
          width: '100%',
          textAlign: 'center',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
        }}>
          <h1 style={{ color: '#EF4444', fontSize: '1.5rem', fontWeight: 800, margin: '0 0 1rem 0' }}>
            System Error
          </h1>
          <p style={{ color: '#9CA3AF', fontSize: '0.9rem', lineHeight: '1.6', marginBottom: '1.5rem' }}>
            {publicMessage}
          </p>
          <form action={logoutAction}>
            <button type="submit" style={{
              backgroundColor: '#374151',
              color: '#F9FAFB',
              border: 'none',
              borderRadius: '6px',
              padding: '0.6rem 1.2rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}>
              Sign Out
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      color: '#F3F4F6',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      {/* Header bar presenting context */}
      <header style={{
        backgroundColor: '#111827',
        borderBottom: '1px solid #1F2937',
        padding: '1rem 2rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <span style={{ fontWeight: 800, fontSize: '1.1rem', letterSpacing: '0.05em', color: '#E61E2A' }}>
            RMIT CAPSTONE
          </span>
          <span style={{ color: '#374151' }}>|</span>
          <span style={{ color: '#9CA3AF', fontSize: '0.85rem' }}>Staging Workspace</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#F3F4F6' }}>
              {adminContext.fullName || adminContext.email}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#9CA3AF' }}>
              {adminContext.roles.map((r) => r.toUpperCase()).join(', ')}
            </div>
          </div>

          <form action={logoutAction}>
            <button type="submit" style={{
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              color: '#F87171',
              borderRadius: '6px',
              padding: '0.4rem 0.8rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background-color 0.2s',
            }}>
              Log Out
            </button>
          </form>
        </div>
      </header>

      {/* Main page content wrapper */}
      <div style={{ padding: '2rem' }}>
        {children}
      </div>
    </div>
  );
}
