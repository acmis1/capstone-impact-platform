import React from 'react';
import Link from 'next/link';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';
import BrowserImportPreviewClient from '../../../../components/imports/BrowserImportPreviewClient';

export const dynamic = 'force-dynamic';

export default async function NewImportPreviewPage() {
  let authContext;
  try {
    authContext = await requireAdmin();
  } catch {
    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: '#EF4444', backgroundColor: '#0B0F19', minHeight: '100vh' }}>
        <h2>Authentication Required</h2>
        <p>Please log in with staff credentials to access project import preview.</p>
        <Link href="/login" style={{ color: '#3B82F6', textDecoration: 'underline' }}>Return to Login</Link>
      </div>
    );
  }

  const canEdit = hasPermission(authContext.permissions, 'projects.edit');

  if (!canEdit) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: '#EF4444', backgroundColor: '#0B0F19', minHeight: '100vh' }}>
        <h2>Access Denied</h2>
        <p>Your user role ({authContext.roles.join(', ')}) does not have permission to access project import previews.</p>
        <Link href="/admin/imports" style={{ color: '#3B82F6', textDecoration: 'underline' }}>Return to Import Batches</Link>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      color: '#F3F4F6',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '2rem',
    }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Navigation header */}
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '2rem',
          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
          paddingBottom: '1rem',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Link href="/admin/imports" style={{ color: '#9CA3AF', textDecoration: 'none', fontSize: '0.9rem' }}>
                ← Staging Import Batches
              </Link>
            </div>
            <h1 style={{ margin: '0.5rem 0 0 0', fontSize: '1.75rem', fontWeight: 800 }}>Project Package Import Preview</h1>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.9rem', color: '#9CA3AF' }}>
              Browser Folder Selection & Server-Side Batch Validation Foundation
            </p>
          </div>

          <div>
            <Link href="/admin/imports" style={{
              color: '#9CA3AF',
              textDecoration: 'none',
              fontSize: '0.9rem',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}>
              Back to Ingestion Batches
            </Link>
          </div>
        </header>

        {/* Client Component */}
        <BrowserImportPreviewClient />
      </div>
    </div>
  );
}
