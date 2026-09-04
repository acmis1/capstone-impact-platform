// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkProjectReviewPanel } from './BulkProjectReviewPanel';
import type { ProjectIndexRow } from './projectDashboardHelpers';

const project: ProjectIndexRow = {
  id: '1',
  publicId: 'synthetic-2026-0001',
  title: 'Synthetic project',
  status: 'submitted',
  program: 'Synthetic program',
  discipline: 'Synthetic discipline',
  year: '2026',
  validationLabel: 'Ready',
  validationVariant: 'success',
};

describe('BulkProjectReviewPanel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('performs one preflight and one bounded execution with the expected version', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action: 'approve',
        summary: { total: 1, eligible: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 },
        items: [{ publicId: project.publicId, title: project.title, status: 'submitted', updatedAt: '2026-08-24T00:00:00.000Z', disposition: 'eligible', reasons: [], additionalReasonCount: 0 }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action: 'approve',
        summary: { total: 1, successful: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0, failed: 0 },
        items: [{ publicId: project.publicId, title: project.title, status: 'approved', updatedAt: '2026-08-24T00:00:01.000Z', disposition: 'eligible', outcome: 'successful', reasons: [], additionalReasonCount: 0, auditRecorded: true }],
      }), { status: 200 }));

    render(<BulkProjectReviewPanel selectedProjects={[project]} canSubmitBulk={false} canReviewBulk />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(screen.getByText((_, element) => (
      element?.tagName === 'P' && element.textContent?.includes('Checked 1 project:') && element.textContent.includes('1 ready')
    ))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and approve' }));
    await waitFor(() => expect(screen.getByText(/1 completed/)).toBeTruthy());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      action: 'approve',
      publicIds: [project.publicId],
      expectedUpdatedAt: { [project.publicId ?? '']: '2026-08-24T00:00:00.000Z' },
    });
  });

  it('blocks rapid duplicate preflight clicks while the request is in flight', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(pending);
    render(<BulkProjectReviewPanel selectedProjects={[project]} canSubmitBulk={false} canReviewBulk />);
    const approve = screen.getAllByRole('button', { name: 'Approve' })[0];
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveRequest?.(new Response(JSON.stringify({ action: 'approve', summary: { total: 1, eligible: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 }, items: [] }), { status: 200 }));
  });

  it('sends one shared request-changes comment when supplied', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action: 'request_changes',
        summary: { total: 1, eligible: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 },
        items: [{ publicId: project.publicId, title: project.title, status: 'submitted', updatedAt: '2026-08-24T00:00:00.000Z', disposition: 'eligible', reasons: [], additionalReasonCount: 0 }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        action: 'request_changes',
        summary: { total: 1, successful: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0, failed: 0 },
        items: [{ publicId: project.publicId, title: project.title, status: 'changes_requested', updatedAt: '2026-08-24T00:00:01.000Z', disposition: 'eligible', outcome: 'successful', reasons: [], additionalReasonCount: 0, auditRecorded: true }],
      }), { status: 200 }));

    render(<BulkProjectReviewPanel selectedProjects={[project]} canSubmitBulk={false} canReviewBulk />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Request changes' })[0]);
    const run = await screen.findByRole('button', { name: 'Confirm and request changes' });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Shared review comment/), { target: { value: 'Please update the accessibility text.' } });
    expect((run as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(run);
    await waitFor(() => expect(screen.getByText(/1 completed/)).toBeTruthy());
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ comments: 'Please update the accessibility text.' });
  });

  it('states check results in staff language without exposing preflight jargon or raw tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      action: 'approve',
      summary: { total: 4, eligible: 1, blocked: 1, alreadyComplete: 1, invalidOrStale: 1 },
      items: [
        { publicId: 'a-ready', title: 'Ready project', status: 'submitted', updatedAt: '2026-08-24T00:00:00.000Z', disposition: 'eligible', reasons: [], additionalReasonCount: 0 },
        { publicId: 'b-blocked', title: 'Blocked project', status: 'draft', updatedAt: '2026-08-24T00:00:00.000Z', disposition: 'blocked', reasons: [{ code: 'WORKFLOW_TRANSITION_INVALID', message: 'The project cannot be approved yet.' }], additionalReasonCount: 0 },
        { publicId: 'c-done', title: 'Finished project', status: 'approved', updatedAt: '2026-08-24T00:00:00.000Z', disposition: 'already_complete', reasons: [], additionalReasonCount: 0 },
        { publicId: 'd-stale', title: 'Stale project', status: 'changes_requested', updatedAt: '2026-08-24T00:00:00.000Z', disposition: 'invalid_or_stale', reasons: [], additionalReasonCount: 0 },
      ],
    }), { status: 200 }));

    render(<BulkProjectReviewPanel selectedProjects={[project]} canSubmitBulk={false} canReviewBulk />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);

    const summary = await screen.findByText((_, element) => (
      element?.tagName === 'P' && element.textContent?.includes('Checked 4 projects:') === true
    ));
    expect(summary.textContent).toContain('1 ready');
    expect(summary.textContent).toContain('1 blocked');
    expect(summary.textContent).toContain('1 already complete');
    expect(summary.textContent).toContain('1 needs refresh or cannot continue');

    // Blockers stay visible, but engineering vocabulary and raw tokens do not reach staff copy.
    expect(screen.getByText('The project cannot be approved yet.')).toBeTruthy();
    expect(screen.queryByText(/Preflight/i)).toBeNull();
    expect(screen.queryByText(/invalid or stale/i)).toBeNull();
    expect(screen.queryByText(/already_complete/)).toBeNull();
    expect(screen.queryByText(/changes_requested/)).toBeNull();
    expect(screen.getByText(/Changes requested — Needs refresh or cannot continue/)).toBeTruthy();
  });

  it('restores focus to the triggering bulk action button when Cancel is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          action: 'approve',
          summary: { total: 1, eligible: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 },
          items: [
            {
              publicId: project.publicId,
              title: project.title,
              status: 'submitted',
              updatedAt: '2026-08-24T00:00:00.000Z',
              disposition: 'eligible',
              reasons: [],
              additionalReasonCount: 0,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    render(<BulkProjectReviewPanel selectedProjects={[project]} canSubmitBulk={false} canReviewBulk />);
    const approveBtn = screen.getAllByRole('button', { name: 'Approve' })[0];
    approveBtn.focus();
    fireEvent.click(approveBtn);

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    cancelBtn.focus();
    fireEvent.click(cancelBtn);

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.activeElement).toBe(approveBtn);
  });

  it('restores focus to the triggering bulk action button when Escape is pressed inside preflight', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          action: 'approve',
          summary: { total: 1, eligible: 1, blocked: 0, alreadyComplete: 0, invalidOrStale: 0 },
          items: [
            {
              publicId: project.publicId,
              title: project.title,
              status: 'submitted',
              updatedAt: '2026-08-24T00:00:00.000Z',
              disposition: 'eligible',
              reasons: [],
              additionalReasonCount: 0,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    render(<BulkProjectReviewPanel selectedProjects={[project]} canSubmitBulk={false} canReviewBulk />);
    const approveBtn = screen.getAllByRole('button', { name: 'Approve' })[0];
    approveBtn.focus();
    fireEvent.click(approveBtn);

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    cancelBtn.focus();
    fireEvent.keyDown(cancelBtn, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.activeElement).toBe(approveBtn);
  });
});
