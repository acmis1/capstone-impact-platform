/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
