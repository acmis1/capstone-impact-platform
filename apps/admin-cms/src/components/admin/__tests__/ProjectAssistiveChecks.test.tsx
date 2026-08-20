/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AssistiveInspectionView, StoredAssistiveFinding } from '../../../assistive-validation';
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

const sampleFinding = (overrides: Partial<StoredAssistiveFinding> = {}): StoredAssistiveFinding => ({
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
  reviewedBy: null,
  reviewedAt: null,
  createdAt: '2026-08-21T09:00:00.000Z',
  ...overrides,
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

afterEach(cleanup);

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
    const cancelBtn = screen.getByRole('button', { name: /Cancel checks/i });
    expect(cancelBtn).toBeTruthy();

    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(assistiveActions.cancelAssistiveChecksAction).toHaveBeenCalledWith(PUBLIC_ID, RUN_ID);
    });
  });

  it('displays warning banner when check results are STALE', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection({
          staleState: 'STALE',
        })}
      />,
    );

    expect(screen.getByText('Results may be outdated')).toBeTruthy();
    expect(
      screen.getByText(/This check was performed on earlier project content/i),
    ).toBeTruthy();
  });

  it('displays degraded/PARTIAL mode banner when OCR was unavailable', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection({
          runStatus: 'PARTIAL',
          jobStatus: 'PARTIAL',
        })}
      />,
    );

    expect(screen.getByText('Partial check results')).toBeTruthy();
    expect(
      screen.getByText(/OCR text extraction is unavailable in this environment/i),
    ).toBeTruthy();
  });

  it('renders findings list with candidate comparisons and safe literal text', () => {
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
    expect(screen.getByText('Smart Urban Analytics')).toBeTruthy();
    expect(screen.getByText('Similarity score: 85%')).toBeTruthy();
  });

  it('renders untrusted text safely as plain text without interpretation', () => {
    const maliciousText = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection({
          findings: [
            sampleFinding({
              evidence: {
                ...sampleFinding().evidence,
                candidateValue: maliciousText,
                explanation: maliciousText,
              },
            }),
          ],
        })}
      />,
    );

    // Literal script tags should exist in text content and not in DOM executable elements
    expect(screen.getAllByText(maliciousText).length).toBeGreaterThan(0);
    expect(document.querySelector('script[src*="xss"]')).toBeNull();
  });

  it('copies candidate text to clipboard and displays temporary confirmation', async () => {
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

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Smart Urban Analytics & AI');
    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeTruthy();
    });
  });

  it('records reviewer disposition when Mark reviewed or Ignore is clicked', async () => {
    vi.mocked(assistiveActions.recordAssistiveDispositionAction).mockResolvedValueOnce({
      ok: true,
      findingId: FINDING_ID,
      disposition: 'REVIEWED',
      reviewedAt: '2026-08-21T09:10:00.000Z',
      reviewedBy: 'admin-1',
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

  it('hides reviewer disposition buttons when staff lacks review permission (canReview=false)', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={false} // Editor without review rights
        initialInspection={sampleInspection()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Mark reviewed/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ignore/i })).toBeNull();
  });

  it('disables Apply to draft button when the run is STALE', () => {
    renderWithNavigation(
      <ProjectAssistiveChecks
        publicId={PUBLIC_ID}
        canEditMetadata={true}
        canReview={true}
        initialInspection={sampleInspection({
          staleState: 'STALE',
        })}
      />,
    );

    const applyBtn = screen.getByRole('button', { name: /Apply to draft/i });
    expect((applyBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
