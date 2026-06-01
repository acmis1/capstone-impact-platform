import React from 'react';
import Link from 'next/link';
import { ImportBatchRepository } from '../../../../repositories/ImportBatchRepository';
import ImportBatchStatusBadge from '../../../../components/admin/ImportBatchStatusBadge';
import ValidationFlagsTable from '../../../../components/admin/ValidationFlagsTable';
import MediaAssetsTable from '../../../../components/admin/MediaAssetsTable';

export const dynamic = 'force-dynamic';

export default async function ImportBatchDetailPage({
  params
}: {
  params: Promise<{ batchId: string }>
}) {
  const { batchId } = await params;
  let batch: any = null;
  let projects: any[] = [];
  let validationFlags: any[] = [];
  let mediaAssets: any[] = [];
  let errorMsg: string | null = null;

  try {
    const repository = new ImportBatchRepository();
    batch = await repository.getImportBatchById(batchId);
    
    if (batch) {
      projects = await repository.getImportedProjectsForBatch(batchId);
      if (projects && projects.length > 0) {
        // Collect flags and assets for the imported project(s)
        const primaryProject = projects[0];
        validationFlags = await repository.getValidationFlagsForProject(primaryProject.id);
        mediaAssets = await repository.getMediaAssetsForProject(primaryProject.id);
      }
    }
  } catch (err: any) {
    console.error('[Staging Batch Detail Load Error]:', err.message || err);
    errorMsg = err.message || 'database error';
  }

  // Safe error card for missing batch parameters
  if (!batch || errorMsg) {
    return (
      <div style={{
        minHeight: '100vh',
        backgroundColor: '#0B0F19',
        color: '#F3F4F6',
        fontFamily: 'Inter, system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}>
        <div style={{
          maxWidth: '500px',
          width: '100%',
          backgroundColor: '#161F30',
          borderRadius: '12px',
          padding: '2rem',
          textAlign: 'center',
          border: '1px solid rgba(239, 68, 68, 0.2)',
        }}>
          <h3 style={{ color: '#EF4444', margin: '0 0 1rem 0' }}>Import Batch Not Found</h3>
          <p style={{ color: '#9CA3AF', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 1.5rem 0' }}>
            The requested batch UUID is invalid or does not match any logged local package ingestion staging runs in the database.
          </p>
          <Link href="/admin/imports" style={{
            color: '#3B82F6',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.9rem',
          }}>
            ← Return to Import Batches
          </Link>
        </div>
      </div>
    );
  }

  const primaryProject = projects[0] || null;

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
              <Link href="/admin/imports" style={{ color: '#9CA3AF', textDecoration: 'none', fontSize: '0.9rem' }}>
                ← Ingestion Batches
              </Link>
            </div>
            <h1 style={{ margin: '0.5rem 0 0 0', fontSize: '1.75rem', fontWeight: 800 }}>Batch: {batch.batch_name}</h1>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.9rem', color: '#9CA3AF', fontFamily: 'monospace' }}>
              UUID: {batch.id}
            </p>
          </div>
          <div>
            <Link href="/admin/imports" style={{
              color: '#3B82F6',
              textDecoration: 'none',
              fontSize: '0.95rem',
              fontWeight: 600,
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              border: '1px solid rgba(59, 130, 246, 0.2)',
            }}>
              All Batches
            </Link>
          </div>
        </header>

        {/* Layout details grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 2fr',
          gap: '2rem',
          alignItems: 'start'
        }}>
          {/* A. Batch Overview Details Card */}
          <div style={{
            backgroundColor: '#161F30',
            borderRadius: '12px',
            padding: '1.5rem',
            border: '1px solid rgba(255, 255, 255, 0.05)',
          }}>
            <h3 style={{ fontSize: '1.1rem', margin: '0 0 1rem 0', color: '#3B82F6', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '0.5rem' }}>
              Ingestion Metadata
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', fontSize: '0.9rem' }}>
              <div>
                <strong style={{ color: '#9CA3AF', display: 'block', fontSize: '0.8rem', textTransform: 'uppercase' }}>Ingestion Status</strong>
                <div style={{ marginTop: '0.25rem' }}>
                  <ImportBatchStatusBadge status={batch.status} />
                </div>
              </div>

              <div>
                <strong style={{ color: '#9CA3AF', display: 'block', fontSize: '0.8rem', textTransform: 'uppercase' }}>Local Source Folder</strong>
                <div style={{ marginTop: '0.25rem', fontFamily: 'monospace', wordBreak: 'break-all', color: '#E5E7EB' }}>
                  {batch.source_folder}
                </div>
              </div>

              <div>
                <strong style={{ color: '#9CA3AF', display: 'block', fontSize: '0.8rem', textTransform: 'uppercase' }}>Ingestion Mode</strong>
                <div style={{ marginTop: '0.1rem', color: '#E5E7EB' }}>
                  {batch.mode}
                </div>
              </div>

              <div>
                <strong style={{ color: '#9CA3AF', display: 'block', fontSize: '0.8rem', textTransform: 'uppercase' }}>Imported Projects Count</strong>
                <div style={{ marginTop: '0.1rem', color: '#E5E7EB', fontWeight: 'bold' }}>
                  {batch.total_projects} project(s)
                </div>
              </div>

              <div>
                <strong style={{ color: '#9CA3AF', display: 'block', fontSize: '0.8rem', textTransform: 'uppercase' }}>Errors / Warnings Caught</strong>
                <div style={{ marginTop: '0.1rem', color: '#E5E7EB' }}>
                  {batch.error_count || 0} error(s), {batch.warning_count || 0} warning(s)
                </div>
              </div>

              <div>
                <strong style={{ color: '#9CA3AF', display: 'block', fontSize: '0.8rem', textTransform: 'uppercase' }}>Ingested Timestamp</strong>
                <div style={{ marginTop: '0.1rem', color: '#E5E7EB' }}>
                  {new Date(batch.created_at).toLocaleString()}
                </div>
              </div>
            </div>

            {/* Safety Ingestion Footer */}
            <div style={{
              marginTop: '1.5rem',
              paddingTop: '1rem',
              borderTop: '1px solid rgba(255, 255, 255, 0.05)',
              fontSize: '0.8rem',
              color: '#9CA3AF',
              lineHeight: '1.4'
            }}>
              <strong>🔒 Staging Safety Isolation:</strong> Imported package resources are stored inside private drafts buckets. Media assets do not promote to public URLs, keeping staging showcase records cleanly separated from active public distributions. Duda showcase remains completely disconnected.
            </div>
          </div>

          {/* Right section: Ingested projects & assets details */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            
            {/* B. Imported Projects details card */}
            <div style={{
              backgroundColor: '#161F30',
              borderRadius: '12px',
              padding: '1.5rem',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}>
              <h3 style={{ fontSize: '1.1rem', margin: '0 0 1rem 0', color: '#3B82F6', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '0.5rem' }}>
                Ingested Project Targets
              </h3>

              {primaryProject ? (
                <div>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    backgroundColor: '#0B0F19',
                    padding: '1rem',
                    borderRadius: '8px',
                    border: '1px solid rgba(255, 255, 255, 0.03)'
                  }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>
                        {primaryProject.title}
                      </h4>
                      <div style={{ marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#9CA3AF' }}>
                        <span>ID: <code style={{ color: '#E5E7EB' }}>{primaryProject.public_id}</code></span>
                        <span>•</span>
                        <span>State: <strong style={{ color: '#F59E0B' }}>{primaryProject.status}</strong></span>
                      </div>
                    </div>

                    <div>
                      <Link href={`/admin/projects/${primaryProject.public_id}`} style={{
                        color: '#3B82F6',
                        textDecoration: 'none',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        border: '1px solid rgba(59, 130, 246, 0.2)',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(59, 130, 246, 0.05)'
                      }}>
                        Inspect Project →
                      </Link>
                    </div>
                  </div>

                  {/* Public eligibility criteria mapping */}
                  <div style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
                    <strong>Public Showcase Eligibility Status:</strong>{' '}
                    <span style={{
                      color: primaryProject.status === 'approved' || primaryProject.status === 'published' ? '#10B981' : '#EF4444',
                      fontWeight: 600
                    }}>
                      {primaryProject.status === 'approved' || primaryProject.status === 'published' ? 'YES (Eligible)' : 'NO (Staged Private drafts/in_review only)'}
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ color: '#9CA3AF', fontSize: '0.9rem' }}>
                  No projects are registered for this batch ID.
                </div>
              )}
            </div>

            {/* C. Validation Flags mapping card */}
            <div style={{
              backgroundColor: '#161F30',
              borderRadius: '12px',
              padding: '1.5rem',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}>
              <h3 style={{ fontSize: '1.1rem', margin: '0 0 1rem 0', color: '#F59E0B', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '0.5rem' }}>
                Ingestion Validation Flags
              </h3>
              <ValidationFlagsTable flags={validationFlags} />
            </div>

            {/* D. Draft media uploads details table */}
            <div style={{
              backgroundColor: '#161F30',
              borderRadius: '12px',
              padding: '1.5rem',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}>
              <h3 style={{ fontSize: '1.1rem', margin: '0 0 1rem 0', color: '#10B981', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '0.5rem' }}>
                Ingested Media Files (Staged Private)
              </h3>
              <MediaAssetsTable assets={mediaAssets} />
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
