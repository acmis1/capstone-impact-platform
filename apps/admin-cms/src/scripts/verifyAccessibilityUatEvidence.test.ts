import { describe, expect, it } from 'vitest';
import { decodeText, EVIDENCE_ROOT, inspectEvidence, scanText, screenshotManifest } from './verifyAccessibilityUatEvidence';

describe('Accessibility/UAT evidence publication gate', () => {
  it('accepts sanitized evidence, real local links and an Accessibility report', () => {
    const directory = `${EVIDENCE_ROOT}/2026-09-03`;
    const files = new Map([
      [`${directory}/README.md`, Buffer.from('[report](./lighthouse-admin.json)\nParticipant Preview: [REDACTED]')],
      [`${directory}/lighthouse-admin.json`, Buffer.from(JSON.stringify({ categories: { accessibility: { score: 1 } } }))],
    ]);
    expect(inspectEvidence(files)).toEqual({ textFilesScanned: 2, findings: [] });
  });

  // Construct synthetic forbidden values so the repository contains no real credential/identifier fixtures.
  const forbidden = [
    ['participant-preview-token-path', '/participant-preview/' + 'synthetic'.repeat(4)],
    ['signed-url', 'https://example.invalid/file?signature=' + 'synthetic'.repeat(3)],
    ['signed-url', 'https://example.invalid/file?token=' + 'synthetic'.repeat(3)],
    ['jwt-credential', ['eyJsynthetic', 'payload', 'signature'].join('.')],
    ['authorization-data', 'Bearer ' + 'synthetic'.repeat(3)],
    ['cookie-session-data', 'Cookie: ' + 'synthetic'.repeat(3)],
    ['credential-assignment', 'password=' + 'synthetic'.repeat(3)],
    ['forbidden-identifier', [8, 4, 4, 4, 12].map(length => 'a'.repeat(length)).join('-')],
  ];
  it.each(forbidden)('rejects %s without returning the matched value', (category, value) => {
    const findings = scanText('evidence.md', Buffer.from(`Safe first line\n${value}`));
    expect(findings).toContainEqual({ category, filename: 'evidence.md', line: 2 });
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it('scans BOM and BOM-less UTF-16 logs and encoded token URLs', () => {
    const value = '/participant-preview/' + 'synthetic'.repeat(4);
    for (const buffer of [Buffer.from(value, 'utf16le'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])]) {
      expect(decodeText(buffer)).toBe(value);
      expect(scanText('output.log', buffer)[0].category).toBe('participant-preview-token-path');
    }
    expect(scanText('tree.json', Buffer.from(value.replaceAll('/', '\\/')))[0].category).toBe('participant-preview-token-path');
    expect(scanText('report.html', Buffer.from(encodeURIComponent(value)))[0].category).toBe('participant-preview-token-path');
  });

  it('detects known local credentials without returning them', () => {
    const secret = ['synthetic', 'password'].join('-');
    expect(scanText('output.txt', Buffer.from(secret), [secret])).toEqual([{ category: 'known-local-credential', filename: 'output.txt', line: 1 }]);
  });

  it('does not confuse static API routes or source filenames with participant token URLs', () => {
    expect(scanText('build.log', Buffer.from('/api/participant-preview/request-correction\nsrc/participant-preview/participantPreviewService.test.ts'))).toEqual([]);
    expect(scanText('tree.json', Buffer.from('https://localhost:3100/participant-preview/' + 'synthetic'.repeat(4)))[0].category).toBe('participant-preview-token-path');
  });

  it('rejects missing evidence and malformed or category-less Lighthouse JSON', () => {
    const prefix = `${EVIDENCE_ROOT}/2026-09-03`;
    const result = inspectEvidence(new Map([
      [`${prefix}/README.md`, Buffer.from('[missing](./missing.png)')],
      [`${prefix}/lighthouse-invalid.json`, Buffer.from('{')],
      [`${prefix}/lighthouse-empty.json`, Buffer.from('{}')],
    ]));
    expect(result.findings.map(item => item.category)).toEqual(['missing-evidence-reference', 'lighthouse-json-invalid', 'lighthouse-accessibility-missing']);
  });

  it('derives stable dimensions, byte lengths and hashes, reporting duplicates without assigning semantics', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SO0AAAAASUVORK5CYII=', 'base64');
    const manifest = screenshotManifest(new Map([['b.png', png], ['a.png', png]]));
    expect(manifest.screenshots.map(item => [item.filename, item.width, item.height, item.bytes])).toEqual([['a.png', 1, 1, png.length], ['b.png', 1, 1, png.length]]);
    expect(manifest.screenshots[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.duplicates[0].filenames).toEqual(['a.png', 'b.png']);
    expect(() => screenshotManifest(new Map([['broken.png', Buffer.from('not a png')]]))).toThrow('invalid-png');
  });
});
