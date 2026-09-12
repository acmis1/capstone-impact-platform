/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ParticipantPreviewAccessEvidence } from './ParticipantPreviewAccessEvidence';
afterEach(cleanup);

describe('staff preview-access evidence presentation', () => {
  it('shows the first server-prepared timestamp without claiming receipt, reading or confirmation', () => {
    const timestamp = '2026-09-10T02:00:00Z';
    const { container } = render(<ParticipantPreviewAccessEvidence evidence={{ available: true, firstResponsePreparedAt: timestamp }} />);
    expect(container.querySelector('time')?.dateTime).toBe(timestamp);
    expect(screen.getByText(/not a read receipt or confirmation/)).toBeTruthy();
    expect(screen.getByText(/Automated requests may/)).toBeTruthy();
  });
  it('does not equate absent historic evidence with never accessed', () => {
    render(<ParticipantPreviewAccessEvidence evidence={{ available: true, firstResponsePreparedAt: null }} />);
    expect(screen.getByText(/Earlier access may predate/)).toBeTruthy();
    expect(screen.queryByText(/never accessed/i)).toBeNull();
  });
  it('distinguishes an unavailable read from an absent observation', () => {
    render(<ParticipantPreviewAccessEvidence evidence={{ available: false }} />);
    expect(screen.getByText(/Access evidence is unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Not recorded/)).toBeNull();
  });
});
