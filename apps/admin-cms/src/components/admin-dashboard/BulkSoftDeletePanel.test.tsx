/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectIndexRow } from './projectDashboardHelpers';
import { BulkSoftDeletePanel } from './BulkSoftDeletePanel';

const row = (publicId: string): ProjectIndexRow => ({
  id: publicId,
  publicId,
  title: `Project ${publicId}`,
  status: 'draft',
  validationLabel: 'Ready',
  validationVariant: 'success',
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BulkSoftDeletePanel', () => {
  it('is absent without server-derived delete permission', () => {
    render(<BulkSoftDeletePanel selectedProjects={[row('p-1')]} canDelete={false} />);
    expect(screen.queryByRole('heading', { name: 'Delete selected projects' })).toBeNull();
  });

  it('requires explicit acknowledgement, attempts only eligible rows, and reports mixed outcomes', async () => {
    const preflight = {
      summary: { total: 3, eligible: 1, blocked: 1, alreadyDeleted: 1 },
      items: [
        { publicId: 'p-1', title: 'Project p-1', status: 'draft', updatedAt: '2026-09-17T00:00:00.000Z', disposition: 'eligible', reasonCode: 'ELIGIBLE', reason: 'Eligible.', previouslyPublished: false },
        { publicId: 'p-2', title: 'Project p-2', status: 'published', updatedAt: '2026-09-17T00:00:00.000Z', disposition: 'blocked', reasonCode: 'PUBLISHED_REQUIRES_ARCHIVE', reason: 'Archive first.', previouslyPublished: true },
        { publicId: 'p-3', title: 'Project p-3', status: 'deleted', updatedAt: '2026-09-17T00:00:00.000Z', disposition: 'already_deleted', reasonCode: 'ALREADY_DELETED', reason: 'Already deleted.', previouslyPublished: false },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(preflight))
      .mockResolvedValueOnce(json({ success: true, result: {
        resultCode: 'DELETED', publicId: 'p-1', status: 'deleted', fromStatus: 'draft',
        deletedAt: '2026-09-17T00:00:01.000Z', auditRecordId: '11111111-1111-4111-8111-111111111111',
      } }));
    render(<BulkSoftDeletePanel selectedProjects={[row('p-1'), row('p-2'), row('p-3')]} canDelete />);
    fireEvent.click(screen.getByRole('button', { name: 'Review delete batch' }));

    expect(await screen.findByText(/1 of 3 selected projects are currently eligible/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Soft delete eligibility results' }).textContent).toContain('Archive first.');
    const confirm = screen.getByRole('button', { name: 'Confirm and soft-delete 1 project' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.getByText(/Batch result: 1 deleted, 1 already deleted, 1 ineligible, 0 stale, 0 denied, 0 failed, 0 unknown, and 0 not attempted/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/p-1/soft-delete');
    expect(screen.getByRole('list', { name: 'Soft delete batch results' }).textContent).toContain('Already soft-deleted / no change');
  });
});
