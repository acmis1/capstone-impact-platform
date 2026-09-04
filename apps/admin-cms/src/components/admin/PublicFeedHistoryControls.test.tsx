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
  targetVersionNumber: null,
  targetIsCurrent: false,
  publishingActivity: 'IDLE' as PublishingActivity,
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
    const summary = screen.getByText('Advanced rollback tools (Local test only)');
    summary.closest('details')!.open = true;
    const prepare = screen.getByRole('button', { name: 'Prepare rollback to version 1' });
    prepare.focus();
    fireEvent.click(prepare);
    const acknowledgement = await screen.findByLabelText('Type the exact acknowledgement');
    await waitFor(() => expect(document.activeElement).toBe(acknowledgement));
    expect(screen.getByRole('button', { name: 'Execute prepared Local rollback' }).hasAttribute('disabled')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/public-feed/rollback/prepare');
  });

  it.each([false, true])('returns failed preparation focus without stealing another control (moved: %s)', async (moved) => {
    let resolveResponse!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
    render(<><button type="button">Another control</button><PublicFeedHistoryControls {...BASE_PROPS} rollbackAvailable targetVersionNumber={1} /></>);
    screen.getByText('Advanced rollback tools (Local test only)').closest('details')!.open = true;
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
});
