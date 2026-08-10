'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { pruneStaleSelection } from './importBatchReviewPanelState';

export interface ImportBatchReviewProjectView {
  publicId: string;
  title: string;
  status: string;
  eligibility: 'eligible' | 'already_submitted' | 'ineligible';
  ready: boolean;
  blockingReasons: string[];
  warnings: string[];
  posterPresent: boolean;
  posterPdfPresent: boolean;
}

interface ImportBatchReviewPanelProps {
  batchId: string;
  batchStatus: string;
  projects: ImportBatchReviewProjectView[];
  canSubmit: boolean;
}

interface SubmitResponse {
  success: boolean;
  error?: string;
  submittedCount?: number;
  alreadySubmittedPublicIds?: string[];
  publicId?: string;
  blockingReasons?: string[];
}

export function ImportBatchReviewPanel({ batchId, batchStatus, projects, canSubmit }: ImportBatchReviewPanelProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);

  const readyProjects = useMemo(
    () => projects.filter((p) => p.eligibility === 'eligible' && p.ready),
    [projects]
  );

  const selectableIds = useMemo(
    () => new Set(batchStatus === 'completed' ? readyProjects.map((p) => p.publicId) : []),
    [batchStatus, readyProjects]
  );

  // Reconcile the selection against currently-authoritative props: a project must never remain
  // selected once it is no longer ready, no longer eligible, no longer present, or the batch is
  // no longer completed. Prevents the submit button from ever sending a stale disabled selection.
  useEffect(() => {
    setSelected((prev) => pruneStaleSelection(prev, selectableIds));
  }, [selectableIds]);

  const toggleSelected = (publicId: string) => {
    if (pending) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(publicId)) {
        next.delete(publicId);
      } else {
        next.add(publicId);
      }
      return next;
    });
  };

  const selectAllReady = () => {
    if (pending) return;
    setSelected(new Set(readyProjects.map((p) => p.publicId)));
  };

  const clearSelection = () => {
    if (pending) return;
    setSelected(new Set());
  };

  const handleSubmit = async () => {
    if (submitInFlightRef.current || pending || selected.size === 0) return;
    submitInFlightRef.current = true;
    setPending(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/imports/${batchId}/submit-for-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPublicIds: Array.from(selected) }),
      });

      const data: SubmitResponse = await response.json().catch(() => ({ success: false, error: 'Invalid server response.' }));

      if (!response.ok || !data.success) {
        const reasons = data.blockingReasons && data.blockingReasons.length > 0
          ? ` (${data.blockingReasons.join('; ')})`
          : '';
        const target = data.publicId ? ` [${data.publicId}]` : '';
        throw new Error(`${data.error || 'Submission failed.'}${target}${reasons}`);
      }

      const submittedCount = data.submittedCount ?? 0;
      const alreadyCount = data.alreadySubmittedPublicIds?.length ?? 0;
      setSuccessMessage(
        `Submitted ${submittedCount} project(s) for review.` +
          (alreadyCount > 0 ? ` ${alreadyCount} were already submitted and were left unchanged.` : '')
      );
      setSelected(new Set());
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred while submitting for review.';
      setError(message);
    } finally {
      setPending(false);
      submitInFlightRef.current = false;
    }
  };

  if (batchStatus !== 'completed') {
    return (
      <div style={{ color: '#9CA3AF', fontSize: '0.85rem', fontStyle: 'italic' }}>
        Review submission becomes available once this import batch reaches the &quot;completed&quot; state.
      </div>
    );
  }

  return (
    <div style={{ fontSize: '0.9rem', lineHeight: '1.6' }}>
      {!canSubmit && (
        <div style={{
          fontSize: '0.8rem', color: '#9CA3AF', backgroundColor: '#0F172A', borderRadius: '6px',
          padding: '0.5rem 0.75rem', border: '1px solid rgba(255, 255, 255, 0.05)', marginBottom: '1rem',
        }}>
          Your account does not have permission to submit projects for review.
        </div>
      )}

      {successMessage && (
        <div style={{
          backgroundColor: 'rgba(16, 185, 129, 0.1)', color: '#10B981', border: '1px solid rgba(16, 185, 129, 0.2)',
          borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.85rem', fontWeight: 'bold', marginBottom: '1rem',
        }}>
          ✅ {successMessage}
        </div>
      )}

      {error && (
        <div style={{
          backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.85rem', fontWeight: 'bold', marginBottom: '1rem',
        }}>
          ❌ Error: {error}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
        <button
          type="button"
          onClick={selectAllReady}
          disabled={!canSubmit || pending || readyProjects.length === 0}
          style={selectorButtonStyle(!canSubmit || pending || readyProjects.length === 0)}
        >
          Select all ready ({readyProjects.length})
        </button>
        <button
          type="button"
          onClick={clearSelection}
          disabled={!canSubmit || pending || selected.size === 0}
          style={selectorButtonStyle(!canSubmit || pending || selected.size === 0)}
        >
          Clear selection
        </button>
        <span style={{ color: '#9CA3AF', fontSize: '0.85rem' }}>
          {selected.size} selected
        </span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || pending || selected.size === 0}
          style={{
            backgroundColor: '#10B981',
            color: '#FFFFFF',
            border: 'none',
            padding: '0.5rem 1rem',
            borderRadius: '6px',
            cursor: !canSubmit || pending || selected.size === 0 ? 'not-allowed' : 'pointer',
            fontWeight: 'bold',
            fontSize: '0.85rem',
            opacity: !canSubmit || pending || selected.size === 0 ? 0.5 : 1,
            marginLeft: 'auto',
          }}
        >
          {pending ? 'Submitting…' : 'Submit selected for review'}
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', color: '#9CA3AF' }}>
              <th style={{ padding: '0.5rem', fontWeight: 600 }}></th>
              <th style={{ padding: '0.5rem', fontWeight: 600 }}>Title</th>
              <th style={{ padding: '0.5rem', fontWeight: 600 }}>Public ID</th>
              <th style={{ padding: '0.5rem', fontWeight: 600 }}>Status</th>
              <th style={{ padding: '0.5rem', fontWeight: 600 }}>Readiness</th>
              <th style={{ padding: '0.5rem', fontWeight: 600 }}>Staged media</th>
              <th style={{ padding: '0.5rem', fontWeight: 600 }}></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const selectable = canSubmit && project.eligibility === 'eligible' && project.ready && !pending;
              const isChecked = selected.has(project.publicId);
              return (
                <tr key={project.publicId} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)', color: '#D1D5DB' }}>
                  <td style={{ padding: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={!selectable}
                      onChange={() => toggleSelected(project.publicId)}
                    />
                  </td>
                  <td style={{ padding: '0.5rem', fontWeight: 600 }}>{project.title}</td>
                  <td style={{ padding: '0.5rem' }}><code>{project.publicId}</code></td>
                  <td style={{ padding: '0.5rem' }}>{project.status}</td>
                  <td style={{ padding: '0.5rem' }}>
                    {project.eligibility === 'already_submitted' ? (
                      <span style={{ color: '#3B82F6', fontWeight: 600 }}>Already submitted</span>
                    ) : project.eligibility === 'ineligible' ? (
                      <span style={{ color: '#6B7280', fontWeight: 600 }}>Not eligible from &quot;{project.status}&quot;</span>
                    ) : project.ready ? (
                      <span style={{ color: '#10B981', fontWeight: 600 }}>Ready</span>
                    ) : (
                      <span style={{ color: '#F59E0B', fontWeight: 600 }}>Blocked</span>
                    )}
                    {project.blockingReasons.length > 0 && (
                      <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.1rem', color: '#F87171' }}>
                        {project.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    )}
                    {project.warnings.length > 0 && (
                      <ul style={{ margin: '0.25rem 0 0 0', paddingLeft: '1.1rem', color: '#F59E0B' }}>
                        {project.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                      </ul>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    Poster: {project.posterPresent ? '✅' : '❌'} · PDF: {project.posterPdfPresent ? '✅' : '❌'}
                  </td>
                  <td style={{ padding: '0.5rem' }}>
                    <Link href={`/admin/projects/${project.publicId}`} style={{
                      color: '#3B82F6', textDecoration: 'none', fontSize: '0.8rem', fontWeight: 600,
                    }}>
                      Inspect →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function selectorButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    backgroundColor: '#1E293B',
    color: '#E5E7EB',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    padding: '0.4rem 0.8rem',
    borderRadius: '6px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
    opacity: disabled ? 0.5 : 1,
  };
}
