// @vitest-environment jsdom

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkPublishPanel } from './BulkPublishPanel';
import type { ProjectIndexRow } from './projectDashboardHelpers';

const project: ProjectIndexRow = {
  id: '1',
  publicId: 'synthetic-2026-0001',
  title: 'Synthetic project',
  status: 'approved',
  program: 'Synthetic program',
  discipline: 'Synthetic discipline',
  year: '2026',
  validationLabel: 'Ready',
  validationVariant: 'success',
};

function readyPreflightResponse(publicId: string): Response {
  return new Response(JSON.stringify({
    success: true,
    result: {
      resultCode: 'READY_TO_STAGE',
      publicId,
      confirmedPreviewId: 'prev-1',
      confirmedAt: '2026-09-16T10:00:00.000Z',
      recordCount: 1,
      feedHash: 'a'.repeat(64),
    },
  }), { status: 200 });
}

function completedResponse(publicId: string): Response {
  return new Response(JSON.stringify({
    success: true,
    result: {
      resultCode: 'COMPLETED',
      publicId,
      snapshotId: 'snap-1',
      recordCount: 1,
      feedHash: 'b'.repeat(64),
    },
  }), { status: 200 });
}

describe('BulkPublishPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(cleanup);

  it('renders nothing when no projects are selected or canPublish is false', () => {
    const { container: emptySelection } = render(
      <BulkPublishPanel selectedProjects={[]} canPublish executionTarget="local" />,
    );
    expect(emptySelection.firstChild).toBeNull();

    const { container: noPermission } = render(
      <BulkPublishPanel selectedProjects={[project]} canPublish={false} executionTarget="local" />,
    );
    expect(noPermission.firstChild).toBeNull();
  });

  it('renders production-unavailable warning when production target is disabled or unverified', () => {
    render(
      <BulkPublishPanel
        selectedProjects={[project]}
        canPublish
        executionTarget="production-unavailable"
      />,
    );

    expect(screen.getByText('Bulk publication unavailable')).toBeTruthy();
    expect(
      screen.getByText(/Production live publication requires separate institutional enablement/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Review publication batch/ })).toBeNull();
  });

  it('runs preflight and enforces the explicit acknowledgement gate before publication', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      // Preflight call
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: {
              resultCode: 'READY_TO_STAGE',
              publicId: project.publicId,
              confirmedPreviewId: 'prev-1',
              confirmedAt: '2026-09-16T10:00:00Z',
              recordCount: 1,
              feedHash: 'a'.repeat(64),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Publication execution call
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: {
              resultCode: 'COMPLETED',
              publicId: project.publicId,
              snapshotId: 'snap-1',
              recordCount: 1,
              feedHash: 'b'.repeat(64),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    const reviewBtn = screen.getByRole('button', { name: 'Review publication batch' });
    fireEvent.click(reviewBtn);

    // Preflight breakdown displayed
    await waitFor(() => {
      expect(
        screen.getByText((_, element) => (
          element?.tagName === 'P' &&
          element.textContent?.includes('Checked 1 project:') === true &&
          element.textContent.includes('1 ready to publish')
        )),
      ).toBeTruthy();
    });

    const confirmBtn = screen.getByRole('button', { name: 'Confirm and publish 1 approved project' });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    // Check explicit acknowledgement
    const checkbox = screen.getByRole('checkbox', { name: /I confirm the exact target/ });
    fireEvent.click(checkbox);
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);

    // Execute publication
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/1 completed/)).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/projects/${project.publicId}/publication-plan`);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/projects/${project.publicId}/local-publication`);
  });

  it('restores focus to trigger button when Cancel is clicked or Escape is pressed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            resultCode: 'READY_TO_STAGE',
            publicId: project.publicId,
            confirmedPreviewId: 'prev-1',
            confirmedAt: '2026-09-16T10:00:00Z',
            recordCount: 1,
            feedHash: 'a'.repeat(64),
          },
        }),
        { status: 200 },
      ),
    );

    render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="staging" />,
    );

    const reviewBtn = screen.getByRole('button', { name: 'Review publication batch' });
    reviewBtn.focus();
    fireEvent.click(reviewBtn);

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    cancelBtn.focus();
    fireEvent.click(cancelBtn);

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.activeElement).toBe(reviewBtn);
  });

  it('invalidates pending preflight and confirmation when selection changes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            resultCode: 'READY_TO_STAGE',
            publicId: project.publicId,
            confirmedPreviewId: 'prev-1',
            confirmedAt: '2026-09-16T10:00:00Z',
            recordCount: 1,
            feedHash: 'a'.repeat(64),
          },
        }),
        { status: 200 },
      ),
    );

    const { rerender } = render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));
    await screen.findByRole('button', { name: 'Confirm and publish 1 approved project' });

    // Change selection
    const secondProject: ProjectIndexRow = {
      ...project,
      id: '2',
      publicId: 'synthetic-2026-0002',
      title: 'Second project',
    };
    rerender(
      <BulkPublishPanel
        selectedProjects={[project, secondProject]}
        canPublish
        executionTarget="local"
      />,
    );

    // Confirmation must be reset and review button displayed again
    expect(screen.queryByRole('button', { name: /Confirm and publish/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Review publication batch' })).toBeTruthy();
  });

  it.each([
    ['selection', { selectedProjects: [{ ...project, publicId: 'synthetic-2026-0002' }], canPublish: true, executionTarget: 'local' as const }],
    ['permission', { selectedProjects: [project], canPublish: false, executionTarget: 'local' as const }],
    ['target', { selectedProjects: [project], canPublish: true, executionTarget: 'staging' as const }],
  ])('ignores a late preflight response after %s changes even when fetch ignores AbortSignal', async (_label, changedProps) => {
    let resolveRequest: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    const { rerender } = render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));
    rerender(<BulkPublishPanel {...changedProps} />);
    resolveRequest?.(new Response(JSON.stringify({
      success: true,
      result: {
        resultCode: 'READY_TO_STAGE',
        publicId: project.publicId,
        confirmedPreviewId: 'prev-1',
        confirmedAt: '2026-09-16T10:00:00.000Z',
        recordCount: 1,
        feedHash: 'a'.repeat(64),
      },
    }), { status: 200 }));

    if (changedProps.canPublish) {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Review publication batch' })).toBeTruthy());
      expect(screen.queryByRole('button', { name: /Confirm and publish/ })).toBeNull();
    } else {
      await waitFor(() => expect(screen.queryByRole('button', { name: /Confirm and publish/ })).toBeNull());
    }
  });

  it('does not revive a late preflight after deselecting and reselecting the same project', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    const { rerender } = render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));
    rerender(<BulkPublishPanel selectedProjects={[]} canPublish executionTarget="local" />);
    rerender(<BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />);
    resolveRequest?.(new Response(JSON.stringify({
      success: true,
      result: {
        resultCode: 'READY_TO_STAGE',
        publicId: project.publicId,
        confirmedPreviewId: 'prev-1',
        confirmedAt: '2026-09-16T10:00:00.000Z',
        recordCount: 1,
        feedHash: 'a'.repeat(64),
      },
    }), { status: 200 }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Review publication batch' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Confirm and publish/ })).toBeNull();
  });

  it.each([
    ['target', { selectedProjects: [project], canPublish: true, executionTarget: 'staging' as const }],
    ['selection', {
      selectedProjects: [{ ...project, id: '2', publicId: 'synthetic-2026-0002', title: 'Second project' }],
      canPublish: true,
      executionTarget: 'local' as const,
    }],
    ['permission', { selectedProjects: [project], canPublish: false, executionTarget: 'local' as const }],
  ])('preserves the original UNKNOWN result when %s changes after writer dispatch', async (_label, changedProps) => {
    let resolveExecution: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(readyPreflightResponse(project.publicId as string))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveExecution = resolve;
      }));
    const { rerender } = render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm the exact target/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and publish 1 approved project/ }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    rerender(<BulkPublishPanel {...changedProps} />);
    resolveExecution?.(completedResponse(project.publicId as string));

    expect(await screen.findByText('Unknown - inspect before retry')).toBeTruthy();
    expect(screen.getByText('Batch stopped')).toBeTruthy();
    expect(screen.getByText('Synthetic project')).toBeTruthy();
    expect(screen.getByText('(synthetic-2026-0001)')).toBeTruthy();
    expect(screen.getByText('Local test-showcase feed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review publication batch' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    if (changedProps.canPublish) {
      const reset = screen.getByRole('button', { name: 'I inspected state; start a new review' });
      fireEvent.click(reset);
      const review = screen.getByRole('button', { name: 'Review publication batch' });
      expect(document.activeElement).toBe(review);
      expect(screen.queryByRole('checkbox', { name: /I confirm the exact target/ })).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } else {
      expect(screen.queryByRole('button', { name: 'I inspected state; start a new review' })).toBeNull();
    }
  });

  it('stops before a layout-phase transport completion can schedule another writer after a transition commit', async () => {
    const projects: ProjectIndexRow[] = [project, {
      ...project,
      id: '2',
      publicId: 'synthetic-2026-0002',
      title: 'Second synthetic project',
    }, {
      ...project,
      id: '3',
      publicId: 'synthetic-2026-0003',
      title: 'Third synthetic project',
    }];
    let resolveSecondWriter: ((response: Response) => void) | undefined;
    let changeTarget: (() => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(readyPreflightResponse(projects[0].publicId as string))
      .mockResolvedValueOnce(readyPreflightResponse(projects[1].publicId as string))
      .mockResolvedValueOnce(readyPreflightResponse(projects[2].publicId as string))
      .mockResolvedValueOnce(completedResponse(projects[0].publicId as string))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveSecondWriter = resolve;
      }))
      .mockResolvedValueOnce(completedResponse(projects[2].publicId as string));

    function Host() {
      const [target, setTarget] = React.useState<'local' | 'staging'>('local');
      changeTarget = () => React.startTransition(() => setTarget('staging'));
      React.useLayoutEffect(() => {
        if (target === 'staging') {
          resolveSecondWriter?.(completedResponse(projects[1].publicId as string));
        }
      }, [target]);
      return <BulkPublishPanel selectedProjects={projects} canPublish executionTarget={target} />;
    }

    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm the exact target/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and publish 3 approved projects/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    changeTarget?.();

    await waitFor(() => expect(screen.getByText('Batch stopped')).toBeTruthy());
    expect(screen.getByText('Unknown - inspect before retry')).toBeTruthy();
    expect(screen.getByText('Not attempted')).toBeTruthy();
    expect(screen.getByText('Second synthetic project')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('keeps post-dispatch safety evidence through empty selection and later reselection', async () => {
    let resolveExecution: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(readyPreflightResponse(project.publicId as string))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveExecution = resolve;
      }));
    const { rerender } = render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm the exact target/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and publish 1 approved project/ }));
    rerender(<BulkPublishPanel selectedProjects={[]} canPublish executionTarget="local" />);
    resolveExecution?.(completedResponse(project.publicId as string));

    expect(await screen.findByText('Unknown - inspect before retry')).toBeTruthy();
    expect(screen.getByText('Batch stopped')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I inspected state; start a new review' })).toBeNull();
    rerender(<BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />);
    expect(screen.getByText('Unknown - inspect before retry')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review publication batch' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not lose a dispatched operation during fast deselection and reselection', async () => {
    let resolveExecution: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(readyPreflightResponse(project.publicId as string))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveExecution = resolve;
      }));
    const { rerender } = render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm the exact target/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm and publish 1 approved project/ }));
    rerender(<BulkPublishPanel selectedProjects={[]} canPublish executionTarget="local" />);
    rerender(<BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />);
    resolveExecution?.(completedResponse(project.publicId as string));

    expect(await screen.findByText('Unknown - inspect before retry')).toBeTruthy();
    expect(screen.getByText('Batch stopped')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review publication batch' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates repeat preflight clicks and lets staff cancel an in-flight preflight', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    render(<BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />);

    const review = screen.getByRole('button', { name: 'Review publication batch' });
    fireEvent.click(review);
    fireEvent.click(review);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preflight check' }));
    resolveRequest?.(new Response(JSON.stringify({
      success: true,
      result: {
        resultCode: 'READY_TO_STAGE', publicId: project.publicId, confirmedPreviewId: 'prev-1',
        confirmedAt: '2026-09-16T10:00:00.000Z', recordCount: 1, feedHash: 'a'.repeat(64),
      },
    }), { status: 200 }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Review publication batch' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Confirm and publish/ })).toBeNull();
  });

  it('restores focus to trigger button when Escape is pressed inside preflight container', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            resultCode: 'READY_TO_STAGE',
            publicId: project.publicId,
            confirmedPreviewId: 'prev-1',
            confirmedAt: '2026-09-16T10:00:00Z',
            recordCount: 1,
            feedHash: 'a'.repeat(64),
          },
        }),
        { status: 200 },
      ),
    );

    render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    const reviewBtn = screen.getByRole('button', { name: 'Review publication batch' });
    reviewBtn.focus();
    fireEvent.click(reviewBtn);

    const checkbox = await screen.findByRole('checkbox', { name: /I confirm the exact target/ });
    fireEvent.keyDown(checkbox, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.activeElement).toBe(reviewBtn);
  });

  it('correctly reports mixed approved, ineligible, and already-published rows', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            resultCode: 'READY_TO_STAGE',
            publicId: 'P-app',
            confirmedPreviewId: 'prev-1',
            confirmedAt: '2026-09-16T10:00:00Z',
            recordCount: 1,
            feedHash: 'a'.repeat(64),
          },
        }),
        { status: 200 },
      ),
    );

    const mixedProjects: ProjectIndexRow[] = [
      { ...project, id: '1', publicId: 'P-app', title: 'Approved 1', status: 'approved' },
      { ...project, id: '2', publicId: 'P-draft', title: 'Draft 1', status: 'draft' },
      { ...project, id: '3', publicId: 'P-pub', title: 'Published 1', status: 'published' },
    ];

    render(
      <BulkPublishPanel selectedProjects={mixedProjects} canPublish executionTarget="staging" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));

    await waitFor(() => {
      expect(
        screen.getByText((_, element) => (
          element?.tagName === 'P' &&
          element.textContent?.includes('Checked 3 projects:') === true &&
          element.textContent.includes('1 ready to publish') &&
          element.textContent.includes('0 already complete') &&
          element.textContent.includes('2 ineligible')
        )),
      ).toBeTruthy();
    });

    // Only 1 fetch call made for the approved project; draft and published skipped network
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/P-app/publication-plan');
  });

  it('disables confirmation and alerts staff when all projects have preflight blockers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          result: {
            resultCode: 'NOT_READY',
            readinessCode: 'PREVIEW_NOT_CONFIRMED',
            blockers: ['Participant contact email unverified.'],
          },
          error: 'Readiness gate not met.',
        }),
        { status: 409 },
      ),
    );

    render(
      <BulkPublishPanel selectedProjects={[project]} canPublish executionTarget="local" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review publication batch' }));

    await screen.findByText(/Participant contact email unverified/);
    expect(screen.getByText(/None of the selected rows currently qualify for publication/)).toBeTruthy();
    const confirmBtn = screen.getByRole('button', { name: /Confirm and publish 0/ });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
