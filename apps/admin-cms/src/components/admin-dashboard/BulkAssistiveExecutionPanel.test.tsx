// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BulkAssistiveExecutionPanel } from './BulkAssistiveExecutionPanel';
import type { ProjectIndexRow } from './projectDashboardHelpers';

const project: ProjectIndexRow = {
  id: 'project-1',
  publicId: 'project-a',
  title: 'Project A',
  status: 'approved',
  year: '2026',
  validationLabel: 'Ready',
  validationVariant: 'success',
};

const hash = 'a'.repeat(64);

describe('BulkAssistiveExecutionPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('preflights, explicitly confirms, and presents bounded per-project results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        summary: { total: 1, eligible: 1, alreadyActiveOrCurrent: 0, blocked: 0, invalidStale: 0 },
        items: [{
          publicId: 'project-a', title: 'Project A', runId: null, status: null, inputHash: hash,
          disposition: 'eligible', reasons: [], additionalReasonCount: 0,
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        summary: { total: 1, enqueued: 1, alreadyActiveOrCurrent: 0, blocked: 0, invalidStale: 0, failed: 0 },
        items: [{
          publicId: 'project-a', title: 'Project A', runId: '22222222-2222-4222-8222-222222222222', status: 'QUEUED', inputHash: hash,
          disposition: 'eligible', outcome: 'ENQUEUED', reasons: [], additionalReasonCount: 0,
        }],
      }), { status: 200 }));

    render(<BulkAssistiveExecutionPanel selectedProjects={[project]} canRunAssistive />);
    fireEvent.click(screen.getByRole('button', { name: 'Check eligibility' }));
    await waitFor(() => expect(screen.getByText((_, element) => element?.tagName === 'P' && (element.textContent?.includes('1 ready') ?? false))).toBeTruthy());

    expect(screen.getByText(/does not change metadata, findings, review, publication, or archive state/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and enqueue ready projects' }));
    await waitFor(() => expect(screen.getByText((_, element) => element?.tagName === 'P' && (element.textContent?.includes('1 enqueued') ?? false))).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      publicIds: ['project-a'],
      expectedInputHashes: { 'project-a': hash },
    });
  });

  it('presents permission denial without attempting a browser-authorized request', () => {
    render(<BulkAssistiveExecutionPanel selectedProjects={[project]} canRunAssistive={false} />);
    expect(screen.getByRole('alert').textContent).toContain('Your role cannot enqueue assistive checks.');
    expect(screen.queryByRole('button', { name: 'Check eligibility' })).toBeNull();
  });
});
