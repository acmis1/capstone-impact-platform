import { describe, it, expect } from 'vitest';
import { validatePublicFeed } from './validatePublicFeed';
import { createMockProject } from '../test/projectFixtures';
import { compilePublicFeed } from './compilePublicFeed';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';

describe('validatePublicFeed', () => {
  it('considers an empty feed valid but produces a warning', () => {
    const result = validatePublicFeed([]);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('zero compiled records');
  });

  it('passes validation for a valid compiled record', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('fails validation when a forbidden internal field is present', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    // Manually inject a forbidden key
    (compiled[0] as unknown as Record<string, unknown>).status = 'published';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Forbidden internal administrative field detected');
  });

  it('fails validation when an unknown field is present', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    // Manually inject an unknown key
    (compiled[0] as unknown as Record<string, unknown>).unknownExtraField = 'some-value';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Unknown schema field detected');
  });

  it('fails validation when required fields are missing', () => {
    const requiredFields = [
      'id', 'publicId', 'title', 'summary', 'year', 'program', 'studyProgram',
      'discipline', 'groupName', 'teamMembers', 'poster', 'posterPdf',
      'posterText', 'accessibilityText', 'snapshots', 'snapshotMedia', 'layoutConfig'
    ];

    requiredFields.forEach(field => {
      const validProject = createMockProject({ status: 'published' });
      const compiled = compilePublicFeed([validProject]);
      delete (compiled[0] as unknown as Record<string, unknown>)[field];

      const result = validatePublicFeed(compiled);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(err => err.includes(`Missing required field: "${field}"`))).toBe(true);
    });
  });

  it('fails validation when id is not an integer', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0] as unknown as Record<string, unknown>).id = 1.5;

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must be an integer');
  });

  it('fails validation when teamMembers is not an array', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0] as unknown as Record<string, unknown>).teamMembers = 'NotAnArray';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('must be a string array');
  });

  it('fails validation when layout template is invalid', () => {
    const validProject = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([validProject]);
    (compiled[0].layoutConfig as unknown as Record<string, unknown>).templateId = 'invalid_layout_type';

    const result = validatePublicFeed(compiled);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Layout error: "templateId" must be one of');
  });

  it('passes validation for supported templates', () => {
    const templates = ['poster_showcase', 'technical_detail', 'media_rich'];
    templates.forEach(templateId => {
      const validProject = createMockProject({
        status: 'published',
        layoutConfig: {
          templateId,
          featuredMedia: 'poster',
          sectionOrder: ['background', 'solution', 'snapshots', 'video', 'links'],
        },
      });
      const compiled = compilePublicFeed([validProject]);
      const result = validatePublicFeed(compiled);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
  });

  it('creates warnings but remains valid for missing recommended indexing fields', () => {
    const projectMissingRecommended = createMockProject({
      status: 'published',
      background: '',
      solution: '',
      academicSupervisor: '',
      industryPartner: '',
      industry: '',
      disciplines: [],
    });
    const compiled = compilePublicFeed([projectMissingRecommended]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('rejects a public record whose poster full text is blank', () => {
    const compiled = compilePublicFeed([createMockProject({ status: 'published', posterText: '' })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"posterText" is empty'))).toBe(true);
  });

  it('rejects a public record whose accessibility text is blank', () => {
    const compiled = compilePublicFeed([createMockProject({ status: 'published', accessibilityText: '' })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"accessibilityText" is empty'))).toBe(true);
  });

  it('rejects a public record whose accessible content is whitespace only', () => {
    const compiled = compilePublicFeed([createMockProject({ status: 'published', posterText: '   ', accessibilityText: '\n ' })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"posterText" is empty'))).toBe(true);
    expect(result.errors.some((error) => error.includes('"accessibilityText" is empty'))).toBe(true);
  });

  it('rejects a public record whose poster full text exceeds its safety limit', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText + 1),
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"posterText" exceeds the 20,000 character safety limit'))).toBe(true);
  });

  it('rejects a public record whose accessibility text exceeds its safety limit', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      accessibilityText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1),
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('"accessibilityText" exceeds the 2,000 character safety limit'))).toBe(true);
  });

  it('accepts a public record with accessible content exactly at each ceiling', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText),
      accessibilityText: 'y'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText),
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    // Nothing is truncated to make the record valid.
    expect(compiled[0].posterText).toHaveLength(ACCESSIBLE_CONTENT_LIMITS.posterText);
  });

  it('accepts a public record carrying both accessible content values', () => {
    const compiled = compilePublicFeed([createMockProject({
      status: 'published',
      posterText: 'Full textual version of every meaningful heading, figure caption, and body paragraph on the poster.',
      accessibilityText: 'Research poster showing three turbine layout diagrams beside a results table.',
    })]);
    const result = validatePublicFeed(compiled);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(compiled[0].posterText).toContain('Full textual version');
    expect(compiled[0].accessibilityText).toContain('Research poster showing');
  });
});

describe('public feed snapshot and snapshotMedia strict pairing contract', () => {
  const publishedRecord = (overrides: Record<string, unknown> = {}) => {
    const valid = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([valid]);
    return { ...compiled[0], ...overrides } as unknown as Record<string, unknown>;
  };

  it('validates [] + [] (zero snapshots)', () => {
    const rec = publishedRecord({ snapshots: [], snapshotMedia: [] });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('validates one public snapshot with one correct pairing', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [{ url, altText: 'Diagram showing architecture layout.' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('validates exact 2,000-character altText', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [{ url, altText: 'a'.repeat(2000) }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('validates reordered unique pairings order-independently', () => {
    const url1 = 'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';
    const url2 = 'https://cdn.example.com/project-public-assets/2026/proj/snap2.png';
    const rec = publishedRecord({
      snapshots: [url1, url2],
      snapshotMedia: [
        { url: url2, altText: 'Snapshot 2 description.' },
        { url: url1, altText: 'Snapshot 1 description.' },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('rejects missing snapshots array', () => {
    const rec = publishedRecord({});
    delete rec.snapshots;
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Missing required field: "snapshots"'))).toBe(true);
  });

  it('rejects snapshots when not an array', () => {
    const rec = publishedRecord({ snapshots: 'https://example.com/a.png' });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('must be a string array'))).toBe(true);
  });

  it('rejects snapshotMedia when missing', () => {
    const rec = publishedRecord({});
    delete rec.snapshotMedia;
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Missing required field: "snapshotMedia"'))).toBe(true);
  });

  it('rejects snapshotMedia when not an array', () => {
    const rec = publishedRecord({ snapshotMedia: { url: 'https://a.png', altText: 'b' } });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('"snapshotMedia" must be an array'))).toBe(true);
  });

  it('rejects non-string element in snapshots', () => {
    const rec = publishedRecord({
      snapshots: [12345],
      snapshotMedia: [{ url: '12345', altText: 'Valid description.' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Snapshot URL at index [0] must be a string'))).toBe(true);
  });

  it.each([
    ['malformed URL', 'not-a-valid-url'],
    ['relative URL', '/assets/2026/snap.png'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: scheme', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='],
    ['private draft path segment /drafts/', 'https://example.com/storage/v1/object/public/project-drafts-private/drafts/proj/snap.png'],
    ['private ingestion bucket', 'https://example.com/storage/v1/object/public/project-drafts-private/snap.png'],
    ['authenticated storage URL', 'https://example.com/storage/v1/object/authenticated/project-public-assets/snap.png'],
    ['signed storage URL', 'https://example.com/storage/v1/object/sign/project-public-assets/snap.png?token=xyz'],
  ])('rejects unsafe snapshot URL: %s', (_, unsafeUrl) => {
    const rec = publishedRecord({
      snapshots: [unsafeUrl],
      snapshotMedia: [{ url: unsafeUrl, altText: 'Description of media.' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('is not public-safe'))).toBe(true);
  });

  it('rejects duplicate URLs in snapshots', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url, url],
      snapshotMedia: [
        { url, altText: 'First description.' },
        { url, altText: 'Second description.' },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Duplicate snapshot URL detected in "snapshots"'))).toBe(true);
  });

  it('rejects duplicate URLs in snapshotMedia', () => {
    const url1 = 'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';
    const url2 = 'https://cdn.example.com/project-public-assets/2026/proj/snap2.png';
    const rec = publishedRecord({
      snapshots: [url1, url2],
      snapshotMedia: [
        { url: url1, altText: 'First description.' },
        { url: url1, altText: 'Duplicate description.' },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Duplicate URL detected in "snapshotMedia"'))).toBe(true);
  });

  it('rejects mismatched URL in snapshotMedia', () => {
    const url1 = 'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';
    const wrongUrl = 'https://cdn.example.com/project-public-assets/2026/proj/snap-unmatched.png';
    const rec = publishedRecord({
      snapshots: [url1],
      snapshotMedia: [{ url: wrongUrl, altText: 'Description.' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('URL does not match any remaining entry in "snapshots"'))).toBe(true);
  });

  it('rejects missing pairing (snapshotMedia length less than snapshots)', () => {
    const url1 = 'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';
    const url2 = 'https://cdn.example.com/project-public-assets/2026/proj/snap2.png';
    const rec = publishedRecord({
      snapshots: [url1, url2],
      snapshotMedia: [{ url: url1, altText: 'Only one described.' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Every snapshot image must be paired with a text alternative'))).toBe(true);
  });

  it('rejects extra pairing (snapshotMedia length greater than snapshots)', () => {
    const url1 = 'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';
    const url2 = 'https://cdn.example.com/project-public-assets/2026/proj/snap2.png';
    const rec = publishedRecord({
      snapshots: [url1],
      snapshotMedia: [
        { url: url1, altText: 'First.' },
        { url: url2, altText: 'Extra.' },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Every snapshot image must be paired with a text alternative'))).toBe(true);
  });

  it('rejects blank altText in snapshotMedia', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [{ url, altText: '' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('has an empty "altText"'))).toBe(true);
  });

  it('rejects whitespace-only altText in snapshotMedia', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [{ url, altText: '   \n\t  ' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('has an empty "altText"'))).toBe(true);
  });

  it('rejects 2,001-character altText in snapshotMedia', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [{ url, altText: 'a'.repeat(2001) }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('exceeds the 2,000 character safety limit'))).toBe(true);
  });

  it('rejects unknown field inside snapshotMedia item', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [{ url, altText: 'Valid alt.', internalTrackingId: 'secret-id' }],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('contains unknown field: "internalTrackingId"'))).toBe(true);
  });
});
