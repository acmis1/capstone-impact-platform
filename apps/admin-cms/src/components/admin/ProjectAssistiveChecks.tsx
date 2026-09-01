'use client';

import React, { useCallback, useEffect, useReducer, useRef } from 'react';
import Link from 'next/link';
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
  AssistiveInspectionFinding,
  AssistiveInspectionView,
  AssistiveRecordableDisposition,
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
  formatPartialNoticeDescription,
  initialAssistiveChecksUiState,
  isAssistiveRunActive,
  isFindingEligibleToApply,
  isLanguageFindingEligibleToApply,
} from './projectAssistiveChecksState';
import { useProjectMetadataNavigation } from './ProjectMetadataNavigation';

interface ProjectAssistiveChecksProps {
  publicId: string;
  canEditMetadata: boolean;
  canReview: boolean;
  canExecute?: boolean;
  /** Truthful reason shown when execution is not currently possible. */
  unavailableMessage?: string;
  initialInspection?: AssistiveInspectionView | null;
  initialReadFailed?: boolean;
  headingLevel?: 'h2' | 'h3' | 'h4';
}

const DEFAULT_UNAVAILABLE_MESSAGE =
  'Assistive checks are temporarily unavailable because the processing worker is not ready.';

const POLLING_INTERVAL_MS = 2500;

export function ProjectAssistiveChecks({
  publicId,
  canEditMetadata,
  canReview,
  canExecute = true,
  unavailableMessage = DEFAULT_UNAVAILABLE_MESSAGE,
  initialInspection = null,
  initialReadFailed = false,
  headingLevel: Heading = 'h3',
}: ProjectAssistiveChecksProps) {
  const [state, dispatch] = useReducer(assistiveChecksReducer, {
    ...initialAssistiveChecksUiState,
    inspection: initialInspection,
    readUnavailable: initialReadFailed,
  });

  const {
    canApplyTitleSuggestion, applyTitleSuggestion,
    canApplyLanguageSuggestion, applyLanguageSuggestion,
  } = useProjectMetadataNavigation();
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPollingRef = useRef(false);
  const activeRunIdRef = useRef<string | null>(initialInspection?.runId ?? null);
  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Treat router.refresh() input as one server snapshot. The reducer updates same/newer runs while
  // retaining a locally started run when an older or failed server read arrives late.
  const prevServerSnapshotRef = useRef({ initialInspection, initialReadFailed });
  useEffect(() => {
    const previous = prevServerSnapshotRef.current;
    if (initialInspection === previous.initialInspection && initialReadFailed === previous.initialReadFailed) return;

    prevServerSnapshotRef.current = { initialInspection, initialReadFailed };
    dispatch({
      type: 'SYNC_SERVER_SNAPSHOT',
      inspection: initialInspection,
      readUnavailable: initialReadFailed,
    });
  }, [initialInspection, initialReadFailed]);

  // Keep track of active run ID for polling lifecycle
  useEffect(() => {
    activeRunIdRef.current = state.inspection?.runId ?? null;
  }, [state.inspection?.runId]);

  const schedulePollRef = useRef<(targetRunId: string) => void>(() => {});

  // Self-scheduling bounded polling loop
  const schedulePoll = useCallback((targetRunId: string) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(async () => {
      if (!isMountedRef.current || isPollingRef.current) return;
      if (activeRunIdRef.current !== targetRunId) return;

      isPollingRef.current = true;
      try {
        const result = await getAssistiveInspectionAction(publicId, targetRunId);
        if (!isMountedRef.current || activeRunIdRef.current !== targetRunId) return;

        if (result.ok && result.found) {
          dispatch({ type: 'LOAD_SUCCEEDED', inspection: result.inspection });
          if (isAssistiveRunActive(result.inspection)) {
            schedulePollRef.current(targetRunId);
          }
        } else if (result.ok && !result.found) {
          dispatch({ type: 'ACTIVE_RUN_NOT_FOUND', runId: targetRunId });
        } else {
          // Transient failure: preserve last known inspection, schedule next poll attempt
          schedulePollRef.current(targetRunId);
        }
      } catch {
        // Transient exception: preserve inspection, schedule next poll attempt
        if (isMountedRef.current && activeRunIdRef.current === targetRunId) {
          schedulePollRef.current(targetRunId);
        }
      } finally {
        isPollingRef.current = false;
      }
    }, POLLING_INTERVAL_MS);
  }, [publicId]);

  useEffect(() => {
    schedulePollRef.current = schedulePoll;
  }, [schedulePoll]);

  // Trigger polling when an active run is in flight
  useEffect(() => {
    const inspection = state.inspection;

    if (inspection?.runId && isAssistiveRunActive(inspection)) {
      schedulePoll(inspection.runId);
    } else {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    }
  }, [state.inspection, schedulePoll]);

  const handleRunChecks = async () => {
    if (!canExecute || inFlightRef.current || state.actionInFlight !== 'idle') return;
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

  // Reports success only once the metadata editor draft has actually changed. When the editor asks
  // a human to confirm replacing an unsaved title, this stays in the "applying" state until they
  // decide: a pending confirmation is never reported as an applied suggestion.
  const handleApplyToDraft = async (candidateText: string) => {
    dispatch({ type: 'APPLY_STARTED' });
    const outcome = await applyTitleSuggestion(candidateText);
    if (!isMountedRef.current) return;
    if (outcome === 'applied') {
      dispatch({
        type: 'APPLY_COMPLETED',
        message: 'Suggestion applied to the metadata editor draft.',
        success: true,
      });
    } else if (outcome === 'cancelled') {
      dispatch({
        type: 'APPLY_COMPLETED',
        message: 'Suggestion not applied. The current title was kept.',
        success: false,
      });
    } else {
      dispatch({
        type: 'APPLY_FAILED',
        error: 'Could not apply the suggestion: the project information editor is not available for editing.',
      });
    }
  };

  const handleApplyLanguageToDraft = (
    finding: AssistiveInspectionFinding,
    replacement: string,
  ) => {
    if (finding.evidence.version !== 'assistive-finding-evidence/v3') return;
    dispatch({ type: 'APPLY_STARTED' });
    const applied = applyLanguageSuggestion({
      field: finding.affectedField as 'title' | 'summary' | 'background' | 'solution',
      startOffset: finding.evidence.startOffset,
      endOffset: finding.evidence.endOffset,
      offsetUnit: finding.evidence.offsetUnit,
      originalSourceSpan: finding.evidence.originalSourceSpan,
      replacement,
    });
    dispatch({
      type: 'APPLY_COMPLETED',
      message: applied
        ? 'Language suggestion applied to the metadata editor draft.'
        : 'Could not apply suggestion because the draft no longer matches this source span.',
      success: applied,
    });
  };

  const handleCopyText = async (textToCopy: string, findingId: string) => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(textToCopy);
      dispatch({ type: 'COPY_FEEDBACK', findingId, status: 'copied' });
      copyTimerRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          dispatch({ type: 'COPY_FEEDBACK', findingId: null, status: null });
        }
      }, 2000);
    } catch {
      dispatch({ type: 'COPY_FEEDBACK', findingId, status: 'failed' });
      copyTimerRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          dispatch({ type: 'COPY_FEEDBACK', findingId: null, status: null });
        }
      }, 4000);
    }
  };

  const isJobActive = isAssistiveRunActive(state.inspection);

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
              disabled={!canExecute || state.actionInFlight !== 'idle'}
              isLoading={state.actionInFlight === 'running'}
              title={
                !canExecute
                  ? unavailableMessage
                  : state.inspection
                  ? 'Re-evaluate project metadata against poster document evidence.'
                  : 'Start assistive checks.'
              }
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

      {/* Execution Environment Notice if unavailable */}
      {!canExecute && (
        <div className="mt-3 text-xs text-muted-foreground">
          {unavailableMessage} Historical findings remain viewable.
        </div>
      )}

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
            description="Project content or comparison data changed after this check. Re-run checks to evaluate the current project, poster evidence, and comparison records."
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

      {/* Degraded / Partial OCR Banner with Truthful Copy */}
      {state.inspection?.runStatus === 'PARTIAL' && (
        <div className="mt-4">
          <Alert
            variant="information"
            icon={Info}
            title="Partial check results"
            description={formatPartialNoticeDescription(state.inspection.failureCode)}
          />
        </div>
      )}

      {/* Main Content Area */}
      <div className="mt-5">
        {/* Read Failure State */}
        {state.readUnavailable && !state.inspection && !isJobActive && (
          <div className="rounded-lg border border-border bg-surface-inset p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Assistive checks are temporarily unavailable.</p>
            <p className="mt-1 text-xs">Could not load historical check results. You can still review and edit project information below.</p>
          </div>
        )}

        {/* No inspection yet -> Empty State */}
        {!state.readUnavailable && !state.inspection && !isJobActive && (
          <EmptyState
            icon={FileSearch}
            title="No assistive checks run yet"
            description={
              canExecute
                ? 'Run assistive checks to verify project title consistency and document formatting against uploaded poster evidence.'
                : unavailableMessage
            }
            action={
              <Button
                type="button"
                onClick={handleRunChecks}
                disabled={!canExecute || state.actionInFlight !== 'idle'}
                isLoading={state.actionInFlight === 'running'}
                title={
                  !canExecute
                    ? unavailableMessage
                    : 'Run checks now'
                }
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
            <Loader2 className="h-5 w-5 motion-safe:animate-spin text-primary" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-semibold text-foreground">
                {state.inspection?.jobStatus === 'EXTRACTING'
                  ? 'Extracting document text and metadata...'
                  : state.inspection?.jobStatus === 'CHECKING'
                  ? 'Analyzing document evidence and comparing similar projects...'
                  : 'Checks are queued and will start shortly...'}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Assistive checks run asynchronously. Status updates automatically while a worker is processing this run.
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
                {state.inspection.findings.map((finding: AssistiveInspectionFinding) => {
                  const outcome = formatOutcome(finding.outcome);
                  const disposition = formatDisposition(finding.disposition);
                  const canApply = isFindingEligibleToApply(
                    finding,
                    state.inspection!.staleState,
                    canEditMetadata,
                    canApplyTitleSuggestion,
                  );
                  const canApplyLanguage = isLanguageFindingEligibleToApply(
                    finding,
                    state.inspection!.staleState,
                    canEditMetadata,
                    canApplyLanguageSuggestion,
                  );
                  const isCopied = state.copiedFindingId === finding.findingId && state.copyStatus === 'copied';
                  const isCopyFailed = state.copiedFindingId === finding.findingId && state.copyStatus === 'failed';
                  const duplicateCandidates = finding.evidence.version === 'assistive-finding-evidence/v2'
                    ? finding.evidence.duplicateCandidates
                    : [];
                  const legacyEvidence = finding.evidence.version === 'assistive-finding-evidence/v1'
                    ? finding.evidence
                    : null;
                  const languageEvidence = finding.evidence.version === 'assistive-finding-evidence/v3'
                    ? finding.evidence
                    : null;
                  const copyableText = languageEvidence?.originalSourceSpan
                    || legacyEvidence?.candidateValue
                    || legacyEvidence?.evidenceExcerpt
                    || '';

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

                      {/* Finding Body / Explanation (rendered safely as plain text) */}
                      <div className="mt-3">
                        <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
                          {finding.evidence.explanation}
                        </p>
                      </div>

                      {finding.checkType === 'DUPLICATE_SHORTLIST' && duplicateCandidates.length > 0 && (
                        <div className="mt-3 rounded-md border border-border bg-surface-inset p-3 sm:p-4">
                          <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
                            These are the most lexically similar project records. Similarity is assistive evidence only;
                            staff decide whether projects are duplicates. A lexical score is not a confidence probability.
                          </p>
                          <ol className="mt-3 flex flex-col gap-3" aria-label="Similar project candidates">
                            {duplicateCandidates.map((candidate) => (
                              <li
                                key={candidate.publicId}
                                className="min-w-0 rounded-md border border-border bg-card p-3"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium text-muted-foreground">
                                      Candidate {candidate.rank} · {candidate.publicId}
                                    </p>
                                    <Link
                                      href={`/admin/projects/${encodeURIComponent(candidate.publicId)}`}
                                      className="mt-0.5 block break-words text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                      {candidate.title || '(Untitled project)'}
                                    </Link>
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {candidate.exactContentMatch && <Badge variant="warning">Exact content match</Badge>}
                                    {candidate.normalizedTitleMatch && <Badge variant="warning">Normalized title match</Badge>}
                                  </div>
                                </div>
                                {candidate.summaryExcerpt && (
                                  <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                                    {candidate.summaryExcerpt}
                                  </p>
                                )}
                                <p className="mt-2 font-mono text-[11px] text-foreground-subtle">
                                  Lexical similarity: {candidate.lexicalScore.toFixed(2)}
                                </p>
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {/* Title Candidate Comparison Block */}
                      {finding.checkType === 'TITLE_CONSISTENCY' && legacyEvidence?.candidateValue && (
                        <div className="mt-3 rounded-md border border-border bg-surface-inset p-3 text-xs sm:text-sm">
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div>
                              <span className="font-semibold text-foreground">Current metadata title:</span>
                              <p className="mt-1 break-words font-mono text-muted-foreground">
                                {legacyEvidence.metadataValue || '(none)'}
                              </p>
                            </div>
                            <div>
                              <span className="font-semibold text-foreground">Document candidate title:</span>
                              <p className="mt-1 break-words font-mono font-medium text-foreground">
                                {legacyEvidence.candidateValue}
                              </p>
                            </div>
                          </div>

                          {/* Technical details disclosure - no percentages or confidence wording */}
                          {finding.scoreValue !== null && (
                            <details className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                              <summary className="cursor-pointer rounded-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                                Technical diagnostic details
                              </summary>
                              <div className="mt-1 font-mono text-[11px]">
                                <p>Lexical similarity score: {finding.scoreValue.toFixed(2)}</p>
                                <p className="text-[10px] text-muted-foreground">Diagnostic evidence only — not confidence or accuracy.</p>
                                {legacyEvidence.pageNumber && (
                                  <p>Candidate located on page {legacyEvidence.pageNumber}</p>
                                )}
                              </div>
                            </details>
                          )}
                        </div>
                      )}

                      {/* Excerpt Block for other findings */}
                      {finding.checkType !== 'TITLE_CONSISTENCY' && legacyEvidence?.evidenceExcerpt && (
                        <div className="mt-3 rounded-md border border-border bg-surface-inset p-3 text-xs">
                          <span className="font-semibold text-foreground">Document excerpt:</span>
                          <blockquote className="mt-1 break-words font-mono text-muted-foreground whitespace-pre-wrap">
                            {legacyEvidence.evidenceExcerpt}
                          </blockquote>
                          {legacyEvidence.pageNumber && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Page {legacyEvidence.pageNumber}
                            </p>
                          )}
                        </div>
                      )}

                      {languageEvidence && (
                        <div className="mt-3 rounded-md border border-border bg-surface-inset p-3 text-xs sm:p-4 sm:text-sm">
                          <p className="font-semibold text-foreground">
                            {finding.affectedField.charAt(0).toUpperCase() + finding.affectedField.slice(1)} source span
                          </p>
                          <blockquote className="mt-1 break-words font-mono text-muted-foreground whitespace-pre-wrap">
                            {languageEvidence.originalSourceSpan || '(insert at this position)'}
                          </blockquote>
                          <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                            Context: {languageEvidence.contextExcerpt}
                          </p>
                          {languageEvidence.suggestions.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2" aria-label="Language suggestions">
                              {languageEvidence.suggestions.map((suggestion) => (
                              <Button
                                key={suggestion}
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={!canApplyLanguage || state.actionInFlight !== 'idle'}
                                onClick={() => handleApplyLanguageToDraft(finding, suggestion)}
                                title={state.inspection!.staleState !== 'CURRENT'
                                  ? 'Cannot apply a suggestion from an outdated run.'
                                  : `Apply this suggestion to the ${finding.affectedField} draft.`}
                              >
                                Apply “{suggestion}” to draft
                              </Button>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-3 text-xs text-muted-foreground">
                              No safe automatic replacement was provided. Review this issue directly in the metadata editor.
                            </p>
                          )}
                          <details className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                            <summary className="cursor-pointer rounded-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">Technical diagnostic details</summary>
                            <div className="mt-1 font-mono text-[11px]">
                              <p>LanguageTool {languageEvidence.providerVersion} · rule {languageEvidence.ruleId}</p>
                              <p>Offsets: {languageEvidence.startOffset}–{languageEvidence.endOffset} Unicode code points</p>
                              <p className="text-[10px] text-muted-foreground">Assistive evidence only — staff review remains authoritative.</p>
                            </div>
                          </details>
                        </div>
                      )}

                      {/* Action Bar */}
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                        {/* Copy & Apply Draft Actions */}
                        <div className="flex flex-wrap items-center gap-2">
                          {copyableText && (
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  handleCopyText(
                                    copyableText,
                                    finding.findingId,
                                  )
                                }
                              >
                                {isCopied ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                                    <span>Copied</span>
                                  </>
                                ) : isCopyFailed ? (
                                  <>
                                    <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                                    <span>Copy failed</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                    <span>Copy text</span>
                                  </>
                                )}
                              </Button>
                              {/*
                                A blocked or unavailable clipboard is reported rather than swallowed, and it is
                                announced politely so the outcome does not depend on noticing the button relabel.
                              */}
                              <span role="status" aria-live="polite" className="text-xs text-destructive">
                                {isCopyFailed ? 'Could not copy text. Select the text above and copy it manually.' : ''}
                              </span>
                            </div>
                          )}

                          {finding.checkType === 'TITLE_CONSISTENCY' && legacyEvidence?.candidateValue && (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={!canApply || state.actionInFlight !== 'idle'}
                              onClick={() => { void handleApplyToDraft(legacyEvidence.candidateValue!); }}
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
