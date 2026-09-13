/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PublicFeedHistoryControls,
  publicFeedRecoveryOutcome,
} from './PublicFeedHistoryControls';
import type { PublishingActivity } from './publishingHealthPresentation';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const BASE_PROPS = {
  canPublish: true,
  historyActive: true,
  rollbackAvailable: false,
  rollbackExecutionTarget: null,
  rollbackEnabled: false,
  rollbackHeadEvidence: null,
  targetVersionNumber: null,
  targetIsCurrent: false,
  publishingActivity: 'IDLE' as PublishingActivity,
  environment: 'staging' as const,
  executionAvailable: true,
  recoveryOperationKind: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockReset();
});

afterEach(cleanup);

describe('publicFeedRecoveryOutcome', () => {
  it.each([
    ['COMPLETED', 'interrupted publishing action completed safely'],
    ['RELEASED', 'abandoned pre-write action was cleared safely'],
    ['PERMISSION_DENIED', 'do not have permission'],
    ['RECOVERY_REQUIRED', 'still needs attention'],
    ['PUBLICATION_IN_PROGRESS', 'owner or safety window is still active'],
    ['NO_RECOVERY_REQUIRED', 'state changed before recovery started'],
    ['EXECUTION_FAILED', 'could not be completed'],
  ])('presents %s without flattening its meaning', (code, expected) => {
    expect(publicFeedRecoveryOutcome(code).text).toMatch(new RegExp(expected, 'i'));
  });
});

describe('PublicFeedHistoryControls', () => {
  it('focuses the acknowledgement after preparation while execution remains disabled', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true, result: { targetVersionNumber: 1, targetRecordCount: 0,
        currentVersionNumber: 2, currentRecordCount: 0, diff: {}, lifecycleDrift: {},
        requiredAcknowledgement: 'Fixture acknowledgement',
      },
    })));
    render(<PublicFeedHistoryControls {...BASE_PROPS} rollbackAvailable targetVersionNumber={1} />);
    const summary = screen.getByText('Advanced historical rollback tools');
    summary.closest('details')!.open = true;
    const prepare = screen.getByRole('button', { name: 'Prepare rollback to version 1' });
    prepare.focus();
    fireEvent.click(prepare);
    const acknowledgement = await screen.findByLabelText('Type the exact acknowledgement');
    await waitFor(() => expect(document.activeElement).toBe(acknowledgement));
    expect(screen.getByRole('button', { name: 'Execute prepared rollback' }).hasAttribute('disabled')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/public-feed/rollback/prepare');
  });

  it.each([false, true])('returns failed preparation focus without stealing another control (moved: %s)', async (moved) => {
    let resolveResponse!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
    render(<><button type="button">Another control</button><PublicFeedHistoryControls {...BASE_PROPS} rollbackAvailable targetVersionNumber={1} /></>);
    screen.getByText('Advanced historical rollback tools').closest('details')!.open = true;
    const prepare = screen.getByRole('button', { name: 'Prepare rollback to version 1' });
    prepare.focus();
    fireEvent.click(prepare);
    prepare.blur();
    const other = screen.getByRole('button', { name: 'Another control' });
    if (moved) other.focus();
    await act(async () => resolveResponse(new Response(JSON.stringify({ success: false, code: 'PREPARATION_FAILED' }))));
    expect(document.activeElement).toBe(moved ? other : prepare);
    expect(screen.getByRole('status').textContent).toContain('Nothing was published or changed');
  });

  it('shows setup only for inactive history with an idle writer', () => {
    const { rerender } = render(<PublicFeedHistoryControls
      {...BASE_PROPS} historyActive={false} publishingActivity="IDLE"
    />);
    expect(screen.getByRole('button', { name: 'Set up showcase publishing' })).toBeTruthy();

    for (const activity of ['IN_PROGRESS', 'RECOVERY_WAIT', 'RECOVERY_AVAILABLE'] as const) {
      rerender(<PublicFeedHistoryControls
        {...BASE_PROPS} historyActive={false} publishingActivity={activity}
      />);
      expect(screen.queryByRole('button', { name: 'Set up showcase publishing' })).toBeNull();
    }
  });

  it('offers recovery only when takeover presentation is available', () => {
    const { rerender } = render(<PublicFeedHistoryControls
      {...BASE_PROPS} publishingActivity="RECOVERY_WAIT"
    />);
    expect(screen.queryByRole('button', { name: 'Recover publishing status' })).toBeNull();

    rerender(<PublicFeedHistoryControls {...BASE_PROPS} publishingActivity="RECOVERY_AVAILABLE" />);
    expect(screen.getByRole('button', { name: 'Recover publishing status' })).toBeTruthy();
  });

  it('shows disabled production code availability without exposing mutation controls', () => {
    render(<PublicFeedHistoryControls
      {...BASE_PROPS}
      environment="production"
      executionAvailable={false}
      historyActive={false}
    />);

    expect(screen.getByRole('heading', { name: 'Production publishing unavailable' })).toBeTruthy();
    expect(screen.getByText(/code availability is not cutover authorization/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Set up showcase publishing/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Recover publishing status/i })).toBeNull();
  });

  it('requires explicit acknowledgement before production feed-history activation', () => {
    render(<PublicFeedHistoryControls
      {...BASE_PROPS}
      environment="production"
      historyActive={false}
    />);

    const setup = screen.getByRole('button', { name: 'Set up showcase publishing' });
    expect(setup.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /requires separate institutional cutover authorization/i }));
    expect(setup.hasAttribute('disabled')).toBe(false);
  });

  it('blocks recovery of a production rollback operation while retaining forward recovery', () => {
    const { rerender } = render(<PublicFeedHistoryControls
      {...BASE_PROPS}
      environment="production"
      publishingActivity="RECOVERY_AVAILABLE"
      recoveryOperationKind="rollback"
    />);
    expect(screen.getByRole('heading', { name: 'Production rollback recovery unavailable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Recover publishing status' })).toBeNull();

    rerender(<PublicFeedHistoryControls
      {...BASE_PROPS}
      environment="production"
      publishingActivity="RECOVERY_AVAILABLE"
      recoveryOperationKind="publication"
    />);
    expect(screen.getByRole('button', { name: 'Recover publishing status' })).toBeTruthy();
    expect(screen.getByText(/cannot restore historical feed content/i)).toBeTruthy();
  });

  it('presents RELEASED as a cleared pre-write action and refreshes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { resultCode: 'RELEASED' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<PublicFeedHistoryControls {...BASE_PROPS} publishingActivity="RECOVERY_AVAILABLE" />);

    fireEvent.click(screen.getByRole('button', { name: 'Recover publishing status' }));
    expect(await screen.findByText(/abandoned pre-write action was cleared safely/i)).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('requires the exact head-bound typed confirmation before enabling verified staging rollback', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { resultCode: 'CAPABILITY_UPDATED' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const evidence = {
      versionNumber: 7,
      generation: 9,
      feedHash: 'a'.repeat(64),
      recordCount: 2,
    };
    render(<PublicFeedHistoryControls
      {...BASE_PROPS}
      rollbackExecutionTarget="staging"
      rollbackHeadEvidence={evidence}
    />);

    screen.getByText('Advanced rollback capability (verified staging)').closest('details')!.open = true;
    const button = screen.getByRole('button', { name: 'Enable staging rollback' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Type the exact capability confirmation'), {
      target: {
        value: `ENABLE PUBLIC FEED ROLLBACK FOR VERSION 7 GENERATION 9 HASH ${'a'.repeat(64)} COUNT 2`,
      },
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      enabled: true,
      expectedVersionNumber: 7,
      expectedGeneration: 9,
      expectedFeedHash: 'a'.repeat(64),
      expectedRecordCount: 2,
      confirmation: `ENABLE PUBLIC FEED ROLLBACK FOR VERSION 7 GENERATION 9 HASH ${'a'.repeat(64)} COUNT 2`,
    });
    expect(await screen.findByText(/enabled for this exact non-production feed head/i)).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps capability mutation disabled while publishing or recovery is active', () => {
    render(<PublicFeedHistoryControls
      {...BASE_PROPS}
      rollbackExecutionTarget="staging"
      rollbackEnabled
      rollbackHeadEvidence={{
        versionNumber: 7, generation: 9, feedHash: 'a'.repeat(64), recordCount: 2,
      }}
      publishingActivity="RECOVERY_WAIT"
    />);

    screen.getByText('Advanced rollback capability (verified staging)').closest('details')!.open = true;
    expect(screen.getByRole('button', { name: 'Disable staging rollback' }).hasAttribute('disabled'))
      .toBe(true);
    expect(screen.getByText(/Wait for the current publishing action or recovery/i)).toBeTruthy();
  });

  it('does not render capability controls without publication authority', () => {
    render(<PublicFeedHistoryControls
      {...BASE_PROPS}
      canPublish={false}
      rollbackExecutionTarget="staging"
      rollbackHeadEvidence={{
        versionNumber: 7, generation: 9, feedHash: 'a'.repeat(64), recordCount: 2,
      }}
    />);

    expect(screen.queryByText('Advanced rollback capability (verified staging)')).toBeNull();
  });
});
