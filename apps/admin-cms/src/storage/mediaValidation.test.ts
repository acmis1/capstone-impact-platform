import { describe, it, expect } from 'vitest';
import { validateMediaAsset } from './mediaValidation';

describe('mediaValidation', () => {
  it('accepts valid PNG, JPEG, WEBP and PDF MIME types within limits', () => {
    const validPng = validateMediaAsset({
      fileName: 'poster.png',
      fileSizeBytes: 1024 * 1024, // 1 MB
      mimeType: 'image/png',
    });
    expect(validPng.valid).toBe(true);
    expect(validPng.errors.length).toBe(0);

    const validPdf = validateMediaAsset({
      fileName: 'poster.pdf',
      fileSizeBytes: 15 * 1024 * 1024, // 15 MB
      mimeType: 'application/pdf',
    });
    expect(validPdf.valid).toBe(true);
  });

  it('fails for unsupported MIME types', () => {
    const result = validateMediaAsset({
      fileName: 'document.docx',
      fileSizeBytes: 1024,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('MIME type');
  });

  it('fails for empty files', () => {
    const result = validateMediaAsset({
      fileName: 'empty.png',
      fileSizeBytes: 0,
      mimeType: 'image/png',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('File is empty.');
  });

  it('fails for unsafe paths and path traversal', () => {
    const traversal = validateMediaAsset({
      fileName: '../unsafe.png',
      fileSizeBytes: 1024,
      mimeType: 'image/png',
    });
    expect(traversal.valid).toBe(false);
    expect(traversal.errors[0]).toContain('Unsafe file name');
  });

  it('fails for image files over 5 MB', () => {
    const result = validateMediaAsset({
      fileName: 'huge.png',
      fileSizeBytes: 6 * 1024 * 1024, // 6 MB
      mimeType: 'image/png',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exceeds the maximum limit of 5 MB');
  });

  it('fails for PDFs over 20 MB', () => {
    const result = validateMediaAsset({
      fileName: 'huge.pdf',
      fileSizeBytes: 21 * 1024 * 1024, // 21 MB
      mimeType: 'application/pdf',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exceeds the maximum limit of 20 MB');
  });

  it('produces warnings for non-standard but non-dangerous characters', () => {
    const result = validateMediaAsset({
      fileName: 'poster space.png',
      fileSizeBytes: 1024,
      mimeType: 'image/png',
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('contains non-standard characters');
  });

  it('does not produce warnings for standard filenames', () => {
    const result = validateMediaAsset({
      fileName: 'poster-preview_1.png',
      fileSizeBytes: 1024,
      mimeType: 'image/png',
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBe(0);
  });
});
