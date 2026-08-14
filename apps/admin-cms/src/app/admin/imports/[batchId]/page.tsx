import React from 'react';
import Link from 'next/link';
import { ImportBatchRepository } from '../../../../repositories/ImportBatchRepository';
import ImportBatchStatusBadge from '../../../../components/admin/ImportBatchStatusBadge';
import { ImportBatchReviewPanel, ImportBatchReviewProjectView } from '../../../../components/admin/ImportBatchReviewPanel';
import {
  ImportBatchRow,
  ImportBatchReviewProjectRow,
} from '../../../../repositories/ImportBatchRepositoryCore';
import { computeReadinessForImportBatchRow, isPrivateAssetPresent } from '../../../../import/importBatchReviewReadiness';
import { requireAdmin } from '../../../../auth/requireAdmin';
import { hasPermission } from '../../../../auth/permissions';

export const dynamic = 'force-dynamic';

export default async function ImportBatchDetailPage({
  params
}: {
  params: Promise<{ batchId: string }>
}) {
  const { batchId } = await params;
  let batch: ImportBatchRow | null = null;
  let reviewRows: ImportBatchReviewProjectRow[] = [];
  let canSubmit = false;

  let errorMsg: string | null = null;

  try {
    const repository = new ImportBatchRepository();
    const [batchResult, adminContext] = await Promise.all([
      repository.getImportBatchById(batchId),
      requireAdmin(),
    ]);
    batch = batchResult;
    canSubmit = hasPermission(adminContext.permissions, 'projects.edit');

    if (batch) {
      reviewRows = await repository.getImportBatchReviewData(batchId);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'database error';
    console.error('[Staging Batch Detail Load Error]:', message);
    errorMsg = message;
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

  const reviewProjects: ImportBatchReviewProjectView[] = reviewRows.map((row) => {
    const readiness = computeReadinessForImportBatchRow(row);
    const mediaAssets = (row.media_assets || []).map((a) => ({
      assetType: a.asset_type,
      isPublicApproved: a.is_public_approved,
      publicUrl: a.public_url,
      altText: a.alt_text_public,
    }));
    const posterPresent = isPrivateAssetPresent(mediaAssets, 'poster_image');
    const posterPdfPresent = isPrivateAssetPresent(mediaAssets, 'poster_pdf');
    return {
      publicId: row.public_id,
      title: row.title || '(untitled)',
      status: row.status,
      eligibility: readiness.eligibility,
      ready: readiness.ready,
      blockingReasons: readiness.blockingReasons,
      warnings: readiness.warnings,
      posterPresent,
      posterPdfPresent,
    };
  });

  // Reset client-side selection whenever the authoritative selectable project set or workflow state changes.
  // A React key remount avoids synchronously setting state from an effect while still guaranteeing stale
  // selections cannot survive a server refresh that changes readiness, eligibility, status, or membership.
  const reviewSelectionKey = [
    batch.status,
    ...reviewProjects.map((project) =>
      `${project.publicId}:${project.status}:${project.eligibility}:${project.ready ? 'ready' : 'blocked'}`
    ),
  ].join('|');

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
              <strong>🔒 Staging Safety Isolation:</strong> {batch.status === 'metadata_staged' ? 'Metadata is stored in local Supabase and projects remain in draft state. Media file uploads have not occurred, full binary validation is pending, and no approval or publication has been performed.' : 'Imported package resources are stored inside private drafts buckets. Media assets do not promote to public URLs, keeping staging showcase records cleanly separated from active public distributions.'}
            </div>
          </div>

          {/* Right section: Ingested projects review surface */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

            {/* B. Multi-project review & submit-for-review card */}
            <div style={{
              backgroundColor: '#161F30',
              borderRadius: '12px',
              padding: '1.5rem',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}>
              <h3 style={{ fontSize: '1.1rem', margin: '0 0 1rem 0', color: '#3B82F6', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '0.5rem' }}>
                Ingested Project Targets ({reviewProjects.length})
              </h3>

              {reviewProjects.length > 0 ? (
                <ImportBatchReviewPanel
                  key={reviewSelectionKey}
                  batchId={batch.id}
                  batchStatus={batch.status}
                  projects={reviewProjects}
                  canSubmit={canSubmit}
                />
              ) : (
                <div style={{ color: '#9CA3AF', fontSize: '0.9rem' }}>
                  No projects are registered for this batch ID.
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
