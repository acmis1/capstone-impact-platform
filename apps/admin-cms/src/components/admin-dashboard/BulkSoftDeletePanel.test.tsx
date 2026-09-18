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

const eligibleItem = (publicId: string) => ({
  publicId,
  title: `Project ${publicId}`,
  status: 'draft',
  updatedAt: '2026-09-17T00:00:00.000Z',
  disposition: 'eligible',
  reasonCode: 'ELIGIBLE',
  reason: 'Eligible.',
  previouslyPublished: false,
});

const preflightFor = (items: unknown[]) => ({
  summary: { total: items.length, eligible: items.length, blocked: 0, alreadyDeleted: 0 },
  items,
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

  it.each([
    ['a missing summary', { items: [eligibleItem('p-1')] }],
    ['a mismatched summary count', { summary: { total: 1, eligible: 0, blocked: 1, alreadyDeleted: 0 }, items: [eligibleItem('p-1')] }],
  ])('rejects %s without rendering a confirmation or making a delete request', async (_label, body) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(body));
    render(<BulkSoftDeletePanel selectedProjects={[row('p-1')]} canDelete />);

    fireEvent.click(screen.getByRole('button', { name: 'Review delete batch' }));

    expect(await screen.findByText('The selected projects could not be checked. No deletion request was made.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Confirm and soft-delete/ })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['an unexpected ID', preflightFor([eligibleItem('p-1'), eligibleItem('p-3')])],
    ['a missing ID', preflightFor([eligibleItem('p-1')])],
    ['a duplicate ID', preflightFor([eligibleItem('p-1'), eligibleItem('p-1')])],
  ])('rejects a response with %s instead of the exact selected ID set', async (_label, body) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(body));
    render(<BulkSoftDeletePanel selectedProjects={[row('p-1'), row('p-2')]} canDelete />);

    fireEvent.click(screen.getByRole('button', { name: 'Review delete batch' }));

    expect(await screen.findByText('The selected projects could not be checked. No deletion request was made.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Confirm and soft-delete/ })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['an invalid eligible updatedAt', { ...eligibleItem('p-1'), updatedAt: 'not-a-date' }],
    ['a nonsensical disposition', { ...eligibleItem('p-1'), disposition: 'unexpected' }],
    ['a nonsensical decision code', { ...eligibleItem('p-1'), reasonCode: 'UNEXPECTED_CODE' }],
  ])('rejects preflight with %s before any deletion request', async (_label, item) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(preflightFor([item])));
    render(<BulkSoftDeletePanel selectedProjects={[row('p-1')]} canDelete />);

    fireEvent.click(screen.getByRole('button', { name: 'Review delete batch' }));

    expect(await screen.findByText('The selected projects could not be checked. No deletion request was made.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Confirm and soft-delete/ })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a selection above 50 before sending preflight', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const selectedProjects = Array.from({ length: 51 }, (_, index) => row(`p-${index}`));
    render(<BulkSoftDeletePanel selectedProjects={selectedProjects} canDelete />);

    fireEvent.click(screen.getByRole('button', { name: 'Review delete batch' }));

    expect(await screen.findByText('The selected projects could not be checked. No deletion request was made.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases owned busy state on unmount and ignores the late preflight response', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    const onBusyChange = vi.fn();
    const { unmount } = render(
      <BulkSoftDeletePanel selectedProjects={[row('p-1')]} canDelete onBusyChange={onBusyChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review delete batch' }));
    await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));

    unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);

    resolveRequest?.(json(preflightFor([eligibleItem('p-1')])));
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
