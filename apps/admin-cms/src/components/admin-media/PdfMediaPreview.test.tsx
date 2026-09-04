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
  it('keeps a long filename complete in the wrapping PDF action and file facts', () => {
    const fileName = 'syntheticfilename'.repeat(5) + '.pdf';
    render(<PdfMediaPreview media={{ ...validPdf, fileName }} />);
    const link = screen.getByRole('link', { name: 'Open ' + fileName + ' in a new tab' });
    expect(link.classList.contains('max-w-full')).toBe(true);
    expect(link.querySelector('.break-all')?.textContent).toBe(fileName);
    expect(screen.getByText(fileName, { selector: 'dd' })).toBeTruthy();
  });

  it('keeps the titled inline preview out of sequential focus and provides a keyboard-accessible link', () => {
    render(<PdfMediaPreview media={validPdf} />);

    const frame = screen.getByTitle('PDF preview of project.pdf');
    expect(frame.getAttribute('tabindex')).toBe('-1');
    expect(frame.getAttribute('src')).toBe(validPdf.url);
    expect(frame.getAttribute('aria-hidden')).toBeNull();
    // File-specific wording: several media tiles can share one Project Detail page, so the
    // accessible name has to say which file the action opens.
    const link = screen.getByRole('link', { name: 'Open project.pdf in a new tab' });
    expect(link.getAttribute('href')).toBe(validPdf.url);
    expect(link.tabIndex).toBe(0);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('provides fallback guidance without waiting for native PDF viewer events', () => {
    render(<PdfMediaPreview media={validPdf} />);

    expect(screen.getByText(
      'For keyboard access or if the inline preview is unavailable, open the PDF in a new tab.',
    )).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows missing-file state when URL is absent', () => {
    render(
      <PdfMediaPreview
        media={{
          ...validPdf,
          url: undefined,
        }}
      />,
    );

    expect(
      screen.getByText('PDF file is missing.'),
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

    expect(screen.getByText('project.pdf', { selector: 'dd' })).toBeTruthy();
    expect(screen.getByText('application/pdf')).toBeTruthy();
    expect(screen.getByText('1.0 MB')).toBeTruthy();
  });
});
