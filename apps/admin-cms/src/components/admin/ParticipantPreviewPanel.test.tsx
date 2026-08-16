/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipantPreviewPanel } from './ParticipantPreviewPanel';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const BASE_PROPS = {
  publicId: '2026-agri-iot',
  canManage: true,
  isApprovedEligible: true,
  initialActivePreview: null,
  responseState: { type: 'unresponded' as const },
  stateAvailable: true,
  notification: null,
  participantContactEmail: 'contact@example.edu',
  emailDeliveryEnabled: true,
  reminderSchedulingEnabled: true,
  reminders: [],
  resolutionStateAvailable: true,
  canResolveCorrection: true,
  projectStatus: 'approved',
};

beforeEach(() => {
  vi.restoreAllMocks();
  refresh.mockReset();
});

afterEach(cleanup);

describe('ParticipantPreviewPanel core workflow', () => {
  it('fails closed when stateAvailable is false with no mutation controls', () => {
    render(<ParticipantPreviewPanel {...BASE_PROPS} stateAvailable={false} />);
    expect(screen.getByText(/Participant Preview status unavailable/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('fails closed when resolutionStateAvailable is false with no mutation controls', () => {
    render(<ParticipantPreviewPanel {...BASE_PROPS} resolutionStateAvailable={false} />);
    expect(screen.getByText(/Correction-resolution status unavailable/i)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('preserves read-only status and evidence for canManage=false without mutation controls', () => {
    render(
      <ParticipantPreviewPanel
        {...BASE_PROPS}
        canManage={false}
        canResolveCorrection={false}
        initialActivePreview={{
          createdAt: '2026-08-16T08:00:00.000Z',
          expiresAt: '2026-08-23T08:00:00.000Z',
        }}
        responseState={{
          type: 'correction_requested',
          requestedAt: '2026-08-16T09:00:00.000Z',
          comment: 'Please update the student team names.',
        }}
        notification={{
          kind: 'initial',
          status: 'sent',
          recipient: 'student.lead@example.edu',
          requestedAt: '2026-08-16T08:00:00.000Z',
          sentAt: '2026-08-16T08:00:05.000Z',
          failureCode: null,
        }}
        reminders={[
          {
            reference: 'rem-1',
            previewCreatedAt: '2026-08-16T08:00:00.000Z',
            previewExpiresAt: '2026-08-23T08:00:00.000Z',
            status: 'scheduled',
            scheduledFor: '2026-08-20T08:00:00.000Z',
            recipient: 'student.lead@example.edu',
            scheduledBy: 'Admin User',
            currentPreview: true,
            skipReason: null,
            triggeredAt: null,
            cancelledAt: null,
            delivery: null,
          },
        ]}
      />,
    );

    // Read-only neutral notice
    expect(screen.getByText(/You can view participant confirmation status, but you do not have permission to manage preview links or reminders/i)).toBeTruthy();

    // Active preview state visible
    expect(screen.getByText('Active preview')).toBeTruthy();
    expect(screen.getByText('Participant response')).toBeTruthy();
    expect(screen.getByText(/Correction requested on/i)).toBeTruthy();
    expect(screen.getByText('Please update the student team names.')).toBeTruthy();

    // Email delivery evidence visible with neutral recipient and sent labels
    expect(screen.getByText(/Recipient:/i)).toBeTruthy();
    expect(screen.getAllByText('student.lead@example.edu').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Sent at:/i)).toBeTruthy();

    // Reminder history visible
    expect(screen.getByText('Reminder history')).toBeTruthy();
    expect(screen.getByText(/Admin User/)).toBeTruthy();

    // Mutation controls MUST NOT be rendered
    expect(screen.queryByRole('button', { name: /generate participant preview/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /revoke preview/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /schedule reminder/i })).toBeNull();
    expect(screen.queryByLabelText(/reminder date and time/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel reminder/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start correction resolution/i })).toBeNull();
  });

  it('renders calm message when canManage=false and approved with no active preview', () => {
    render(<ParticipantPreviewPanel {...BASE_PROPS} canManage={false} initialActivePreview={null} />);
    expect(screen.getByText(/You can view participant confirmation status, but you do not have permission to manage preview links or reminders/i)).toBeTruthy();
    expect(screen.getByText(/No active participant preview link has been generated/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /generate participant preview/i })).toBeNull();
  });

  it('generates preview via POST with exact payload (isCorrectionReissue=false, sendEmail=false)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      previewUrl: 'https://showcase.test/participant-preview/token-123',
      createdAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-23T10:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    render(<ParticipantPreviewPanel {...BASE_PROPS} />);

    const generateBtn = screen.getByRole('button', { name: 'Generate participant preview' });
    fireEvent.click(generateBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/2026-agri-iot/participant-preview');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ isCorrectionReissue: false, sendEmail: false });
    expect(refresh).toHaveBeenCalled();
  });

  it('generates and sends email via POST with sendEmail=true on same endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      previewUrl: 'https://showcase.test/participant-preview/token-456',
      createdAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-23T10:00:00.000Z',
      notification: {
        status: 'sent',
        message: 'Preview invitation sent to contact@example.edu',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    render(<ParticipantPreviewPanel {...BASE_PROPS} />);

    const sendBtn = screen.getByRole('button', { name: 'Generate participant preview and send email' });
    fireEvent.click(sendBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/2026-agri-iot/participant-preview');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ isCorrectionReissue: false, sendEmail: true });
  });

  it('requires window.confirm before revoking active preview via DELETE', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      revokedAt: '2026-08-16T10:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2026-08-23T08:00:00.000Z',
      }}
    />);

    const revokeBtn = screen.getByRole('button', { name: 'Revoke preview' });
    fireEvent.click(revokeBtn);

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Revoke this participant preview/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/2026-agri-iot/participant-preview');
    expect(init?.method).toBe('DELETE');
    expect(refresh).toHaveBeenCalled();
  });

  it('does not revoke if user cancels confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2026-08-23T08:00:00.000Z',
      }}
    />);

    const revokeBtn = screen.getByRole('button', { name: 'Revoke preview' });
    fireEvent.click(revokeBtn);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires window.confirm before starting correction resolution via POST', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      resolutionStartedAt: '2026-08-16T10:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2026-08-23T08:00:00.000Z',
      }}
      responseState={{
        type: 'correction_requested',
        requestedAt: '2026-08-16T09:00:00.000Z',
        comment: 'Please fix the team supervisor title.',
      }}
    />);

    const resolveBtn = screen.getByRole('button', { name: 'Start correction resolution' });
    fireEvent.click(resolveBtn);

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Start correction resolution/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/2026-agri-iot/participant-preview/correction-resolution');
    expect(init?.method).toBe('POST');
    expect(refresh).toHaveBeenCalled();
  });

  it('renders just-generated link ephemeral copy button with clipboard copy and accessible status', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    const generatedUrl = 'https://showcase.test/participant-preview/ephemeral-token-999';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      previewUrl: generatedUrl,
      createdAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-23T10:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    render(<ParticipantPreviewPanel {...BASE_PROPS} />);

    // Initially no ephemeral URL is displayed
    expect(screen.queryByText(/Preview link generated/i)).toBeNull();

    // Generate preview
    fireEvent.click(screen.getByRole('button', { name: 'Generate participant preview' }));

    // Ephemeral URL banner appears
    await waitFor(() => expect(screen.getByText(/Preview link generated/i)).toBeTruthy());
    expect(screen.getByText(generatedUrl)).toBeTruthy();

    // Copy action
    const copyBtn = screen.getByRole('button', { name: 'Copy' });
    fireEvent.click(copyBtn);

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(generatedUrl));
    expect(await screen.findByText('Copied!')).toBeTruthy();
    expect(screen.getByText('Preview link copied to clipboard')).toBeTruthy();
  });
});
