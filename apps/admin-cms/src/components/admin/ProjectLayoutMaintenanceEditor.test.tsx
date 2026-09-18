// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutConfigFromStock } from '../../domain/layoutConfig';
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { ProjectLayoutMaintenanceEditor } from './ProjectLayoutMaintenanceEditor';
const props = { publicId: 'synthetic-layout', expectedUpdatedAt: '2026-09-18T12:00:00.000Z', initialConfig: createLayoutConfigFromStock('poster_showcase'), recipes: [] };
const success = { success: true, resultCode: 'UPDATED', publicId: props.publicId, status: 'draft', updatedAt: '2026-09-18T12:01:00.000Z', auditRecordId: '11111111-1111-4111-8111-111111111111', revokedActivePreviewCount: 0 };
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function chooseAndRequestSave() { fireEvent.click(screen.getByRole('button', { name: 'Technical detail' })); fireEvent.click(screen.getByRole('button', { name: 'Save layout configuration' })); }

describe('governed project layout editing', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('requires confirmation and cancellation preserves the draft without a request', () => {
    render(<ProjectLayoutMaintenanceEditor {...props} />); chooseAndRequestSave();
    expect(screen.getByRole('alertdialog')).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByText('Unsaved layout changes')).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
  });
  it('saves once, validates the exact response and clears dirty state', async () => {
    render(<ProjectLayoutMaintenanceEditor {...props} />); chooseAndRequestSave();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm layout change' }));
    await waitFor(() => expect(screen.getByText('No changes to save.')).toBeTruthy());
    expect(fetch).toHaveBeenCalledTimes(1); expect(router.refresh).toHaveBeenCalledOnce();
    expect(screen.getByText(/0 active participant preview revoked/)).toBeTruthy();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ publicId: props.publicId, layoutConfig: { templateId: 'technical_detail' } });
  });
  it.each([
    response(null), response({ success: true }), response({ ...success, publicId: 'other' }),
    response({ ...success, status: 'published' }), response({ success: false }, 500),
    response({ ...success, success: false }), response(success, 409),
  ])('freezes ambiguous or contradictory writes instead of claiming success', async result => {
    vi.mocked(fetch).mockResolvedValue(result as Response);
    render(<ProjectLayoutMaintenanceEditor {...props} />); chooseAndRequestSave();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm layout change' }));
    await waitFor(() => expect(screen.getByText(/write outcome is unknown/i)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Save layout configuration' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Reload project' })).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('shows known refusal as an error, preserving the draft', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ success: false, resultCode: 'STALE_VERSION' }, 409) as Response);
    render(<ProjectLayoutMaintenanceEditor {...props} />); chooseAndRequestSave();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm layout change' }));
    await waitFor(() => expect(screen.getByText('Layout not changed')).toBeTruthy());
    expect(screen.getByText('Unsaved layout changes')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save layout configuration' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('retains a dirty draft after a new server version arrives', () => {
    const { rerender } = render(<ProjectLayoutMaintenanceEditor {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Technical detail' }));
    rerender(<ProjectLayoutMaintenanceEditor {...props} expectedUpdatedAt="2026-09-18T12:02:00.000Z" />);
    expect(screen.getByText(/project changed while you were editing/i)).toBeTruthy();
    expect(screen.getByText('Unsaved layout changes')).toBeTruthy();
  });
});
