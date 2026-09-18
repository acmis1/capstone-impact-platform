/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('distinguishes an explicit server refusal from an unknown outcome', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: false,
      code: 'REPAIR_BLOCKED',
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    render(<DeploymentReconciliationButton publicId="project-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Repair showcase status' }));

    await waitFor(() => expect(screen.getByText(/server refused to repair showcase status/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Repair showcase status' }).getAttribute('disabled')).toBeNull();
    expect(screen.queryByText(/Nothing was changed/i)).toBeNull();
    expect(screen.getByText('REPAIR_BLOCKED')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('connection reset'))],
    ['contradictory server failure', () => Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 503 }))],
    ['possible partial server failure', () => Promise.resolve(new Response(JSON.stringify({ success: false }), { status: 503 }))],
    ['unrecognized response', () => Promise.resolve(new Response('{}', { status: 200 }))],
    ['malformed response', () => Promise.resolve(new Response('not-json', { status: 200 }))],
  ])('blocks repeat repair when the %s leaves the outcome unknown', async (_label, response) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(response as typeof fetch);
    render(<DeploymentReconciliationButton publicId="project-1" />);

    const button = screen.getByRole('button', { name: 'Repair showcase status' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('The repair outcome could not be confirmed. Refresh the page before retrying.')).toBeTruthy());
    expect(button.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(button);
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
