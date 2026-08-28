/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipantPreviewPanel } from './ParticipantPreviewPanel';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const BASE_PROPS = {
  publicId: 'project_2026',
  canManage: true,
  isApprovedEligible: true,
  initialActivePreview: {
    createdAt: '2026-08-13T00:00:00.000Z',
    expiresAt: '2099-08-20T00:00:00.000Z',
  },
  responseState: { type: 'unresponded' as const },
  stateAvailable: true,
  notification: {
    kind: 'initial' as const,
    recipient: 'participant@capstone.invalid',
    status: 'sent' as const,
    requestedAt: '2026-08-13T00:00:00.000Z',
    sentAt: '2026-08-13T00:00:01.000Z',
    failureCode: null,
  },
  participantContactEmail: 'participant@capstone.invalid',
  emailDeliveryEnabled: true,
  reminderSchedulingEnabled: true,
  reminders: [],
  resolutionStateAvailable: true,
  projectStatus: 'approved',
};

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockReset();
});

afterEach(cleanup);

describe('ParticipantPreviewPanel reminder workflow', () => {
  it('submits only an absolute scheduling intent and explains the no-link contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true, code: 'SCHEDULED', message: 'The participant preview reminder was scheduled.',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<ParticipantPreviewPanel {...BASE_PROPS} />);
    expect(screen.getByText(/Reminder emails contain no secure link/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reminder date and time'), {
      target: { value: '2099-08-14T09:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule reminder' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body)).toEqual(['scheduledFor']);
    expect(body.scheduledFor).toMatch(/Z$/);
    expect(refresh).toHaveBeenCalled();
  });

  it('does not offer scheduling without a definitely sent initial notification', () => {
    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      notification={{ ...BASE_PROPS.notification, status: 'delivery_unknown', sentAt: null }}
    />);
    expect(screen.queryByLabelText('Reminder date and time')).toBeNull();
    expect(screen.getByText(/successful original preview email is required/i)).toBeTruthy();
  });

  it('renders immutable history and requests idempotent cancellation by opaque reference', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true, code: 'CANCELLED', message: 'The participant preview reminder was cancelled.',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const reference = '123e4567-e89b-42d3-a456-426614174000';
    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      reminders={[{
        reference,
        previewCreatedAt: '2026-08-13T00:00:00.000Z',
        previewExpiresAt: '2099-08-20T00:00:00.000Z',
        currentPreview: true,
        recipient: 'participant@capstone.invalid',
        scheduledFor: '2099-08-14T02:30:00.000Z',
        scheduledBy: 'Reviewer User',
        status: 'scheduled', skipReason: null, triggeredAt: null, cancelledAt: null,
        delivery: null,
      }]}
    />);
    expect(screen.getByText('Reviewer User', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reminder' }));

    // Cancellation is confirmed in an accessible dialog stating its consequences, not window.confirm.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Cancel this scheduled reminder?')).toBeTruthy();
    expect(within(dialog).getByText(/will not be sent/i)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Keep as is' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel reminder' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ reference });
  });

  it.each([
    ['failed' as const, 'The reminder was not delivered'],
    ['delivery_unknown' as const, 'The reminder may or may not have been delivered'],
  ])('keeps the existing preview unchanged when reminder delivery is %s', (status, expected) => {
    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      reminders={[{
        reference: '123e4567-e89b-42d3-a456-426614174001',
        previewCreatedAt: '2026-08-13T00:00:00.000Z',
        previewExpiresAt: '2099-08-20T00:00:00.000Z',
        currentPreview: true,
        recipient: 'participant@capstone.invalid',
        scheduledFor: '2099-08-14T02:30:00.000Z',
        scheduledBy: 'Reviewer User',
        status: 'triggered', skipReason: null, triggeredAt: '2099-08-14T02:30:00.000Z', cancelledAt: null,
        delivery: {
          status,
          requestedAt: '2099-08-14T02:30:00.000Z', sentAt: null, failureCode: 'MAIL_TRANSPORT_RESULT',
        },
      }]}
    />);

    expect(screen.getByText(new RegExp(expected, 'i'))).toBeTruthy();
    expect(screen.getByText(/The existing preview is unchanged/i)).toBeTruthy();
    expect(screen.getByText(/another reminder only if it is still eligible/i)).toBeTruthy();
    expect(screen.queryByText(/participant has not received this preview link/i)).toBeNull();
    expect(screen.queryByText(/revoke this preview|generate a new one|reissue/i)).toBeNull();
    const rawCode = screen.getByText('MAIL_TRANSPORT_RESULT');
    expect(rawCode.closest('details')).toBeTruthy();
  });
});
