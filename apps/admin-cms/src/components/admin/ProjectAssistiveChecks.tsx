'use client';

import React, { useEffect, useReducer, useRef } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileSearch,
  Info,
  Loader2,
  Play,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';

import type {
  AssistiveInspectionView,
  AssistiveRecordableDisposition,
  StoredAssistiveFinding,
} from '../../assistive-validation';
import {
  cancelAssistiveChecksAction,
  getAssistiveInspectionAction,
  recordAssistiveDispositionAction,
  runAssistiveChecksAction,
} from '../../app/admin/projects/[publicId]/assistiveActions';
import { Alert } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import {
  assistiveChecksReducer,
  formatCheckType,
  formatDisposition,
  formatFailureCode,
  formatJobStatus,
  formatOutcome,
  initialAssistiveChecksUiState,
  isFindingEligibleToApply,
} from './projectAssistiveChecksState';
import { useProjectMetadataNavigation } from './ProjectMetadataNavigation';

interface ProjectAssistiveChecksProps {
  publicId: string;
  canEditMetadata: boolean;
  canReview: boolean;
  initialInspection?: AssistiveInspectionView | null;
  headingLevel?: 'h2' | 'h3' | 'h4';
}

const POLLING_INTERVAL_MS = 2500;

export function ProjectAssistiveChecks({
  publicId,
  canEditMetadata,
  canReview,
  initialInspection = null,
  headingLevel: Heading = 'h3',
}: ProjectAssistiveChecksProps) {
  const [state, dispatch] = useReducer(assistiveChecksReducer, {
    ...initialAssistiveChecksUiState,
    inspection: initialInspection,
  });

  const { canApplyTitleSuggestion, applyTitleSuggestion } = useProjectMetadataNavigation();
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  const runId = state.inspection?.runId;
  const jobStatus = state.inspection?.jobStatus;
  const runStatus = state.inspection?.runStatus;

  // Poll for active jobs
  useEffect(() => {
    const isJobActive =
      jobStatus &&
      ['QUEUED', 'EXTRACTING', 'CHECKING', 'RUNNING'].includes(jobStatus) &&
      !['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(runStatus ?? '');

    if (!isJobActive) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      return;
    }

    const poll = async () => {
      try {
        const result = await getAssistiveInspectionAction(publicId, runId);
        if (result.ok && result.found) {
          dispatch({ type: 'LOAD_SUCCEEDED', inspection: result.inspection });
        }
      } catch {
        // Soft-fail polling errors without tearing down UI
      }
    };

    pollTimerRef.current = setTimeout(poll, POLLING_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [publicId, jobStatus, runStatus, runId]);

  const handleRunChecks = async () => {
    if (inFlightRef.current || state.actionInFlight !== 'idle') return;
    inFlightRef.current = true;
    dispatch({ type: 'RUN_STARTED' });

    try {
      const result = await runAssistiveChecksAction(publicId);
      if (result.ok) {
        dispatch({ type: 'RUN_SUCCEEDED', runId: result.runId, status: result.status });
        // Immediate inspection refresh to populate active view
        const inspectionResult = await getAssistiveInspectionAction(publicId, result.runId);
        if (inspectionResult.ok && inspectionResult.found) {
          dispatch({ type: 'LOAD_SUCCEEDED', inspection: inspectionResult.inspection });
        }
      } else {
        dispatch({ type: 'RUN_FAILED', error: result.message });
      }
    } catch {
      dispatch({ type: 'RUN_FAILED', error: 'Assistive checks could not be started. Please try again.' });
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleCancel = async () => {
    if (!state.inspection?.runId || inFlightRef.current || state.actionInFlight !== 'idle') return;
    inFlightRef.current = true;
    dispatch({ type: 'CANCEL_STARTED' });

    try {
      const result = await cancelAssistiveChecksAction(publicId, state.inspection.runId);
      if (result.ok) {
        dispatch({ type: 'CANCEL_SUCCEEDED' });
        // Refresh inspection
        const inspectionResult = await getAssistiveInspectionAction(publicId, state.inspection.runId);
        if (inspectionResult.ok && inspectionResult.found) {
          dispatch({ type: 'LOAD_SUCCEEDED', inspection: inspectionResult.inspection });
        }
      } else {
        dispatch({ type: 'CANCEL_FAILED', error: result.message });
      }
    } catch {
      dispatch({ type: 'CANCEL_FAILED', error: 'Could not cancel assistive validation.' });
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleDisposition = async (findingId: string, disposition: AssistiveRecordableDisposition) => {
    if (!state.inspection?.runId || inFlightRef.current || state.actionInFlight !== 'idle') return;
    inFlightRef.current = true;
    dispatch({ type: 'DISPOSITION_STARTED' });

    try {
      const result = await recordAssistiveDispositionAction(
        publicId,
        state.inspection.runId,
        findingId,
        disposition,
      );
      if (result.ok) {
        dispatch({
          type: 'DISPOSITION_SUCCEEDED',
          findingId: result.findingId,
          disposition: result.disposition,
          reviewedAt: result.reviewedAt,
          reviewedBy: result.reviewedBy,
        });
      } else {
        dispatch({ type: 'DISPOSITION_FAILED', error: result.message });
      }
    } catch {
      dispatch({ type: 'DISPOSITION_FAILED', error: 'Could not record finding review.' });
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleApplyToDraft = (candidateText: string) => {
    dispatch({ type: 'APPLY_STARTED' });
    const applied = applyTitleSuggestion(candidateText);
    if (applied) {
      dispatch({
        type: 'APPLY_COMPLETED',
        message: 'Suggestion applied to the metadata editor draft.',
        success: true,
      });
    } else {
      dispatch({
        type: 'APPLY_COMPLETED',
        message: 'Could not apply suggestion to draft.',
        success: false,
      });
    }
  };

  const handleCopyText = async (textToCopy: string, findingId: string) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      dispatch({ type: 'COPY_FEEDBACK', findingId });
      setTimeout(() => {
        dispatch({ type: 'COPY_FEEDBACK', findingId: null });
      }, 2000);
    } catch {
      // Clipboard write failed
    }
  };

  const isJobActive =
    state.inspection &&
    ['QUEUED', 'EXTRACTING', 'CHECKING', 'RUNNING'].includes(state.inspection.jobStatus) &&
    !['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(state.inspection.runStatus);

  const statusPresentation = state.inspection
    ? formatJobStatus(state.inspection.jobStatus, state.inspection.runStatus)
    : null;

  return (
    <section
      id="assistive-checks"
      aria-labelledby="assistive-checks-heading"
      className="scroll-mt-44 xl:scroll-mt-40 rounded-xl border border-border-structural bg-card p-4 sm:p-6"
      data-slot="project-assistive-checks"
    >
      {/* Header with Title and Run Button */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileSearch className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
            <Heading id="assistive-checks-heading" className="text-base font-semibold tracking-tight text-foreground">
              Assistive checks
            </Heading>
            {statusPresentation && (
              <Badge variant={statusPresentation.variant} className="ml-1">
                {statusPresentation.label}
              </Badge>
            )}
          </div>
          <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-muted-foreground">
            Non-blocking comparison between project metadata and document evidence to assist editorial review.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isJobActive ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={state.actionInFlight !== 'idle'}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel checks
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={handleRunChecks}
              disabled={state.actionInFlight !== 'idle'}
              isLoading={state.actionInFlight === 'running'}
            >
              {state.inspection ? (
                <>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Re-run checks
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  Run checks
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Notifications / Alerts */}
      {state.error && (
        <div className="mt-4">
          <Alert variant="destructive" title="Action unavailable" description={state.error} />
        </div>
      )}

      {state.feedback && (
        <div className="mt-4">
          <Alert
            variant={state.feedback.type === 'success' ? 'success' : 'information'}
            title={state.feedback.message}
          />
        </div>
      )}

      {/* Stale Run Banner */}
      {state.inspection?.staleState === 'STALE' && (
        <div className="mt-4">
          <Alert
            variant="warning"
            icon={AlertTriangle}
            title="Results may be outdated"
            description="This check was performed on earlier project content. Re-run checks to evaluate current metadata and poster evidence."
          />
        </div>
      )}

      {/* Unverifiable Run Banner */}
      {state.inspection?.staleState === 'UNVERIFIABLE' && (
        <div className="mt-4">
          <Alert
            variant="warning"
            icon={AlertTriangle}
            title="Document evidence unverifiable"
            description="The document evidence could not be verified against current poster assets."
          />
        </div>
      )}

      {/* Degraded / Partial OCR Banner */}
      {state.inspection?.runStatus === 'PARTIAL' && (
        <div className="mt-4">
          <Alert
            variant="information"
            icon={Info}
            title="Partial check results"
            description="OCR text extraction is unavailable in this environment. Born-digital PDF text was evaluated, but scanned images and graphics were not checked."
          />
        </div>
      )}

      {/* Main Content Area */}
      <div className="mt-5">
        {/* No inspection yet -> Empty State */}
        {!state.inspection && !isJobActive && (
          <EmptyState
            icon={FileSearch}
            title="No assistive checks run yet"
            description="Run assistive checks to verify project title consistency and document formatting against uploaded poster evidence."
            action={
              <Button
                type="button"
                onClick={handleRunChecks}
                disabled={state.actionInFlight !== 'idle'}
                isLoading={state.actionInFlight === 'running'}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Run checks now
              </Button>
            }
          />
        )}

        {/* Active In-Flight Job */}
        {isJobActive && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-lg border border-border bg-surface-inset p-5 text-sm"
          >
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold text-foreground">
                {state.inspection?.jobStatus === 'EXTRACTING'
                  ? 'Extracting document text and metadata...'
                  : state.inspection?.jobStatus === 'CHECKING'
                  ? 'Analyzing title consistency and document formatting...'
                  : 'Checks are queued and will start shortly...'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                This process takes a few seconds and updates automatically.
              </p>
            </div>
          </div>
        )}

        {/* Terminal Run: Completed / Partial / Failed */}
        {state.inspection && !isJobActive && (
          <div className="flex flex-col gap-4">
            {/* Failed Run Presentation */}
            {state.inspection.runStatus === 'FAILED' && (
              <Alert
                variant="destructive"
                icon={XCircle}
                title="Assistive check failed"
                description={formatFailureCode(state.inspection.failureCode)}
              />
            )}

            {/* Cancelled Run Presentation */}
            {state.inspection.runStatus === 'CANCELLED' && (
              <Alert
                variant="default"
                icon={Info}
                title="Checks cancelled"
                description="This assistive check run was cancelled by staff."
              />
            )}

            {/* Zero Findings in Completed/Partial Run */}
            {(state.inspection.runStatus === 'COMPLETED' || state.inspection.runStatus === 'PARTIAL') &&
              state.inspection.findings.length === 0 && (
                <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/8 p-4 text-sm text-foreground">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
                  <div>
                    <p className="font-medium">All checks evaluated cleanly</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      No discrepancies or title formatting issues were identified.
                    </p>
                  </div>
                </div>
              )}

            {/* Findings List */}
            {state.inspection.findings.length > 0 && (
              <ul className="flex flex-col gap-4" aria-label="Assistive validation findings">
                {state.inspection.findings.map((finding: StoredAssistiveFinding) => {
                  const outcome = formatOutcome(finding.outcome);
                  const disposition = formatDisposition(finding.disposition);
                  const canApply = isFindingEligibleToApply(
                    finding,
                    state.inspection!.staleState,
                    canEditMetadata,
                    canApplyTitleSuggestion,
                  );
                  const isCopied = state.copiedFindingId === finding.findingId;

                  return (
                    <li
                      key={finding.findingId}
                      className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border-strong sm:p-5"
                    >
                      {/* Finding Header */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-semibold text-foreground">
                            {formatCheckType(finding.checkType)}
                          </h4>
                          <Badge variant={outcome.variant}>{outcome.label}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Review status:</span>
                          <Badge variant={disposition.variant}>{disposition.label}</Badge>
                        </div>
                      </div>

                      {/* Finding Body / Explanation */}
                      <div className="mt-3">
                        <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                          {finding.evidence.explanation}
                        </p>
                      </div>

                      {/* Title Candidate Comparison Block */}
                      {finding.checkType === 'TITLE_CONSISTENCY' && finding.evidence.candidateValue && (
                        <div className="mt-3 rounded-md border border-border bg-surface-inset p-3 text-xs sm:text-sm">
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div>
                              <span className="font-semibold text-foreground">Current metadata title:</span>
                              <p className="mt-1 break-words font-mono text-muted-foreground">
                                {finding.evidence.metadataValue || '(none)'}
                              </p>
                            </div>
                            <div>
                              <span className="font-semibold text-foreground">Document candidate title:</span>
                              <p className="mt-1 break-words font-mono font-medium text-foreground">
                                {finding.evidence.candidateValue}
                              </p>
                            </div>
                          </div>

                          {finding.scoreValue !== null && (
                            <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                              <span>Similarity score: {Math.round(finding.scoreValue * 100)}%</span>
                              {finding.evidence.pageNumber && (
                                <span className="ml-3">Found on page {finding.evidence.pageNumber}</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Excerpt Block for other findings */}
                      {finding.checkType !== 'TITLE_CONSISTENCY' && finding.evidence.evidenceExcerpt && (
                        <div className="mt-3 rounded-md border border-border bg-surface-inset p-3 text-xs">
                          <span className="font-semibold text-foreground">Document excerpt:</span>
                          <blockquote className="mt-1 break-words font-mono text-muted-foreground whitespace-pre-wrap">
                            {finding.evidence.evidenceExcerpt}
                          </blockquote>
                          {finding.evidence.pageNumber && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Page {finding.evidence.pageNumber}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Action Bar */}
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                        {/* Copy & Apply Draft Actions */}
                        <div className="flex flex-wrap items-center gap-2">
                          {(finding.evidence.candidateValue || finding.evidence.evidenceExcerpt) && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                handleCopyText(
                                  finding.evidence.candidateValue || finding.evidence.evidenceExcerpt || '',
                                  finding.findingId,
                                )
                              }
                            >
                              {isCopied ? (
                                <>
                                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                  <span>Copy text</span>
                                </>
                              )}
                            </Button>
                          )}

                          {finding.checkType === 'TITLE_CONSISTENCY' && finding.evidence.candidateValue && (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={!canApply || state.actionInFlight !== 'idle'}
                              onClick={() => handleApplyToDraft(finding.evidence.candidateValue!)}
                              title={
                                !canEditMetadata
                                  ? 'Your role cannot edit project metadata.'
                                  : state.inspection!.staleState !== 'CURRENT'
                                  ? 'Cannot apply suggestion from an outdated run.'
                                  : 'Apply this candidate title to the project metadata editor draft.'
                              }
                            >
                              Apply to draft
                            </Button>
                          )}
                        </div>

                        {/* Reviewer Disposition Controls */}
                        {canReview && (
                          <div className="flex items-center gap-2">
                            {finding.disposition !== 'REVIEWED' && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={state.actionInFlight !== 'idle'}
                                onClick={() => handleDisposition(finding.findingId, 'REVIEWED')}
                              >
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                Mark reviewed
                              </Button>
                            )}

                            {finding.disposition !== 'IGNORED' && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={state.actionInFlight !== 'idle'}
                                onClick={() => handleDisposition(finding.findingId, 'IGNORED')}
                              >
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                                Ignore
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
