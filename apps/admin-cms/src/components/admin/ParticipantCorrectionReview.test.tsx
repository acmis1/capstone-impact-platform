// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ParticipantCorrectionReview } from './ParticipantCorrectionReview';
import type { CorrectionReviewView } from '../../previews/participantCorrectionReview';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const candidate: NonNullable<CorrectionReviewView['candidate']> = {
  id: '22222222-2222-4222-8222-222222222222', hash: 'a'.repeat(64), expectedVersion: 'b'.repeat(64), state: 'submitted', submittedAt: '2026-09-03T00:00:00Z', warnings: [], validationFlags: [],
  fields: [{ name: 'title', current: 'Old title', proposed: '<script>Participant text</script>', changed: true }],
  files: [{ role: 'poster_pdf', position: null, fileName: 'poster.pdf', bytes: 100, hash: 'c'.repeat(64), altText: null, url: 'https://example.test/private/signed-pdf' }],
  currentMedia: [{ role: 'snapshot_image', position: 2, fileName: 'omitted.png', hash: 'd'.repeat(64), altText: 'Original description' }],
};
beforeEach(() => { refresh.mockReset(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('staff participant revision comparison', () => {
  it('explains pre-preview package provenance and freezes without approval or preview side effects', async () => {
    render(<ParticipantCorrectionReview publicId="2026-synthetic" view={{ available: true, candidate }} canDecide prePreview />);
    expect(screen.getByText(/source files were uploaded by authenticated staff/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Begin review of this revision' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/current draft and review state remain unchanged/i)).toBeTruthy();
    expect(within(dialog).queryByText(/revoke the original preview/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Begin review of this revision' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ action: 'begin', submissionId: candidate.id, packageHash: candidate.hash, expectedVersion: candidate.expectedVersion });
  });
  it('renders read-only evidence, literal participant text, omitted media and safe file links', () => {
    const { container } = render(<ParticipantCorrectionReview publicId="2026-synthetic" view={{ available: true, candidate }} canDecide={false} />);
    expect(screen.getByText('<script>Participant text</script>')).toBeTruthy(); expect(container.querySelector('script,input,textarea,select')).toBeNull();
    expect(screen.getByText('Omitted from complete replacement')).toBeTruthy(); expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link').getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('requires an explicit freeze confirmation and restores focus on cancel', async () => {
    render(<ParticipantCorrectionReview publicId="2026-synthetic" view={{ available: true, candidate }} canDecide />);
    const trigger = screen.getByRole('button', { name: 'Begin review of this revision' }); trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog'); expect(within(dialog).getByText(/revoke the original preview/i)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled(); fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it('accepts only the selected frozen identity after confirmation, with no replacement values', async () => {
    render(<ParticipantCorrectionReview publicId="2026-synthetic" view={{ available: true, candidate: { ...candidate, state: 'frozen' } }} canDecide />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept this participant revision' }));
    const dialog = await screen.findByRole('alertdialog'); expect(within(dialog).getByText(/complete recovery records/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept this participant revision' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, request] = vi.mocked(fetch).mock.calls[0]; expect(url).toContain('/correction-resolution');
    expect(JSON.parse(request!.body as string)).toEqual({ action: 'accept', submissionId: candidate.id, packageHash: candidate.hash, expectedVersion: candidate.expectedVersion });
    expect(refresh).toHaveBeenCalled();
  });
  it('fails closed without a current candidate or available evidence', () => {
    const { rerender } = render(<ParticipantCorrectionReview publicId="2026-synthetic" view={{ available: false, candidate: null }} canDecide />);
    expect(screen.getByRole('status').textContent).toMatch(/unavailable/); expect(screen.queryByRole('button')).toBeNull();
    rerender(<ParticipantCorrectionReview publicId="2026-synthetic" view={{ available: true, candidate: null }} canDecide />);
    expect(screen.getByRole('status').textContent).toMatch(/Waiting for a complete corrected package/); expect(screen.queryByRole('button')).toBeNull();
  });
});
