import { describe, it, expect } from 'vitest';
import { deriveMimeType } from '../browserSelection';

describe('browserSelection MIME derivation', () => {
  it('canonicalizes supported gallery and media extensions', () => {
    const cases: Array<[string, string, string, boolean]> = [
      ['poster.png', 'text/plain', 'image/png', true],
      ['snapshot-1.jpg', 'text/plain', 'image/jpeg', true],
      ['snapshot-2.jpeg', 'application/octet-stream', 'image/jpeg', false],
      ['snapshot-3.webp', 'text/plain', 'image/webp', true],
      ['poster.pdf', 'image/png', 'application/pdf', true],
    ];

    cases.forEach(([fileName, rawMime, expectedMime, warns]) => {
      const derived = deriveMimeType(fileName, rawMime);
      expect(derived.mimeType).toBe(expectedMime);
      if (warns) {
        expect(derived.warning).toBeDefined();
      } else {
        expect(derived.warning).toBeUndefined();
      }
    });
  });

  it('keeps unsupported extensions as octet-stream and does not raise warnings', () => {
    const derived = deriveMimeType('snapshot-1.gif', 'image/gif');
    expect(derived.mimeType).toBe('application/octet-stream');
    expect(derived.warning).toBeUndefined();
  });

  it('preserves canonical MIME for already-canonical media input', () => {
    const derived = deriveMimeType('snapshot-2.webp', 'image/webp');
    expect(derived.mimeType).toBe('image/webp');
    expect(derived.warning).toBeUndefined();
  });
});
