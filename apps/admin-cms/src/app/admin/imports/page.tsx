import React from 'react';
import Link from 'next/link';
import { ImportBatchRepository } from '../../../repositories/ImportBatchRepository';
import ImportBatchTable from '../../../components/admin/ImportBatchTable';
import { ImportBatchRow } from '../../../repositories/ImportBatchRepositoryCore';

export const dynamic = 'force-dynamic';

export default async function ImportBatchesPage() {
  let batches: ImportBatchRow[] = [];
  let databaseError: string | null = null;

  try {
    const repository = new ImportBatchRepository();
    batches = await repository.listRecentImportBatches(50);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown database connection error';
    console.error('[Staging Import Batches Load Failure]:', message);
    databaseError = message;
  }

  // Summary aggregation metrics
  const totalBatches = batches.length;
  const completedCount = batches.filter((b) => b.status === 'completed').length;
  const failedCount = batches.filter((b) => b.status === 'failed').length;
  const totalWarnings = batches.reduce((acc, b) => acc + (b.warning_count || 0), 0);
  const totalErrors = batches.reduce((acc, b) => acc + (b.error_count || 0), 0);

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0B0F19',
      color: '#F3F4F6',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '2rem',
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
      }}>
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
              <Link href="/admin" style={{ color: '#9CA3AF', textDecoration: 'none', fontSize: '0.9rem' }}>
                ← Admin Dashboard
              </Link>
            </div>
            <h1 style={{ margin: '0.5rem 0 0 0', fontSize: '1.75rem', fontWeight: 800 }}>Staging Import Batches</h1>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.9rem', color: '#9CA3AF' }}>Audit Log & Local Package Ingestion Runs</p>
          </div>
          <div>
            <Link href="/admin" style={{
              color: '#3B82F6',
              textDecoration: 'none',
              fontSize: '0.95rem',
              fontWeight: 600,
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              border: '1px solid rgba(59, 130, 246, 0.2)',
            }}>
              Return to Console
            </Link>
          </div>
        </header>

        {/* ⚠️ Staging Ingestion Warning Banner */}
        <div style={{
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          border: '1px solid rgba(59, 130, 246, 0.2)',
          borderRadius: '12px',
          padding: '1.25rem 1.5rem',
          marginBottom: '2rem',
          color: '#60A5FA',
        }}>
          <h4 style={{ margin: '0 0 0.5rem 0', display: 'flex', alignItems: 'center', fontSize: '1rem', fontWeight: 'bold' }}>
            📦 STAGING PACKAGE INGESTION AUDIT NOTE
          </h4>
          <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.5', color: '#D1D5DB' }}>
            Staging import workflows operate exclusively on local fake package fixtures. Browser files upload layers and automated XLSX spreadsheet parsing are disconnected during this foundation build. Imported showcases do not promote media to public buckets automatically, keeping public presentation feed compiler counts safe from legacy or staging pollution.
          </p>
        </div>

        {databaseError ? (
          <div style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: '12px',
            padding: '2rem',
            textAlign: 'center',
            color: '#EF4444',
          }}>
            <h3>Staging Database Connection Offline</h3>
            <p style={{ color: '#D1D5DB' }}>Could not retrieve import batches: {databaseError}</p>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '1.5rem',
              marginBottom: '2rem',
            }}>
              <div style={{ backgroundColor: '#161F30', borderRadius: '12px', padding: '1.25rem', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' }}>Recent Batches</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#FFFFFF', marginTop: '0.25rem' }}>{totalBatches}</div>
              </div>
              <div style={{ backgroundColor: '#161F30', borderRadius: '12px', padding: '1.25rem', border: '1px solid rgba(255, 255, 255, 0.05)', borderLeft: '4px solid #10B981' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' }}>Completed</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#10B981', marginTop: '0.25rem' }}>{completedCount}</div>
              </div>
              <div style={{ backgroundColor: '#161F30', borderRadius: '12px', padding: '1.25rem', border: '1px solid rgba(255, 255, 255, 0.05)', borderLeft: '4px solid #EF4444' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' }}>Failed</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#EF4444', marginTop: '0.25rem' }}>{failedCount}</div>
              </div>
              <div style={{ backgroundColor: '#161F30', borderRadius: '12px', padding: '1.25rem', border: '1px solid rgba(255, 255, 255, 0.05)', borderLeft: '4px solid #F59E0B' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' }}>Total Warnings</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#F59E0B', marginTop: '0.25rem' }}>{totalWarnings}</div>
              </div>
              <div style={{ backgroundColor: '#161F30', borderRadius: '12px', padding: '1.25rem', border: '1px solid rgba(255, 255, 255, 0.05)', borderLeft: '4px solid #EF4444' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase' }}>Total Errors</div>
                <div style={{ fontSize: '2rem', fontWeight: 800, color: '#EF4444', marginTop: '0.25rem' }}>{totalErrors}</div>
              </div>
            </div>

            {/* Ingestion Table */}
            <div style={{
              backgroundColor: '#161F30',
              borderRadius: '12px',
              padding: '2rem',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}>
              <h2 style={{ fontSize: '1.25rem', margin: 0, color: '#3B82F6', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '0.75rem' }}>
                Ingested Ingestion Batches
              </h2>
              {batches.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center' }}>
                  <p style={{ margin: '0 0 1.5rem 0', color: '#9CA3AF' }}>No import batches found. Would you like to ingest a mock local package first?</p>
                  <div style={{
                    display: 'inline-block',
                    backgroundColor: '#0B0F19',
                    padding: '0.75rem 1.5rem',
                    borderRadius: '8px',
                    fontFamily: 'monospace',
                    fontSize: '0.9rem',
                    color: '#10B981',
                    border: '1px solid rgba(16, 185, 129, 0.2)'
                  }}>
                    npm run import:staging-package
                  </div>
                </div>
              ) : (
                <ImportBatchTable batches={batches} />
              )}
            </div>
          </>
        )}
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .project-row:hover {
          background-color: #1E293B !important;
        }
      `}} />
    </div>
  );
}
