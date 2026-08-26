/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalArchivePanel } from './LocalArchivePanel';
import { PublicationPreparationPanel } from './PublicationPreparationPanel';
import { PublicationReadinessPanel } from './PublicationReadinessPanel';
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
    expect(screen.queryByText(/Ready for publication/i)).toBeNull();
  });

  it.each<[PublicationReadinessResult['resultCode'], string]>([
    ['NO_ACTIVE_PREVIEW', 'Participant preview required'],
    ['PREVIEW_NOT_CONFIRMED', 'Waiting for participant confirmation'],
    ['CORRECTION_UNRESOLVED', 'Participant correction requires resolution'],
    ['PROJECT_SNAPSHOT_STALE', 'Project information changed after confirmation'],
  ])('presents %s as a blocking state', (resultCode, expectedText) => {
    render(<PublicationReadinessPanel readiness={{ ready: false, resultCode, blockers: ['Authoritative blocker'] }} />);
    expect(screen.getByText(expectedText)).toBeTruthy();
    expect(screen.getByText('Authoritative blocker')).toBeTruthy();
    expect(screen.queryByText(/Ready for publication/i)).toBeNull();
  });

  it('shows authoritative READY evidence and the confirmation time', () => {
    render(<PublicationReadinessPanel readiness={{ ready: true, resultCode: 'READY', blockers: [], confirmedAt: PLAN.confirmedAt }} />);
    expect(screen.getByText('Ready for publication')).toBeTruthy();
    expect(screen.getByText(/^Confirmed \d/)).toBeTruthy();
  });
});

describe('PublicationPreparationPanel', () => {
  it('does not render publication mutations without permission or readiness', () => {
    const { rerender } = render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare={false} executionTarget="local" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PublicationPreparationPanel publicId={PLAN.publicId} ready={false} canPrepare executionTarget="local" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('generates a plan through the exact POST endpoint without a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: PLAN }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget={null} />);

    fireEvent.click(screen.getByRole('button', { name: /Generate publication plan/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/2026-agri-iot/publication-plan', { method: 'POST' }));
    expect(await screen.findByText(/nothing has been published/i)).toBeTruthy();
    expect(screen.queryByText(/Local test publication/i)).toBeNull();
  });

  it('requires acknowledgement before executing local publication and preserves the exact request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: SUCCESS }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="local" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate publication plan/i }));
    const executeButton = await screen.findByRole('button', { name: /Execute local publication/i });
    expect((executeButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(executeButton);

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/projects/2026-agri-iot/local-publication', { method: 'POST' }));
    expect(await screen.findByText('Local publication completed.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('identifies an already-completed local publication without claiming another publication', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: { ...SUCCESS, resultCode: 'ALREADY_COMPLETED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="local" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate publication plan/i }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Execute local publication/i }));
    expect(await screen.findByText('Local publication was already completed.')).toBeTruthy();
  });

  it('labels staging publication explicitly, submits no browser authority, and shows stable feed evidence', async () => {
    const stagingSuccess = {
      ...SUCCESS,
      feedPublicUrl: 'https://synthetic-pp1-staging.supabase.co/storage/v1/object/public/public-feeds/capstones-latest.json',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: stagingSuccess }) });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="staging" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate publication plan/i }));
    expect(await screen.findByText('Staging showcase publication')).toBeTruthy();
    expect(screen.getByText(/non-production staging public feed consumed by the Duda TEST showcase/i)).toBeTruthy();
    expect(screen.getByText(/does not publish the live Impact site/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish to staging showcase' }));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/projects/2026-agri-iot/staging-publication',
      { method: 'POST' },
    ));
    expect(await screen.findByText('Staging showcase publication completed.')).toBeTruthy();
    const feedLink = screen.getByRole('link', { name: stagingSuccess.feedPublicUrl });
    expect(feedLink.getAttribute('href')).toBe(stagingSuccess.feedPublicUrl);
    expect(JSON.stringify(fetchMock.mock.calls[1])).not.toMatch(/service|secret|supabaseUrl|bucket/i);

    rerender(<PublicationPreparationPanel publicId={PLAN.publicId} ready={false} canPrepare executionTarget="staging" />);
    expect(screen.getByText('Staging showcase publication completed.')).toBeTruthy();
    expect(screen.getByRole('link', { name: stagingSuccess.feedPublicUrl })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish to staging showcase' })).toBeNull();
  });

  it('shows bounded staging route failures in understandable language', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: PLAN }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'Another publication is already in progress.' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublicationPreparationPanel publicId={PLAN.publicId} ready canPrepare executionTarget="staging" />);

    fireEvent.click(screen.getByRole('button', { name: /Generate publication plan/i }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish to staging showcase' }));
    expect(await screen.findByText('Another publication is already in progress.')).toBeTruthy();
  });
});

describe('LocalArchivePanel', () => {
  it('requires both a reason and acknowledgement before archive can execute', () => {
    render(<LocalArchivePanel publicId={PLAN.publicId} />);
    const button = screen.getByRole('button', { name: /Archive and remove/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Archive reason/i), { target: { value: 'Synthetic test archive' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the 4000-character limit and sends the exact archive payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: { resultCode: 'COMPLETED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<LocalArchivePanel publicId={PLAN.publicId} />);
    const textarea = screen.getByLabelText(/Archive reason/i);
    expect((textarea as HTMLTextAreaElement).maxLength).toBe(4000);
    fireEvent.change(textarea, { target: { value: 'Synthetic test archive' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Archive and remove/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/2026-agri-iot/local-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveReason: 'Synthetic test archive' }),
    }));
    expect(await screen.findByText('Local archive completed.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('identifies an already-completed archive', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: { resultCode: 'ALREADY_COMPLETED' } }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<LocalArchivePanel publicId={PLAN.publicId} />);
    fireEvent.change(screen.getByLabelText(/Archive reason/i), { target: { value: 'Synthetic test archive' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Archive and remove/i }));
    expect(await screen.findByText('Local archive was already completed.')).toBeTruthy();
  });

  it('uses the dedicated governed staging archive route and staging-specific acknowledgement', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: { resultCode: 'COMPLETED' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<LocalArchivePanel publicId={PLAN.publicId} executionTarget="staging" />);

    expect(screen.getByText('Staging showcase archive')).toBeTruthy();
    expect(screen.getAllByText(/Duda TEST showcase/i)).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(/Archive reason/i), { target: { value: 'Retire staging entry' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive and remove from staging showcase' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/2026-agri-iot/staging-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveReason: 'Retire staging entry' }),
    }));
    expect(await screen.findByText('Staging showcase archive completed.')).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ['STAGING_ARCHIVE_UNAVAILABLE', 'Do not retry until an operator restores the staging capability.'],
    ['NOT_PUBLISHED', 'not in the published lifecycle state'],
    ['PUBLICATION_IN_PROGRESS', 'Wait for it to finish, then refresh'],
    ['RECOVERY_REQUIRED', 'Do not retry archive; use and complete the public-feed recovery workflow.'],
    ['CURRENT_FEED_DIVERGED', 'operator reconciliation is required.'],
    ['STAGING_ARCHIVE_FAILED', 'failed without a specific public result.'],
  ])('preserves the bounded staging operational state %s', async (code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, code, error: 'server wording is not trusted by the UI' }),
    }));
    render(<LocalArchivePanel publicId={PLAN.publicId} executionTarget="staging" />);
    fireEvent.change(screen.getByLabelText(/Archive reason/i), { target: { value: 'Retire staging entry' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive and remove from staging showcase' }));

    expect(await screen.findByText(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))).toBeTruthy();
    expect(screen.queryByText('server wording is not trusted by the UI')).toBeNull();
  });

  it('renders a bounded disabled state in staging without exposing an archive mutation control', () => {
    render(<LocalArchivePanel publicId={PLAN.publicId} executionTarget="staging-unavailable" />);
    expect(screen.getByText('Staging archive unavailable')).toBeTruthy();
    expect(screen.getByText(/No archive was attempted/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Archive reason/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive and remove/i })).toBeNull();
  });
});
