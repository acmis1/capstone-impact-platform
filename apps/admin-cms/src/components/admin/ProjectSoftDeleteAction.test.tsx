/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSoftDeleteAction } from './ProjectSoftDeleteAction';

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));

const eligible = {
  summary: { total: 1, eligible: 1, blocked: 0, alreadyDeleted: 0 },
  items: [{
    publicId: 'p-1', title: 'Project p-1', status: 'draft',
    updatedAt: '2026-09-17T00:00:00.000Z', disposition: 'eligible',
    reasonCode: 'ELIGIBLE', reason: 'Eligible for governed soft delete.', previouslyPublished: false,
  }],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

beforeEach(() => mocks.replace.mockReset());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProjectSoftDeleteAction', () => {
  it('shows the retained-data warning only after server eligibility and restores focus on cancel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(eligible));
    render(<ProjectSoftDeleteAction publicId="p-1" />);
    const trigger = screen.getByRole('button', { name: 'Delete project' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/does not physically delete the project row, uploaded assets/)).toBeTruthy();
    expect(within(dialog).getByText(/cannot be edited, reviewed, published, or restored/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('executes the canonical single-project route and leaves the detail page after confirmed evidence', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(eligible))
      .mockResolvedValueOnce(json({ success: true, result: {
        resultCode: 'DELETED', publicId: 'p-1', status: 'deleted', fromStatus: 'draft',
        deletedAt: '2026-09-17T00:00:01.000Z', auditRecordId: '11111111-1111-4111-8111-111111111111',
      } }));
    render(<ProjectSoftDeleteAction publicId="p-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm soft delete' }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/admin'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/soft-delete/preflight');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/p-1/soft-delete');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      expectedUpdatedAt: '2026-09-17T00:00:00.000Z',
    });
  });

  it('renders the authoritative blocker without opening a confirmation dialog or issuing a delete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({
      summary: { total: 1, eligible: 0, blocked: 1, alreadyDeleted: 0 },
      items: [{ ...eligible.items[0], disposition: 'blocked', reasonCode: 'CURRENTLY_PUBLIC', reason: 'The project is in the canonical public feed.' }],
    }));
    render(<ProjectSoftDeleteAction publicId="p-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete project' }));

    expect(await screen.findByText('The project is in the canonical public feed.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});
