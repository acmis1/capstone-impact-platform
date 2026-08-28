/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalArchivePanel } from './LocalArchivePanel';
import { PublicationPreparationPanel } from './PublicationPreparationPanel';
import { PublicationReadinessPanel, deriveReadinessChecklist } from './PublicationReadinessPanel';
import { translateOperation } from '../../app/admin/public-feed/page';
import type { PublicationReadinessResult } from '../../domain/publicationReadiness';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const PLAN = {
  publicId: '2026-agri-iot',
  confirmedPreviewId: 'preview-123',
  confirmedAt: '2026-08-16T08:00:00.000Z',
  recordCount: 2,
  feedHash: 'feed-hash',
  feedPublicUrl: 'http://127.0.0.1:54321/storage/v1/object/public/public-feeds/capstones-latest.json',
};

const SUCCESS = {
  resultCode: 'COMPLETED' as const,
  publicId: '2026-agri-iot',
  snapshotId: 'snapshot-123',
  recordCount: 2,
  feedHash: 'feed-hash',
};

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockReset();
});

afterEach(cleanup);

describe('PublicationReadinessPanel', () => {
  it('fails closed when readiness is unavailable', () => {
    render(<PublicationReadinessPanel readiness={null} />);
    expect(screen.getByText(/Publication readiness unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/Ready to publish/i)).toBeNull();
  });

  it.each<[PublicationReadinessResult['resultCode'], string]>([
    ['NO_ACTIVE_PREVIEW', 'Participant preview required'],
    ['PREVIEW_NOT_CONFIRMED', 'Waiting for participant confirmation'],
    ['CORRECTION_UNRESOLVED', 'Participant correction requires resolution'],
    ['CORRECTED_PREVIEW_AWAITING_CONFIRMATION', 'Corrected preview awaiting confirmation'],
    ['PROJECT_SNAPSHOT_STALE', 'Project information changed after confirmation'],
    ['MEDIA_SNAPSHOT_STALE', 'Project media changed after confirmation'],
    ['INVALID_PROJECT_STATE', 'Project must be approved'],
    ['PROJECT_NOT_FOUND', 'Project unavailable'],
    ['READINESS_PERMISSION_DENIED', 'Publishing permission required'],
    ['INVALID_SELECTION', 'Readiness check unavailable'],
    ['INVALID_PRIVATE_BUCKET', 'Readiness check unavailable'],
    ['READINESS_UNAVAILABLE', 'Readiness check unavailable'],
  ])('presents %s as a blocking state', (resultCode, expectedText) => {
    render(<PublicationReadinessPanel readiness={{ ready: false, resultCode, blockers: ['Authoritative blocker'] }} />);
    expect(screen.getByText(expectedText)).toBeTruthy();
    expect(screen.getByText('Authoritative blocker')).toBeTruthy();
    expect(screen.queryByText(/Ready to publish/i)).toBeNull();
  });

  it('shows authoritative READY evidence and the confirmation time', () => {
    render(<PublicationReadinessPanel readiness={{ ready: true, resultCode: 'READY', blockers: [], confirmedAt: PLAN.confirmedAt }} />);
    expect(screen.getByText('Ready to publish')).toBeTruthy();
    expect(screen.getByText(/^Confirmed \d/)).toBeTruthy();
    expect(screen.getByText('Project approved')).toBeTruthy();
    expect(screen.getByText('Project details and media match confirmation')).toBeTruthy();
  });

  it('places technical result codes behind technical disclosure', () => {
    render(<PublicationReadinessPanel readiness={{ ready: true, resultCode: 'READY', blockers: [], confirmedAt: PLAN.confirmedAt }} />);
    expect(screen.getByText('Technical details')).toBeTruthy();
    expect(screen.getByText('READY')).toBeTruthy();
  });

  describe('deriveReadinessChecklist authoritative state mapping', () => {
    it.each<[
      PublicationReadinessResult['resultCode'],
      boolean,
      string | undefined,
      'passed' | 'failed' | 'unverified',
      'passed' | 'failed' | 'unverified',
      'passed' | 'failed' | 'unverified'
    ]>([
      // [resultCode, ready, confirmedAt, expectedApproved, expectedConfirmed, expectedDetailsMatch]
      ['READY', true, '2026-08-16T08:00:00.000Z', 'passed', 'passed', 'passed'],
      ['PROJECT_SNAPSHOT_STALE', false, '2026-08-16T08:00:00.000Z', 'passed', 'passed', 'failed'],
      ['MEDIA_SNAPSHOT_STALE', false, '2026-08-16T08:00:00.000Z', 'passed', 'passed', 'failed'],
      ['NO_ACTIVE_PREVIEW', false, undefined, 'passed', 'failed', 'unverified'],
      ['PREVIEW_NOT_CONFIRMED', false, undefined, 'passed', 'failed', 'unverified'],
      ['CORRECTED_PREVIEW_AWAITING_CONFIRMATION', false, undefined, 'passed', 'failed', 'unverified'],
      ['INVALID_PROJECT_STATE', false, undefined, 'failed', 'unverified', 'unverified'],
      ['CORRECTION_UNRESOLVED', false, '2026-08-16T08:00:00.000Z', 'unverified', 'unverified', 'unverified'],
      ['PROJECT_NOT_FOUND', false, undefined, 'unverified', 'unverified', 'unverified'],
      ['READINESS_PERMISSION_DENIED', false, undefined, 'unverified', 'unverified', 'unverified'],
      ['INVALID_SELECTION', false, undefined, 'unverified', 'unverified', 'unverified'],
      ['INVALID_PRIVATE_BUCKET', false, undefined, 'unverified', 'unverified', 'unverified'],
      ['READINESS_UNAVAILABLE', false, undefined, 'unverified', 'unverified', 'unverified'],
    ])('maps %s to approved=%s, confirmed=%s, detailsMatch=%s', (
      resultCode, ready, confirmedAt, expectedApproved, expectedConfirmed, expectedDetailsMatch,
    ) => {
      const checklist = deriveReadinessChecklist({
        ready,
        resultCode,
        blockers: [],
        confirmedAt,
      });
      expect(checklist.approved).toBe(expectedApproved);
      expect(checklist.confirmed).toBe(expectedConfirmed);
      expect(checklist.detailsMatch).toBe(expectedDetailsMatch);
    });

    it('proves CORRECTION_UNRESOLVED cannot accidentally render a green Project approved check', () => {
      render(<PublicationReadinessPanel readiness={{
        ready: false,
        resultCode: 'CORRECTION_UNRESOLVED',
        blockers: ['Participant correction must be resolved'],
        confirmedAt: PLAN.confirmedAt,
      }} />);
      // Should show '○' unverified for Project approved, NOT '✓'
      const passedTicks = screen.queryAllByText('Passed');
      expect(passedTicks).toHaveLength(0);
      const unverifiedItems = screen.getAllByText('Not yet verified');
      expect(unverifiedItems.length).toBeGreaterThanOrEqual(1);
    });

    it('proves permission denied and unavailable states do not fabricate positive facts', () => {
      render(<PublicationReadinessPanel readiness={{
        ready: false,
        resultCode: 'READINESS_PERMISSION_DENIED',
        blockers: ['Permission denied'],
      }} />);
      expect(screen.queryAllByText('Passed')).toHaveLength(0);
      expect(screen.getAllByText('Not yet verified')).toHaveLength(3);
    });

    it('exposes each checklist state as real text rather than an aria-label on a bare span', () => {
      const { container } = render(<PublicationReadinessPanel readiness={{
        ready: false,
        resultCode: 'PREVIEW_NOT_CONFIRMED',
        blockers: ['Participant confirmation is required'],
      }} />);

      const items = screen.getAllByRole('listitem');
      const approved = items.find((item) => item.textContent?.includes('Project approved'));
      const confirmed = items.find((item) => item.textContent?.includes('Participant confirmation received'));
      // State reaches assistive technology through the item's own text content.
      expect(approved?.textContent).toContain('Passed');
      expect(confirmed?.textContent).toContain('Needs attention');

      // Glyphs are decorative only, and no state is announced via aria-label on a generic span.
      expect(container.querySelector('span[aria-label]')).toBeNull();
      for (const glyph of ['✓', '✕', '○']) {
        const node = [...container.querySelectorAll('span')].find((span) => span.textContent === glyph);
        if (node) expect(node.getAttribute('aria-hidden')).toBe('true');
      }
    });
  });
});

describe('PublicationPreparationPanel', () => {
  it('does not render publication mutations without permission or readiness', () => {
    const { rerender } = render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare={false} executionTarget="local" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PublicationPreparationPanel publicId={PLAN.publicId} ready={false} canPrepare executionTarget="local" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('generates a plan through the exact POST endpoint without mislabeling its record count as publication state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: PLAN }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Review publication/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/2026-agri-iot/publication-plan', { method: 'POST' }));
    expect(await screen.findByText(/Review complete\. Nothing has been published yet\./i)).toBeTruthy();
    expect(screen.getByText('Review artifact record count:')).toBeTruthy();
    expect(screen.queryByText('Projects on showcase')).toBeNull();
    expect(screen.queryByText('Projects published')).toBeNull();
    expect(screen.queryByText('Projects after publication')).toBeNull();
    expect(screen.queryByText(/Publish to local test showcase/i)).toBeNull();
  });

  it('requires acknowledgement before executing local publication and preserves the exact request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: SUCCESS }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="local" />);

    fireEvent.click(screen.getByRole('button', { name: /Review publication/i }));
    const executeButton = await screen.findByRole('button', { name: /Publish to local test showcase/i });
    expect((executeButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(executeButton);

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/projects/2026-agri-iot/local-publication', { method: 'POST' }));
    expect(await screen.findByText('Published locally')).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('identifies an already-completed local publication without claiming another publication', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: { ...SUCCESS, resultCode: 'ALREADY_COMPLETED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="local" />);

    fireEvent.click(screen.getByRole('button', { name: /Review publication/i }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Publish to local test showcase/i }));
    expect(await screen.findByText('Already published locally')).toBeTruthy();
  });

  it('labels staging publication without claiming Duda visibility and shows a verification reminder', async () => {
    const stagingSuccess = {
      ...SUCCESS,
      feedPublicUrl: 'https://synthetic-pp1-staging.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: stagingSuccess }) });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="staging" />);

    fireEvent.click(screen.getByRole('button', { name: /Review publication/i }));
    expect(await screen.findByRole('heading', { name: 'Publish to test showcase' })).toBeTruthy();
    expect(screen.getByText('This publishes the project for the test showcase. The live public showcase is not changed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand this publishes the project for the test showcase and does not change the live public showcase.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish to test showcase' }));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/projects/2026-agri-iot/staging-publication',
      { method: 'POST' },
    ));
    expect(await screen.findByText('Published for test showcase')).toBeTruthy();
    expect(screen.getByText('Publishing completed successfully. Refresh the test showcase to confirm the project appears.')).toBeTruthy();
    expect(screen.queryByText(/visible on the test showcase/i)).toBeNull();
    const feedLink = screen.getByRole('link', { name: stagingSuccess.feedPublicUrl });
    expect(feedLink.getAttribute('href')).toBe(stagingSuccess.feedPublicUrl);
    expect(JSON.stringify(fetchMock.mock.calls[1])).not.toMatch(/service|secret|supabaseUrl|bucket/i);

    rerender(<PublicationPreparationPanel publicId={PLAN.publicId} ready={false} canPrepare executionTarget="staging" />);
    expect(screen.getByText('Published for test showcase')).toBeTruthy();
    expect(screen.getByRole('link', { name: stagingSuccess.feedPublicUrl })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish to test showcase' })).toBeNull();
  });

  it('describes an already-completed staging publication without claiming current presentation visibility', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: { ...SUCCESS, resultCode: 'ALREADY_COMPLETED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="staging" />);

    fireEvent.click(screen.getByRole('button', { name: /Review publication/i }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish to test showcase' }));

    expect(await screen.findByText('Already published for test showcase')).toBeTruthy();
    expect(screen.getByText('Publishing completed successfully. Refresh the test showcase to confirm the project appears.')).toBeTruthy();
    expect(screen.queryByText(/visible on the test showcase/i)).toBeNull();
  });

  it('shows bounded staging route failures in understandable language', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'Another publication is already in progress.' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="staging" />);

    fireEvent.click(screen.getByRole('button', { name: /Review publication/i }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish to test showcase' }));
    expect(await screen.findByText('Another publication is already in progress.')).toBeTruthy();
  });
});

describe('LocalArchivePanel', () => {
  it('requires both a reason and acknowledgement before archive can execute', () => {
    render(<LocalArchivePanel publicId={PLAN.publicId} />);
    const button = screen.getByRole('button', { name: /Remove from local showcase/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason for removal/i), { target: { value: 'Synthetic test archive' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the 4000-character limit and sends the exact archive payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: { resultCode: 'COMPLETED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<LocalArchivePanel publicId={PLAN.publicId} />);
    const textarea = screen.getByLabelText(/Reason for removal/i);
    expect((textarea as HTMLTextAreaElement).maxLength).toBe(4000);
    fireEvent.change(textarea, { target: { value: 'Synthetic test archive' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Remove from local showcase/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/2026-agri-iot/local-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveReason: 'Synthetic test archive' }),
    }));
    expect(await screen.findByText('Removed from local showcase')).toBeTruthy();
    expect(screen.getByText('This project has been archived and is no longer shown in the local test showcase.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('identifies an already-completed archive with target-specific description', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: { resultCode: 'ALREADY_COMPLETED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<LocalArchivePanel publicId={PLAN.publicId} />);
    fireEvent.change(screen.getByLabelText(/Reason for removal/i), { target: { value: 'Synthetic test archive' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Remove from local showcase/i }));
    expect(await screen.findByText('Already removed from local showcase')).toBeTruthy();
    expect(screen.getByText('This project has been archived and is no longer shown in the local test showcase.')).toBeTruthy();
  });

  it('uses the dedicated governed staging archive route and human-first labels', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: { resultCode: 'COMPLETED' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<LocalArchivePanel publicId={PLAN.publicId} executionTarget="staging" />);

    expect(screen.getByRole('heading', { name: 'Remove from test showcase' })).toBeTruthy();
    expect(screen.getAllByText(/test showcase/i).length).toBeGreaterThanOrEqual(2);
    fireEvent.change(screen.getByLabelText(/Reason for removal/i), { target: { value: 'Retire staging entry' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from test showcase' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/2026-agri-iot/staging-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveReason: 'Retire staging entry' }),
    }));
    expect(await screen.findByText('Removed from test showcase publishing')).toBeTruthy();
    expect(screen.getByText('The project has been archived and removed from the published test-showcase data. Refresh the test showcase to confirm it no longer appears.')).toBeTruthy();
    expect(screen.queryByText(/no longer shown on the test showcase/i)).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ['STAGING_ARCHIVE_UNAVAILABLE', 'Showcase removal is currently unavailable. Please contact an administrator.'],
    ['NOT_PUBLISHED', 'not in the current published test-showcase data'],
    ['PUBLICATION_IN_PROGRESS', 'Wait for it to finish, then refresh'],
    ['RECOVERY_REQUIRED', 'use the publishing recovery workflow.'],
    ['CURRENT_FEED_DIVERGED', 'repair the publishing status.'],
    ['STAGING_ARCHIVE_FAILED', 'Removal could not be completed.'],
  ])('preserves the bounded staging operational state %s with plain-language message', async (code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, code, error: 'server wording is not trusted by the UI' }),
    }));
    render(<LocalArchivePanel publicId={PLAN.publicId} executionTarget="staging" />);
    fireEvent.change(screen.getByLabelText(/Reason for removal/i), { target: { value: 'Retire staging entry' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from test showcase' }));

    expect(await screen.findByText(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))).toBeTruthy();
    expect(screen.queryByText('server wording is not trusted by the UI')).toBeNull();
  });

  it('renders a bounded disabled state in staging without exposing an archive mutation control', () => {
    render(<LocalArchivePanel publicId={PLAN.publicId} executionTarget="staging-unavailable" />);
    expect(screen.getByRole('heading', { name: 'Showcase removal unavailable' })).toBeTruthy();
    expect(screen.getByText(/No removal was attempted/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Reason for removal/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove from test showcase/i })).toBeNull();
  });
});

describe('translateOperation', () => {
  it('translates known operations and modes into plain-language staff activity descriptions', () => {
    expect(translateOperation('baseline', null)).toBe('Initial setup');
    expect(translateOperation('removal', null)).toBe('Removed');
    expect(translateOperation('rollback', null)).toBe('Restored');
    expect(translateOperation('publication', 'normal')).toBe('Published');
    expect(translateOperation('publication', 'deployment_reconciliation')).toBe('Showcase status repaired');
    expect(translateOperation('publication', null)).toBe('Published');
    expect(translateOperation('publication', 'unknown_future_mode')).toBe('Published');
  });
});
