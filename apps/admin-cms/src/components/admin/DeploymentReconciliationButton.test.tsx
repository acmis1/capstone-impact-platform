/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentReconciliationButton } from './DeploymentReconciliationButton';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DeploymentReconciliationButton', () => {
  it('executes repair while publishing is idle', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<DeploymentReconciliationButton publicId="project-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Repair showcase status' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cannot execute repair while another writer activity blocks it', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<DeploymentReconciliationButton
      publicId="project-1"
      unavailableReason="Recover publishing status before repairing."
    />);

    const button = screen.getByRole('button', { name: 'Repair showcase status' });
    expect(button.getAttribute('disabled')).not.toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Recover publishing status before repairing.')).toBeTruthy();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
