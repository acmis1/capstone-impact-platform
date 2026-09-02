// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
} from '@testing-library/react';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import { PdfMediaPreview } from './PdfMediaPreview';
import type { MediaPreviewItem } from './mediaPreviewTypes';

afterEach(() => {
  cleanup();
});

const validPdf: MediaPreviewItem = {
  url: 'https://example.com/project.pdf',
  fileName: 'project.pdf',
  mimeType: 'application/pdf',
  fileSize: 1048576,
};

describe('PdfMediaPreview', () => {
  it('renders a valid PDF preview', () => {
    render(<PdfMediaPreview media={validPdf} />);

    expect(
      screen.getByTitle('PDF preview of project.pdf'),
    ).toBeTruthy();
    const link = screen.getByRole('link', {
      name: 'Open project.pdf in a new tab',
    });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows a bounded unavailable state when preview URL is absent', () => {
    render(
      <PdfMediaPreview
        media={{
          ...validPdf,
          url: undefined,
        }}
      />,
    );

    expect(
      screen.getByText('PDF preview is unavailable.'),
    ).toBeTruthy();
  });

  it('shows invalid URL state', () => {
    render(
      <PdfMediaPreview
        media={{
          ...validPdf,
          url: 'not-a-url',
        }}
      />,
    );

    expect(
      screen.getByText('Invalid PDF URL.'),
    ).toBeTruthy();
  });

  it('displays file metadata', () => {
    render(<PdfMediaPreview media={validPdf} />);

    expect(screen.getByText('project.pdf')).toBeTruthy();
    expect(screen.getByText('application/pdf')).toBeTruthy();
    expect(screen.getByText('1.0 MB')).toBeTruthy();
  });

  it('provides an explicit small-screen fallback action', () => {
    render(<PdfMediaPreview media={validPdf} />);

    expect(
      screen.getByText(
        /Inline PDF preview may be unavailable on smaller screens/i,
      ),
    ).toBeTruthy();

    expect(
      screen.getByRole('link', {
        name: 'Open project.pdf in a new tab',
      }),
    ).toBeTruthy();
  });
});
