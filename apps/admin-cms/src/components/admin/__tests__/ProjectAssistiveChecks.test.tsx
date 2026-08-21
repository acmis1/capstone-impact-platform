/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AssistiveInspectionFinding, AssistiveInspectionView } from '../../../assistive-validation';
import * as assistiveActions from '../../../app/admin/projects/[publicId]/assistiveActions';
import { ProjectAssistiveChecks } from '../ProjectAssistiveChecks';
import { ProjectMetadataNavigationProvider } from '../ProjectMetadataNavigation';

vi.mock('../../../app/admin/projects/[publicId]/assistiveActions', () => ({
  runAssistiveChecksAction: vi.fn(),
  cancelAssistiveChecksAction: vi.fn(),
  recordAssistiveDispositionAction: vi.fn(),
  getAssistiveInspectionAction: vi.fn(),
}));

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const FINDING_ID = '33333333-3333-4333-8333-333333333333';
const PUBLIC_ID = 'PRJ-101';

const sampleFinding = (overrides: Partial<AssistiveInspectionFinding> = {}): AssistiveInspectionFinding => ({
  findingId: FINDING_ID,
  ordinal: 1,
  checkType: 'TITLE_CONSISTENCY',
  outcome: 'REVIEW',
  classification: 'NON_BLOCKING',
  reasonCode: 'MATERIAL_TOKEN_DIFFERENCE',
  affectedField: 'title',
  origin: 'DETERMINISTIC_HELPER',
  scoreKind: 'LEXICAL_SIMILARITY',
  scoreValue: 0.85,
  evidence: {
    version: 'assistive-finding-evidence/v1',
    evidenceExcerpt: 'Smart Urban Analytics & AI',
    pageNumber: 1,
    boundingBox: null,
    metadataValue: 'Smart Urban Analytics',
    normalizedMetadataValue: 'smart urban analytics',
    candidateValue: 'Smart Urban Analytics & AI',
    normalizedCandidateValue: 'smart urban analytics and ai',
    explanation: 'Poster title includes additional AI suffix.',
  },
  disposition: 'UNREVIEWED',
  createdAt: '2026-08-21T09:00:00.000Z',
  ...overrides,
});

const duplicateFinding = (): AssistiveInspectionFinding => ({
  findingId: '55555555-5555-4555-8555-555555555555',
  ordinal: 2,
  checkType: 'DUPLICATE_SHORTLIST',
  outcome: 'REVIEW',
  classification: 'NON_BLOCKING',
  reasonCode: 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT',
  affectedField: 'project_content',
  origin: 'DETERMINISTIC_HELPER',
  scoreKind: null,
  scoreValue: null,
  evidence: {
    version: 'assistive-finding-evidence/v2',
    evidenceExcerpt: null,
    pageNumber: null,
    boundingBox: null,
    metadataValue: null,
    normalizedMetadataValue: null,
    candidateValue: null,
    normalizedCandidateValue: null,
    explanation: 'Review these lexically similar project records.',
    duplicateCandidates: Array.from({ length: 5 }, (_, index) => ({
      rank: index + 1,
      publicId: `2026-similar-${index + 1}`,
      title: index === 0 ? '<img src=x onerror=alert(1)> Similar Project' : `Similar Project ${index + 1}`,
      summaryExcerpt: `Bounded synthetic summary ${index + 1}.`,
      // Coherent with the persisted contract: the exact match implies the normalized-title match
      // and scores 1, every other candidate is capped below it, and scores descend by rank.
      lexicalScore: index === 0 ? 1 : Number((0.85 - index * 0.1).toFixed(2)),
      exactContentMatch: index === 0,
      normalizedTitleMatch: index <= 1,
    })),
  },
  disposition: 'UNREVIEWED',
  createdAt: '2026-08-21T09:00:00.000Z',
});

const sampleInspection = (overrides: Partial<AssistiveInspectionView> = {}): AssistiveInspectionView => ({
  runId: RUN_ID,
  runStatus: 'COMPLETED',
  jobStatus: 'COMPLETED',
  attemptCount: 1,
  failureCode: null,
  cancellationRequested: false,
  createdAt: '2026-08-21T09:00:00.000Z',
  startedAt: '2026-08-21T09:00:01.000Z',
  completedAt: '2026-08-21T09:00:05.000Z',
  findings: [sampleFinding()],
  staleState: 'CURRENT',
  ...overrides,
});

function renderWithNavigation(ui: React.ReactElement) {
  return render(<ProjectMetadataNavigationProvider>{ui}</ProjectMetadataNavigationProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ProjectAssistiveChecks Component', () => {
  it('renders the initial empty state when no checks have been run', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={null}
      />,
    );

    expect(screen.getByText('Assistive checks')).toBeTruthy();
    expect(screen.getByText('No assistive checks run yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run checks now/i })).toBeTruthy();
  });

  it('renders read-unavailable message when initialReadFailed is true', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={null}
        initialReadFailed={true}
      />,
    );

    expect(screen.getByText('Assistive checks are temporarily unavailable.')).toBeTruthy();
    expect(screen.queryByText('No assistive checks run yet')).toBeNull();
  });

  it('synchronizes a recovered server read from unavailable to empty history', async () => {
    const { rerender } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={null}
        initialReadFailed={true}
      />,
    );

    rerender(
      <ProjectMetadataNavigationProvider>
        <ProjectAssistiveChecks
          publicId={PUBLIC_ID}
          canEditMetadata={true}
          canReview={true}
          initialInspection={null}
          initialReadFailed={false}
        />
      </ProjectMetadataNavigationProvider>,
    );

    await waitFor(() => expect(screen.getByText('No assistive checks run yet')).toBeTruthy());
    expect(screen.queryByText('Assistive checks are temporarily unavailable.')).toBeNull();
  });

  it('synchronizes a failed server read from empty history to unavailable', async () => {
    const { rerender } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={null}
        initialReadFailed={false}
      />,
    );

    rerender(
      <ProjectMetadataNavigationProvider>
        <ProjectAssistiveChecks
          publicId={PUBLIC_ID}
          canEditMetadata={true}
          canReview={true}
          initialInspection={null}
          initialReadFailed={true}
        />
      </ProjectMetadataNavigationProvider>,
    );

    await waitFor(() => expect(screen.getByText('Assistive checks are temporarily unavailable.')).toBeTruthy());
    expect(screen.queryByText('No assistive checks run yet')).toBeNull();
  });

  it('renders disabled button and truthful message when canExecute is false', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        canExecute={false}
        initialInspection={null}
      />,
    );

    const button = screen.getByRole('button', { name: /Run checks now/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText(/Running assistive checks is not available in this environment/i).length).toBeGreaterThan(0);
  });

  it('triggers runAssistiveChecksAction when Run checks button is clicked', async () => {
    vi.mocked(assistiveActions.runAssistiveChecksAction).mockResolvedValueOnce({
      ok: true,
      runId: RUN_ID,
      status: 'QUEUED',
    });
    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValueOnce({
      ok: true,
      found: true,
      inspection: sampleInspection({
        runStatus: 'QUEUED',
        jobStatus: 'QUEUED',
        findings: [],
      }),
    });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={null}
      />,
    );

    const runBtn = screen.getByRole('button', { name: /Run checks now/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(assistiveActions.runAssistiveChecksAction).toHaveBeenCalledWith(PUBLIC_ID);
    });
  });

  it('renders active in-flight status and allows cancellation', async () => {
    vi.mocked(assistiveActions.cancelAssistiveChecksAction).mockResolvedValueOnce({ ok: true });
    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValueOnce({
      ok: true,
      found: true,
      inspection: sampleInspection({
        runStatus: 'CANCELLED',
        jobStatus: 'CANCELLED',
      }),
    });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection({
          runStatus: 'RUNNING',
          jobStatus: 'EXTRACTING',
        })}
      />,
    );

    expect(screen.getByText('Extracting document text and metadata...')).toBeTruthy();
    expect(screen.getByText(/Status updates automatically/i)).toBeTruthy();

    const cancelBtn = screen.getByRole('button', { name: /Cancel checks/i });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(assistiveActions.cancelAssistiveChecksAction).toHaveBeenCalledWith(PUBLIC_ID, RUN_ID);
    });
  });

  it('renders findings, candidate comparison, and safe plain text without percentages or confidence claims', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection()}
      />,
    );

    expect(screen.getByText('Project title')).toBeTruthy();
    expect(screen.getByText('Review suggested')).toBeTruthy();
    expect(screen.getByText('Smart Urban Analytics & AI')).toBeTruthy();
    expect(screen.getByText('Poster title includes additional AI suffix.')).toBeTruthy();

    // Verify absence of misleading confidence / percentage claims
    expect(screen.queryByText(/Similarity score: 85%/i)).toBeNull();
    expect(screen.queryByText(/85%/)).toBeNull();
    expect(screen.queryByText(/AI confidence/i)).toBeNull();
    expect(screen.queryByText(/Confidence score/i)).toBeNull();
  });

  it('renders one bounded similar-project shortlist with literal text, internal links, and no Apply to draft', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection({ findings: [duplicateFinding()] })}
      />,
    );

    expect(screen.getByText('Similar projects')).toBeTruthy();
    expect(screen.getByText(/Similarity is assistive evidence only/i)).toBeTruthy();
    expect(screen.getByText(/not a confidence probability/i)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(6); // one finding plus five ordered candidates
    expect(screen.getByText('<img src=x onerror=alert(1)> Similar Project')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: '<img src=x onerror=alert(1)> Similar Project' });
    expect(link.getAttribute('href')).toBe('/admin/projects/2026-similar-1');
    expect(screen.getByText('Exact content match')).toBeTruthy();
    // An exact content match also matches the normalized title, so both badges appear on rank 1.
    expect(screen.getAllByText('Normalized title match')).toHaveLength(2);
    expect(screen.getByText('Lexical similarity: 1.00')).toBeTruthy();
    expect(screen.getByText('Lexical similarity: 0.75')).toBeTruthy();
    expect(screen.queryByText(/75%/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply to draft/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Mark reviewed/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ignore/i })).toBeTruthy();
  });

  it('records reviewer disposition without exposing staff UUIDs', async () => {
    vi.mocked(assistiveActions.recordAssistiveDispositionAction).mockResolvedValueOnce({
      ok: true,
      findingId: FINDING_ID,
      disposition: 'REVIEWED',
    });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection()}
      />,
    );

    const markReviewedBtn = screen.getByRole('button', { name: /Mark reviewed/i });
    fireEvent.click(markReviewedBtn);

    await waitFor(() => {
      expect(assistiveActions.recordAssistiveDispositionAction).toHaveBeenCalledWith(
        PUBLIC_ID,
        RUN_ID,
        FINDING_ID,
        'REVIEWED',
      );
    });
  });

  it('handles clipboard failure gracefully and provides accessible feedback', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Permission denied'));

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection()}
      />,
    );

    const copyBtn = screen.getByRole('button', { name: /Copy text/i });
    fireEvent.click(copyBtn);

    // The failure is announced through a live region rather than only relabelling the button, so a
    // screen-reader user learns the copy did not happen without re-inspecting the control.
    await waitFor(() => {
      const status = screen.getByRole('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.textContent).toMatch(/Could not copy text\. Select the text above and copy it manually\./i);
    });
    expect(screen.getByRole('button', { name: /Copy failed/i })).toBeTruthy();
  });
});

describe('Mandatory Polling Lifecycle Tests (Scenarios A through G)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Scenario A: initial EXTRACTING -> 2.5s -> poll returns EXTRACTING -> another 2.5s -> SECOND poll occurs', async () => {
    const activeInspection = sampleInspection({
      runStatus: 'RUNNING',
      jobStatus: 'EXTRACTING',
    });

    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValue({
      ok: true,
      found: true,
      inspection: activeInspection,
    });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={activeInspection}
      />,
    );

    // Initial state: no poll yet
    expect(assistiveActions.getAssistiveInspectionAction).not.toHaveBeenCalled();

    // Advance 2.5s -> first poll
    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(1);

    // Advance another 2.5s -> second poll definitely occurs on unchanged EXTRACTING state
    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(2);
  });

  it('Scenario B: EXTRACTING -> EXTRACTING -> CHECKING -> CHECKING -> COMPLETED stops polling', async () => {
    const runExtracting = sampleInspection({ runStatus: 'RUNNING', jobStatus: 'EXTRACTING' });
    const runChecking = sampleInspection({ runStatus: 'RUNNING', jobStatus: 'CHECKING' });
    const runCompleted = sampleInspection({ runStatus: 'COMPLETED', jobStatus: 'COMPLETED' });

    vi.mocked(assistiveActions.getAssistiveInspectionAction)
      .mockResolvedValueOnce({ ok: true, found: true, inspection: runExtracting })
      .mockResolvedValueOnce({ ok: true, found: true, inspection: runChecking })
      .mockResolvedValueOnce({ ok: true, found: true, inspection: runChecking })
      .mockResolvedValueOnce({ ok: true, found: true, inspection: runCompleted });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={runExtracting}
      />,
    );

    // Poll 1: returns EXTRACTING
    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(1);

    // Poll 2: returns CHECKING
    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(2);

    // Poll 3: returns CHECKING
    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(3);

    // Poll 4: returns COMPLETED (terminal)
    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(4);

    // Advance further -> no more polls occur
    await vi.advanceTimersByTimeAsync(10000);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(4);
  });

  it('Scenario C: slow poll request does not overlap concurrent poll requests', async () => {
    let resolveFirstPoll!: (val: unknown) => void;
    const firstPollPromise = new Promise((resolve) => {
      resolveFirstPoll = resolve;
    });

    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockReturnValueOnce(
      firstPollPromise as Promise<assistiveActions.GetAssistiveInspectionActionResult>,
    );

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection({ runStatus: 'RUNNING', jobStatus: 'EXTRACTING' })}
      />,
    );

    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(1);

    // Time elapses while first poll is still unresolved
    await vi.advanceTimersByTimeAsync(5000);
    // Should NOT trigger a second request while first is in flight
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(1);

    // Resolve first poll with terminal status
    resolveFirstPoll({
      ok: true,
      found: true,
      inspection: sampleInspection({ runStatus: 'COMPLETED', jobStatus: 'COMPLETED' }),
    });
    await vi.advanceTimersByTimeAsync(0);

    // Advance more -> still 1 call
    await vi.advanceTimersByTimeAsync(5000);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(1);
  });

  it('Scenario D: unmount clears pending timer and stops polling', async () => {
    const activeInspection = sampleInspection({ runStatus: 'RUNNING', jobStatus: 'EXTRACTING' });
    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValue({
      ok: true,
      found: true,
      inspection: activeInspection,
    });

    const { unmount } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={activeInspection}
      />,
    );

    unmount();

    await vi.advanceTimersByTimeAsync(10000);
    expect(assistiveActions.getAssistiveInspectionAction).not.toHaveBeenCalled();
  });

  it('Scenario E: runId replacement stops polling the old ID', async () => {
    const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const inspectionA = sampleInspection({ runId: RUN_A, runStatus: 'RUNNING', jobStatus: 'EXTRACTING' });
    const inspectionB = sampleInspection({ runId: RUN_B, runStatus: 'RUNNING', jobStatus: 'CHECKING' });

    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValue({
      ok: true,
      found: true,
      inspection: inspectionB,
    });

    const { rerender } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={inspectionA}
      />,
    );

    // Update server prop to Run B
    rerender(
      <ProjectMetadataNavigationProvider>
        <ProjectAssistiveChecks
          publicId={PUBLIC_ID}
          canEditMetadata={true}
          canReview={true}
          initialInspection={inspectionB}
        />
      </ProjectMetadataNavigationProvider>,
    );

    await vi.advanceTimersByTimeAsync(2500);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledWith(PUBLIC_ID, RUN_B);
  });

  it('Scenario F: transient read failure preserves last known inspection and retries', async () => {
    const activeInspection = sampleInspection({ runStatus: 'RUNNING', jobStatus: 'EXTRACTING' });

    vi.mocked(assistiveActions.getAssistiveInspectionAction)
      .mockRejectedValueOnce(new Error('Network glitch'))
      .mockResolvedValueOnce({
        ok: true,
        found: true,
        inspection: sampleInspection({ runStatus: 'COMPLETED', jobStatus: 'COMPLETED' }),
      });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={activeInspection}
      />,
    );

    // Poll 1 fails
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Extracting document text and metadata...')).toBeTruthy();

    // Poll 2 succeeds
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText('Extracting document text and metadata...')).toBeNull();
  });

  it('Scenario G: terminal initial state never starts polling', async () => {
    const terminalInspection = sampleInspection({ runStatus: 'COMPLETED', jobStatus: 'COMPLETED' });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={terminalInspection}
      />,
    );

    await vi.advanceTimersByTimeAsync(10000);
    expect(assistiveActions.getAssistiveInspectionAction).not.toHaveBeenCalled();
  });

  it('Scenario H: active NOT_FOUND exits the spinner, reports the missing run, and stops polling', async () => {
    const activeInspection = sampleInspection({ runStatus: 'RUNNING', jobStatus: 'EXTRACTING' });
    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValueOnce({ ok: true, found: false });

    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={activeInspection}
      />,
    );

    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByText('Extracting document text and metadata...')).toBeNull();
    expect(screen.getByText('This assistive check run is no longer available. Refresh or run checks again.')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(10000);
    expect(assistiveActions.getAssistiveInspectionAction).toHaveBeenCalledTimes(1);
  });
});

describe('Stale Prop Synchronization Tests (Blocker 3)', () => {
  it('updates UI when server refreshes with STALE status for the same run', () => {
    const runA_Current = sampleInspection({ staleState: 'CURRENT' });
    const runA_Stale = sampleInspection({ staleState: 'STALE' });

    const { rerender } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={runA_Current}
      />,
    );

    expect(screen.queryByText('Results may be outdated')).toBeNull();

    // Server refresh passes updated prop
    rerender(
      <ProjectMetadataNavigationProvider>
        <ProjectAssistiveChecks
          publicId={PUBLIC_ID}
          canEditMetadata={true}
          canReview={true}
          initialInspection={runA_Stale}
        />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByText('Results may be outdated')).toBeTruthy();
  });

  /**
   * `router.refresh()` after a metadata save re-renders this component with whatever run the server
   * read. That read can land after the staff member has already started a newer run here, so the
   * prop must not be allowed to reinstate the older run and lose the one actually in flight.
   */
  it('ignores a late server prop describing an older run than one started locally', async () => {
    const olderRun = sampleInspection({
      runId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-08-21T09:00:00.000Z',
      staleState: 'STALE',
    });
    const newerRun = sampleInspection({
      runId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-08-21T10:00:00.000Z',
      staleState: 'CURRENT',
      runStatus: 'RUNNING',
      jobStatus: 'EXTRACTING',
      findings: [],
    });

    vi.mocked(assistiveActions.runAssistiveChecksAction).mockResolvedValueOnce({
      ok: true,
      runId: newerRun.runId,
      status: 'QUEUED',
    });
    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValueOnce({
      ok: true,
      found: true,
      inspection: newerRun,
    });

    const { rerender } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={olderRun}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Re-run checks/i }));
    await waitFor(() => expect(screen.getByText('Extracting document text and metadata...')).toBeTruthy());

    rerender(
      <ProjectMetadataNavigationProvider>
        <ProjectAssistiveChecks
          publicId={PUBLIC_ID}
          canEditMetadata={true}
          canReview={true}
          initialInspection={{ ...olderRun }}
        />
      </ProjectMetadataNavigationProvider>,
    );

    // The stale banner belongs to the superseded server run; the locally started run remains active.
    expect(screen.queryByText('Results may be outdated')).toBeNull();
    expect(screen.getByText('Extracting document text and metadata...')).toBeTruthy();
  });

  it('does not erase a newer locally started run when a read-failure prop arrives', async () => {
    const newerRun = sampleInspection({
      runId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-08-21T10:00:00.000Z',
      runStatus: 'RUNNING',
      jobStatus: 'EXTRACTING',
      findings: [],
    });
    vi.mocked(assistiveActions.runAssistiveChecksAction).mockResolvedValueOnce({
      ok: true,
      runId: newerRun.runId,
      status: 'QUEUED',
    });
    vi.mocked(assistiveActions.getAssistiveInspectionAction).mockResolvedValueOnce({
      ok: true,
      found: true,
      inspection: newerRun,
    });

    const { rerender } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={null}
        initialReadFailed={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Run checks now/i }));
    await waitFor(() => expect(screen.getByText('Extracting document text and metadata...')).toBeTruthy());

    rerender(
      <ProjectMetadataNavigationProvider>
        <ProjectAssistiveChecks
          publicId={PUBLIC_ID}
          canEditMetadata={true}
          canReview={true}
          initialInspection={null}
          initialReadFailed={true}
        />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByText('Extracting document text and metadata...')).toBeTruthy();
    expect(screen.queryByText('Assistive checks are temporarily unavailable.')).toBeNull();
  });

  it('updates UI when server refreshes with UNVERIFIABLE status', () => {
    const runA_Current = sampleInspection({ staleState: 'CURRENT' });
    const runA_Unverifiable = sampleInspection({ staleState: 'UNVERIFIABLE' });

    const { rerender } = renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={runA_Current}
      />,
    );

    rerender(
      <ProjectMetadataNavigationProvider>
        <ProjectAssistiveChecks
          publicId={PUBLIC_ID}
          canEditMetadata={true}
          canReview={true}
          initialInspection={runA_Unverifiable}
        />
      </ProjectMetadataNavigationProvider>,
    );

    expect(screen.getByText('Document evidence unverifiable')).toBeTruthy();
  });
});
