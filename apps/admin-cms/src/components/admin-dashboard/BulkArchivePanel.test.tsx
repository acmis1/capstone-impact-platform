/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStatus } from '../../domain/workflowStatus';
import type { ProjectIndexRow } from './projectDashboardHelpers';
import { BulkArchivePanel } from './BulkArchivePanel';

const row = (publicId: string, status: WorkflowStatus = 'published'): ProjectIndexRow => ({
  id: publicId, publicId, title: `Project ${publicId}`, status,
  validationLabel: 'Ready', validationVariant: 'success',
});
const completed = (publicId: string, resultCode: 'COMPLETED' | 'ALREADY_COMPLETED' = 'COMPLETED') =>
  new Response(JSON.stringify({ success: true, result: { resultCode, publicId, recordCount: 1, feedHash: 'a'.repeat(64) } }), { status: 200 });

function confirm(reason = 'End of approved showcase period') {
  fireEvent.click(screen.getByRole('button', { name: 'Review archive batch' }));
  fireEvent.change(screen.getByLabelText(/Shared archive reason/), { target: { value: reason } });
  fireEvent.click(screen.getByRole('checkbox'));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BulkArchivePanel', () => {
  it('shows the exact target, selected count/list, removal scope, and production enablement warning', () => {
    render(<BulkArchivePanel selectedProjects={[row('p-1'), row('p-2', 'draft')]} canArchive executionTarget="production" />);
    expect(screen.getByText(/2 selected on this page/).textContent).toContain('Production live feed');
    confirm();
    expect(screen.getByText(/Exactly 2 selected projects/).textContent).toContain('1 currently show Published');
    expect(screen.getByRole('list', { name: 'Projects selected for archive' }).textContent).toContain('Project p-1');
    expect(screen.getByRole('list', { name: 'Projects selected for archive' }).textContent).toContain('Project p-2');
    expect(screen.getByText(/Production can affect the live feed only when separate institutional enablement/)).toBeTruthy();
    expect(screen.getByText(/never deletes original uploads or media/)).toBeTruthy();
  });

  it('is absent without server-derived permission and refuses a disabled target', () => {
    const view = render(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive={false} executionTarget="local" />);
    expect(screen.queryByRole('heading', { name: 'Archive selected published projects' })).toBeNull();
    view.rerender(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="production-unavailable" />);
    expect(screen.getByText('Bulk archive unavailable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review archive batch' })).toBeNull();
  });

  it('requires a reason and explicit acknowledgement and disables an all-ineligible batch', () => {
    const view = render(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="local" />);
    fireEvent.click(screen.getByRole('button', { name: 'Review archive batch' }));
    const execute = screen.getByRole('button', { name: 'Confirm and archive 1 published project' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Shared archive reason/), { target: { value: 'Reason' } });
    expect(execute.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(execute.disabled).toBe(false);

    view.rerender(<BulkArchivePanel selectedProjects={[row('draft-1', 'draft')]} canArchive executionTarget="local" />);
    fireEvent.click(screen.getByRole('button', { name: 'Review archive batch' }));
    expect(screen.getByText(/None of the selected rows currently qualify/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm and archive 0 published projects' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders honest mixed outcomes and sends one canonical request at a time', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const publicId = String(input).includes('p-1') ? 'p-1' : 'p-2';
      await Promise.resolve();
      active -= 1;
      return completed(publicId, publicId === 'p-2' ? 'ALREADY_COMPLETED' : 'COMPLETED');
    });
    render(<BulkArchivePanel selectedProjects={[row('p-1'), row('p-2'), row('draft-3', 'draft')]} canArchive executionTarget="staging" />);
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and archive 2 published projects' }));
    await waitFor(() => expect(screen.getByText(/Batch result: 1 completed, 1 already completed\/no change, 1 invalid or ineligible/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(screen.getByRole('list', { name: 'Bulk archive results' }).textContent).toContain('Already completed / no change');
    expect(screen.getByText(/never resumes automatically/)).toBeTruthy();
  });

  it('guards repeated clicks, locks inputs through the shared busy state, and reports busy changes', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const onBusyChange = vi.fn();
    const view = render(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="local" onBusyChange={onBusyChange} />);
    confirm();
    const execute = screen.getByRole('button', { name: 'Confirm and archive 1 published project' });
    fireEvent.click(execute);
    fireEvent.click(execute);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onBusyChange).toHaveBeenCalledWith(true);
    view.rerender(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="local" sharedBusy onBusyChange={onBusyChange} />);
    expect(screen.queryByLabelText(/Shared archive reason/)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    resolveRequest?.(completed('p-1'));
    await waitFor(() => expect(screen.getByText(/^Batch result:/)).toBeTruthy());
  });

  it('aborts browser work on unmount and a late response cannot schedule another write', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise((resolve) => { resolveRequest = resolve; }));
    const view = render(<BulkArchivePanel selectedProjects={[row('p-1'), row('p-2')]} canArchive executionTarget="local" />);
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and archive 2 published projects' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    resolveRequest?.(completed('p-1'));
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('bulk archive review-boundary regressions', () => {
  it('invalidates acknowledgement and reason when the server-derived target changes', () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const view = render(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="local" />);
    confirm();
    view.rerender(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="production" />);
    expect(screen.queryByRole('button', { name: 'Confirm and archive 1 published project' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review archive batch' }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Shared archive reason/) as HTMLTextAreaElement).value).toBe('');
    expect(request).not.toHaveBeenCalled();
  });
  it('does not reuse an acknowledgement across loss and restoration of archive permission', () => {
    const view = render(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="local" />);
    confirm();
    view.rerender(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive={false} executionTarget="local" />);
    view.rerender(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="local" />);
    expect(screen.queryByRole('button', { name: 'Confirm and archive 1 published project' })).toBeNull();
  });
  it('releases its own shared busy lease when unmounted during a request', async () => {
    const onBusyChange = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const view = render(<BulkArchivePanel selectedProjects={[row('p-1')]} canArchive executionTarget="local" onBusyChange={onBusyChange} />);
    confirm(); fireEvent.click(screen.getByRole('button', { name: 'Confirm and archive 1 published project' }));
    view.unmount(); await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
});
