import { describe, it, expect } from 'vitest';
import { validateMediaAsset, detectMediaSignature, validateMediaAssetBytes } from './mediaValidation';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF', 'ascii');
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
]);
const TEXT_BYTES = Buffer.from('this is not a real media file at all', 'ascii');

describe('mediaValidation', () => {
  it('accepts valid PNG, JPEG, WEBP and PDF MIME types within limits', () => {
    const testCases = [
      { fileName: 'poster.png', mimeType: 'image/png', size: 1024 * 1024 },
      { fileName: 'photo.jpeg', mimeType: 'image/jpeg', size: 2 * 1024 * 1024 },
      { fileName: 'banner.webp', mimeType: 'image/webp', size: 4 * 1024 * 1024 },
      { fileName: 'document.pdf', mimeType: 'application/pdf', size: 15 * 1024 * 1024 },
    ];

    testCases.forEach(({ fileName, mimeType, size }) => {
      const result = validateMediaAsset({
        fileName,
        fileSizeBytes: size,
        mimeType,
      });
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
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

describe('detectMediaSignature', () => {
  it('detects PNG from magic bytes regardless of declared type', () => {
    expect(detectMediaSignature(PNG_BYTES)).toBe('image/png');
  });

  it('detects JPEG from magic bytes', () => {
    expect(detectMediaSignature(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('detects WEBP from RIFF/WEBP container bytes', () => {
    expect(detectMediaSignature(WEBP_BYTES)).toBe('image/webp');
  });

  it('detects PDF from %PDF- header bytes', () => {
    expect(detectMediaSignature(PDF_BYTES)).toBe('application/pdf');
  });

  it('returns null for content with no recognized signature', () => {
    expect(detectMediaSignature(TEXT_BYTES)).toBeNull();
  });

  it('returns null for a PNG-named file whose content is actually plain text (renamed attack)', () => {
    // Byte content is authoritative, not the filename or declared MIME type.
    expect(detectMediaSignature(TEXT_BYTES)).not.toBe('image/png');
  });
});

describe('validateMediaAssetBytes', () => {
  it('accepts a real PNG whose bytes and declared size match expectations', () => {
    const result = validateMediaAssetBytes({
      fileName: 'poster.png',
      content: PNG_BYTES,
      expectedMimeType: 'image/png',
      expectedFileSizeBytes: PNG_BYTES.length,
    });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('accepts a real PDF whose bytes and declared size match expectations', () => {
    const result = validateMediaAssetBytes({
      fileName: 'poster.pdf',
      content: PDF_BYTES,
      expectedMimeType: 'application/pdf',
      expectedFileSizeBytes: PDF_BYTES.length,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects content whose actual byte length differs from the expected/declared size', () => {
    const result = validateMediaAssetBytes({
      fileName: 'poster.png',
      content: PNG_BYTES,
      expectedMimeType: 'image/png',
      expectedFileSizeBytes: PNG_BYTES.length + 5,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('byte length'))).toBe(true);
  });

  it('rejects a file renamed to poster.png whose actual bytes are a PDF (signature mismatch)', () => {
    const result = validateMediaAssetBytes({
      fileName: 'poster.png',
      content: PDF_BYTES,
      expectedMimeType: 'image/png',
      expectedFileSizeBytes: PDF_BYTES.length,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('signature'))).toBe(true);
  });

  it('rejects content with no recognizable file signature at all', () => {
    const result = validateMediaAssetBytes({
      fileName: 'poster.png',
      content: TEXT_BYTES,
      expectedMimeType: 'image/png',
      expectedFileSizeBytes: TEXT_BYTES.length,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('does not match any supported file signature'))).toBe(true);
  });

  it('never trusts the browser-declared MIME string alone: JPEG bytes declared as image/png are rejected', () => {
    const result = validateMediaAssetBytes({
      fileName: 'snapshot-1.png',
      content: JPEG_BYTES,
      expectedMimeType: 'image/png',
      expectedFileSizeBytes: JPEG_BYTES.length,
    });
    expect(result.valid).toBe(false);
  });
});
