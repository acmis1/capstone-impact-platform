// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ImportBatchReviewProjectView, MediaPresenceSummary } from './ImportBatchReviewPanel';

afterEach(() => {
  cleanup();
});

const project: ImportBatchReviewProjectView = {
  publicId: 'synthetic-1',
  title: 'Synthetic project',
  status: 'draft',
  eligibility: 'eligible',
  ready: true,
  blockingReasons: [],
  warnings: [],
  posterPresent: true,
  posterPdfPresent: true,
  snapshotCount: 2,
};

describe('MediaPresenceSummary', () => {
  it('shows the private staged snapshot count', () => {
    render(<MediaPresenceSummary project={project} />);

    expect(screen.getByText('Snapshots:')).toBeTruthy();
    expect(screen.getByText('2 present')).toBeTruthy();
  });

  it('shows an optional neutral state when no snapshots are staged', () => {
    render(<MediaPresenceSummary project={{ ...project, snapshotCount: 0 }} />);

    expect(screen.getByText('Snapshots:')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });
});
