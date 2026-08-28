/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('renders neutral fallbacks instead of Invalid Date for unexpected timestamps', () => {
    const { container } = render(
      <ParticipantPreviewPanel
        {...BASE_PROPS}
        initialActivePreview={{ createdAt: 'malformed', expiresAt: 'also-malformed' }}
        responseState={{ type: 'confirmed', confirmedAt: 'malformed' }}
        notification={{
          kind: 'initial', status: 'sent', recipient: 'participant@example.edu',
          requestedAt: 'malformed', sentAt: 'malformed', failureCode: null,
        }}
        reminders={[{
          reference: 'reminder-1', previewCreatedAt: 'malformed', previewExpiresAt: 'malformed',
          currentPreview: true, recipient: 'participant@example.edu', scheduledFor: 'malformed',
          scheduledBy: 'Reviewer', status: 'triggered', skipReason: null,
          triggeredAt: 'malformed', cancelledAt: null,
          delivery: { status: 'sent', requestedAt: 'malformed', sentAt: 'malformed', failureCode: null },
        }]}
      />,
    );

    expect(container.textContent).not.toContain('Invalid Date');
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
  });

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
          comment: 'Please update the participant names.',
        }}
        notification={{
          kind: 'initial',
          status: 'sent',
          recipient: 'participant.lead@example.edu',
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
            recipient: 'participant.lead@example.edu',
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
    expect(screen.getByText('Please update the participant names.')).toBeTruthy();

    // Email delivery evidence visible with neutral recipient and sent labels
    expect(screen.getByText(/Recipient:/i)).toBeTruthy();
    expect(screen.getAllByText('participant.lead@example.edu').length).toBeGreaterThanOrEqual(1);
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

  it('requires an explicit accessible confirmation before revoking active preview via DELETE', async () => {
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

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Revoke this participant preview?')).toBeTruthy();
    expect(within(dialog).getByText(/stops working immediately/i)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Keep as is' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke preview' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/2026-agri-iot/participant-preview');
    expect(init?.method).toBe('DELETE');
    expect(refresh).toHaveBeenCalled();
  });

  it('does not revoke if user cancels confirmation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2026-08-23T08:00:00.000Z',
      }}
    />);

    const trigger = screen.getByRole('button', { name: 'Revoke preview' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep as is' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();

    // Keyboard focus returns to the control that opened the dialog, never to the document body.
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Revoke preview' }),
    ));
  });

  it('requires an explicit accessible confirmation before starting correction resolution via POST', async () => {
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

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Start resolving the requested changes?')).toBeTruthy();
    // The consequence is stated in ordinary words, never as a raw status token.
    expect(within(dialog).getByText(/Changes requested/)).toBeTruthy();
    expect(within(dialog).queryByText(/changes_requested/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Start resolving changes' }));
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

  it('keeps a just-generated link available for approved sharing when its initial email fails', async () => {
    const generatedUrl = 'https://showcase.test/participant-preview/ephemeral-token-failed-email';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true,
      previewUrl: generatedUrl,
      createdAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-23T10:00:00.000Z',
      notification: {
        status: 'DELIVERY_FAILED',
        message: 'The preview email could not be delivered.',
        failureCode: 'RECIPIENT_REJECTED',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<ParticipantPreviewPanel {...BASE_PROPS} />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate participant preview and send email' }));

    expect(await screen.findByText(/preview link is still available in this session/i)).toBeTruthy();
    expect(screen.getByText(generatedUrl)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.queryByText(/participant has not received this preview link/i)).toBeNull();
  });

  it('explains a failed email in ordinary words and keeps the raw failure code under technical details', () => {
    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2026-08-23T08:00:00.000Z',
      }}
      notification={{
        kind: 'initial',
        recipient: 'contact@example.edu',
        status: 'failed',
        requestedAt: '2026-08-16T08:00:00.000Z',
        sentAt: null,
        failureCode: 'RECIPIENT_REJECTED',
      }}
    />);

    expect(screen.getByText(/The preview email was not delivered/i)).toBeTruthy();
    expect(screen.queryByText(/participant has not received this preview link/i)).toBeNull();
    expect(screen.getByText(/If the preview link is no longer available in this session/i)).toBeTruthy();
    const code = screen.getByText('RECIPIENT_REJECTED');
    expect(code.closest('details')).toBeTruthy();
    expect(within(code.closest('details') as HTMLElement).getByText('Technical details')).toBeTruthy();
  });

  it('describes unknown initial delivery without claiming success or failure', () => {
    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2026-08-23T08:00:00.000Z',
      }}
      notification={{
        kind: 'initial',
        recipient: 'contact@example.edu',
        status: 'delivery_unknown',
        requestedAt: '2026-08-16T08:00:00.000Z',
        sentAt: null,
        failureCode: 'DELIVERY_UNKNOWN',
      }}
    />);

    expect(screen.getByText(/preview email may or may not have been delivered/i)).toBeTruthy();
    expect(screen.getByText(/has not been sent again automatically/i)).toBeTruthy();
    expect(screen.queryByText(/participant has not received/i)).toBeNull();
  });

  it('keeps an unknown email failure code only under Technical details', () => {
    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2026-08-23T08:00:00.000Z',
      }}
      notification={{
        kind: 'initial',
        recipient: 'contact@example.edu',
        status: 'failed',
        requestedAt: '2026-08-16T08:00:00.000Z',
        sentAt: null,
        failureCode: 'UNRECOGNIZED_MAIL_FAILURE',
      }}
    />);

    const rawCode = screen.getByText('UNRECOGNIZED_MAIL_FAILURE');
    const technicalDetails = rawCode.closest('details');
    expect(technicalDetails).toBeTruthy();
    expect(within(technicalDetails as HTMLElement).getByText('Technical details')).toBeTruthy();
    expect(screen.getByText(/preview email was not delivered/i).textContent)
      .not.toContain('UNRECOGNIZED_MAIL_FAILURE');
  });

  it('names the reminder recipient field in ordinary words rather than as a snapshot', () => {
    render(<ParticipantPreviewPanel
      {...BASE_PROPS}
      initialActivePreview={{
        createdAt: '2026-08-16T08:00:00.000Z',
        expiresAt: '2099-08-23T08:00:00.000Z',
      }}
      reminders={[{
        reference: '123e4567-e89b-42d3-a456-426614174000',
        previewCreatedAt: '2026-08-16T08:00:00.000Z',
        previewExpiresAt: '2099-08-23T08:00:00.000Z',
        currentPreview: true,
        recipient: 'contact@example.edu',
        scheduledFor: '2099-08-20T02:30:00.000Z',
        scheduledBy: 'Reviewer User',
        status: 'scheduled',
        skipReason: null,
        triggeredAt: null,
        cancelledAt: null,
        delivery: null,
      }]}
    />);

    expect(screen.getByText('Email recipient at scheduling time:')).toBeTruthy();
    expect(screen.queryByText('Recipient snapshot:')).toBeNull();
  });
});
