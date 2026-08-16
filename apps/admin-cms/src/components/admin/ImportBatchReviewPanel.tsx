'use client';

import React, { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, X, ArrowRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Alert } from '../ui/alert';
import { ProjectStatusBadge } from './ProjectStatusBadge';

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
      <div className="text-sm text-muted-foreground italic py-4">
        Review submission becomes available once this import batch reaches the &quot;completed&quot; state.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      {!canSubmit && (
        <Alert
          variant="default"
          description="Your account does not have permission to submit projects for review."
        />
      )}

      {successMessage && (
        <Alert
          variant="success"
          description={successMessage}
        />
      )}

      {error && (
        <Alert
          variant="destructive"
          title="Submission Failed"
          description={error}
        />
      )}

      {/* Action Controls Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={selectAllReady}
          disabled={!canSubmit || pending || readyProjects.length === 0}
        >
          Select all ready ({readyProjects.length})
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearSelection}
          disabled={!canSubmit || pending || selected.size === 0}
        >
          Clear selection
        </Button>
        <span className="text-xs text-muted-foreground ml-1">
          {selected.size} selected
        </span>
        <Button
          type="button"
          size="sm"
          onClick={handleSubmit}
          disabled={!canSubmit || pending || selected.size === 0}
          className="ml-auto font-semibold"
        >
          {pending ? 'Submitting…' : 'Submit selected for review'}
        </Button>
      </div>

      {/* Projects Table */}
      <div className="overflow-x-auto w-full border border-border rounded-lg bg-card">
        <table className="w-full text-left text-sm border-collapse">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <th className="py-2.5 px-3 w-10 text-center">
                <span className="sr-only">Select</span>
              </th>
              <th className="py-2.5 px-3">Title</th>
              <th className="py-2.5 px-3">Public ID</th>
              <th className="py-2.5 px-3">Status</th>
              <th className="py-2.5 px-3">Readiness</th>
              <th className="py-2.5 px-3">Staged media</th>
              <th className="py-2.5 px-3 text-right">
                <span className="sr-only">Inspect</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {projects.map((project) => {
              const selectable = canSubmit && project.eligibility === 'eligible' && project.ready && !pending;
              const isChecked = selected.has(project.publicId);
              return (
                <tr
                  key={project.publicId}
                  className="hover:bg-muted/50 transition-colors"
                >
                  <td className="py-3 px-3 text-center">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={!selectable}
                      onChange={() => toggleSelected(project.publicId)}
                      aria-label={`Select project ${project.title || project.publicId}`}
                      className="h-4 w-4 rounded border-input text-primary focus:ring-ring disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    />
                  </td>
                  <td className="py-3 px-3 font-semibold text-foreground max-w-xs">
                    {project.title}
                  </td>
                  <td className="py-3 px-3 font-mono text-xs text-muted-foreground whitespace-nowrap">
                    <code>{project.publicId}</code>
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    <ProjectStatusBadge status={project.status} />
                  </td>
                  <td className="py-3 px-3 text-xs leading-relaxed max-w-sm">
                    {project.eligibility === 'already_submitted' ? (
                      <span className="text-information font-medium">Already submitted</span>
                    ) : project.eligibility === 'ineligible' ? (
                      <span className="text-muted-foreground font-medium">Not eligible from &quot;{project.status}&quot;</span>
                    ) : project.ready ? (
                      <span className="text-success font-semibold flex items-center gap-1">
                        <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                        Ready
                      </span>
                    ) : (
                      <span className="text-warning font-semibold flex items-center gap-1">
                        <X className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                        Blocked
                      </span>
                    )}
                    {project.blockingReasons.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-destructive text-[11px] list-disc list-inside">
                        {project.blockingReasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                    {project.warnings.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-warning text-[11px] list-disc list-inside">
                        {project.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="py-3 px-3 text-xs whitespace-nowrap text-muted-foreground">
                    <div className="flex flex-col gap-0.5">
                      <span className="inline-flex items-center gap-1">
                        Poster: {project.posterPresent ? (
                          <span className="text-success font-medium inline-flex items-center gap-0.5">
                            <Check className="h-3 w-3" aria-hidden="true" /> Present
                          </span>
                        ) : (
                          <span className="text-destructive font-medium inline-flex items-center gap-0.5">
                            <X className="h-3 w-3" aria-hidden="true" /> Missing
                          </span>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        PDF: {project.posterPdfPresent ? (
                          <span className="text-success font-medium inline-flex items-center gap-0.5">
                            <Check className="h-3 w-3" aria-hidden="true" /> Present
                          </span>
                        ) : (
                          <span className="text-destructive font-medium inline-flex items-center gap-0.5">
                            <X className="h-3 w-3" aria-hidden="true" /> Missing
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right whitespace-nowrap">
                    <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-xs">
                      <Link href={`/admin/projects/${project.publicId}`}>
                        Inspect
                        <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
                      </Link>
                    </Button>
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
