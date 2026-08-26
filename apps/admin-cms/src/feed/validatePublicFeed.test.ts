import { describe, it, expect } from 'vitest';
import { canonicalPathForms, validatePublicFeed } from './validatePublicFeed';
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

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects id %s outside the positive safe numeric routing range',
    (id) => {
      const [record] = compilePublicFeed([createMockProject({ status: 'published' })]);
      (record as unknown as Record<string, unknown>).id = id;

      const result = validatePublicFeed([record]);

      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes('positive safe routing range'))).toBe(true);
    },
  );

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
    const url =
      'https://cdn.example.com/project-public-assets/2026/proj/snap.png';

    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [
        {
          url,
          altText: 'Diagram showing architecture layout.',
          galleryPosition: 1,
        },
      ],
    });

    const res = validatePublicFeed([rec]);

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('validates exact 2,000-character altText', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [
        {
          url,
          altText: 'a'.repeat(2000),
          galleryPosition: 1,
        },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('rejects reordered pairings that diverge from snapshots order', () => {
    const url1 =
      'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';
    const url2 =
      'https://cdn.example.com/project-public-assets/2026/proj/snap2.png';

    const rec = publishedRecord({
      snapshots: [url1, url2],
      snapshotMedia: [
        {
          url: url2,
          altText: 'Snapshot 2 description.',
          galleryPosition: 1,
        },
        {
          url: url1,
          altText: 'Snapshot 1 description.',
          galleryPosition: 2,
        },
      ],
    });

    const res = validatePublicFeed([rec]);

    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toContain(
      'does not match "snapshots" at the same gallery index',
    );
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
      snapshotMedia: [
        {
          url: '12345',
          altText: 'Valid description.',
          galleryPosition: 1,
        },
      ],
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
      snapshotMedia: [
        {
          url: unsafeUrl,
          altText: 'Description of media.',
          galleryPosition: 1,
        },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('is not public-safe'))).toBe(true);
  });

  it('rejects duplicate URLs in snapshotMedia', () => {
    const url1 =
      'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';

    const url2 =
      'https://cdn.example.com/project-public-assets/2026/proj/snap2.png';

    const rec = publishedRecord({
      snapshots: [url1, url2],
      snapshotMedia: [
        {
          url: url1,
          altText: 'First description.',
          galleryPosition: 1,
        },
        {
          url: url1,
          altText: 'Duplicate description.',
          galleryPosition: 2,
        },
      ],
    });

    const res = validatePublicFeed([rec]);

    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) =>
        e.includes('Duplicate URL detected in "snapshotMedia"'),
      ),
    ).toBe(true);
  });

  it('rejects duplicate URLs in snapshotMedia', () => {
    const url1 =
      'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';

    const url2 =
      'https://cdn.example.com/project-public-assets/2026/proj/snap2.png';

    const rec = publishedRecord({
      snapshots: [url1, url2],
      snapshotMedia: [
        {
          url: url1,
          altText: 'First description.',
          galleryPosition: 1,
        },
        {
          url: url1,
          altText: 'Duplicate description.',
          galleryPosition: 2,
        },
      ],
    });

    const res = validatePublicFeed([rec]);

    expect(res.valid).toBe(false);
    expect(
      res.errors.some((e) =>
        e.includes('Duplicate URL detected in "snapshotMedia"'),
      ),
    ).toBe(true);
  });

  it('rejects mismatched URL in snapshotMedia', () => {
    const url1 = 'https://cdn.example.com/project-public-assets/2026/proj/snap1.png';
    const wrongUrl = 'https://cdn.example.com/project-public-assets/2026/proj/snap-unmatched.png';
    const rec = publishedRecord({
      snapshots: [url1],
      snapshotMedia: [
        {
          url: wrongUrl,
          altText: 'Description.',
          galleryPosition: 1,
        },
      ],
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
      snapshotMedia: [
        {
          url: url1,
          altText: 'Only one described.',
          galleryPosition: 1,
        },
      ],
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
        { url: url1, altText: 'First.', galleryPosition: 1,},
        { url: url2, altText: 'Extra.', galleryPosition: 2,},
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
      snapshotMedia: [
        {
          url,
          altText: '',
          galleryPosition: 1,
        },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('has an empty "altText"'))).toBe(true);
  });

  it('rejects whitespace-only altText in snapshotMedia', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [
        {
          url,
          altText: '   \n\t  ',
          galleryPosition: 1,
        },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('has an empty "altText"'))).toBe(true);
  });

  it('rejects 2,001-character altText in snapshotMedia', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [
        {
          url,
          altText: 'a'.repeat(2001),
          galleryPosition: 1,
        },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('exceeds the 2,000 character safety limit'))).toBe(true);
  });

  it('rejects unknown field inside snapshotMedia item', () => {
    const url = 'https://cdn.example.com/project-public-assets/2026/proj/snap.png';
    const rec = publishedRecord({
      snapshots: [url],
      snapshotMedia: [
        {
          url,
          altText: 'Valid alt.',
          galleryPosition: 1,
          internalTrackingId: 'secret-id',
        },
      ],
    });
    const res = validatePublicFeed([rec]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('contains unknown field: "internalTrackingId"'))).toBe(true);
  });
});

describe('canonical percent-encoded storage path boundary', () => {
  const publishedRecord = (overrides: Record<string, unknown> = {}) => {
    const valid = createMockProject({ status: 'published' });
    const compiled = compilePublicFeed([valid]);
    return { ...compiled[0], ...overrides } as unknown as Record<string, unknown>;
  };

  const withSnapshot = (url: string) =>
    publishedRecord({
      snapshots: [url],
      snapshotMedia: [{ url, altText: 'Synthetic gallery alternative.', galleryPosition: 1 }],
    });

  it('canonicalizes a plain path without decoding work', () => {
    expect(canonicalPathForms('/storage/v1/object/public/Assets/One.JPG')).toEqual([
      '/storage/v1/object/public/assets/one.jpg',
    ]);
  });

  it('exposes every bounded decoded form so a marker cannot hide behind one encoding layer', () => {
    expect(canonicalPathForms('/a%2Fb')).toEqual(['/a%2fb', '/a/b']);
  });

  it.each([
    ['/assets/gallery%20one.jpg', ['/assets/gallery%20one.jpg', '/assets/gallery one.jpg']],
    ['/assets/caf%C3%A9.jpg', ['/assets/caf%c3%a9.jpg', '/assets/café.jpg']],
    ['/assets/literal%25.jpg', ['/assets/literal%25.jpg', '/assets/literal%.jpg']],
  ])('accepts the legitimate encoded path %s', (pathname, expected) => {
    expect(canonicalPathForms(pathname)).toEqual(expected);
  });

  it('fails closed on malformed percent-encoding', () => {
    expect(canonicalPathForms('/assets/x%ZZ.jpg')).toBeNull();
  });

  it('fails closed when encoding cannot be resolved inside the bounded budget', () => {
    expect(canonicalPathForms('/assets/x%2525252525.jpg')).toBeNull();
  });

  const encodedPrivateSnapshotUrls: [string, string, string][] = [
    [
      'percent-encoded private ingestion bucket',
      'https://demofixture.supabase.co/storage/v1/object/public/project%2Ddrafts%2Dprivate/leak.jpg',
      'private storage bucket',
    ],
    [
      'lower-case percent-encoded private ingestion bucket',
      'https://demofixture.supabase.co/storage/v1/object/public/project%2ddrafts%2dprivate/leak.jpg',
      'private storage bucket',
    ],
    [
      'double-encoded private ingestion bucket',
      'https://demofixture.supabase.co/storage/v1/object/public/project%252Ddrafts%252Dprivate/leak.jpg',
      'private storage bucket',
    ],
    [
      'percent-encoded signed storage route',
      'https://demofixture.supabase.co/storage/v1/object/%73ign/project-public-assets/leak.jpg',
      'private or signed storage endpoint',
    ],
    [
      'mixed-case percent-encoded authenticated storage route',
      'https://demofixture.supabase.co/storage/v1/object/%41uthenticated/project-public-assets/leak.jpg',
      'private or signed storage endpoint',
    ],
    [
      'percent-encoded draft path segment',
      'https://demofixture.supabase.co/storage/v1/object/public/assets%2Fdrafts%2Fpending.jpg',
      'private draft path segment',
    ],
    [
      'malformed percent-encoding',
      'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/leak%ZZ.jpg',
      'malformed or unresolvable percent-encoding',
    ],
  ];

  it.each(encodedPrivateSnapshotUrls)('rejects a snapshot URL using a %s', (_label, url, reason) => {
    const res = validatePublicFeed([withSnapshot(url)]);
    expect(res.valid).toBe(false);
    expect(res.errors.some((error) => error.includes(reason))).toBe(true);
  });

  it('still accepts an ordinary public storage URL that carries harmless percent-encoding', () => {
    const url = 'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/gallery%20one.jpg';
    const res = validatePublicFeed([withSnapshot(url)]);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('accepts a public storage filename containing a literal encoded percent', () => {
    const url = 'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/progress%25.jpg';
    const res = validatePublicFeed([withSnapshot(url)]);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe('authoritative public URL safety policy', () => {
  const publishedRecord = (overrides: Record<string, unknown> = {}) => {
    const [compiled] = compilePublicFeed([createMockProject({ status: 'published' })]);
    return { ...compiled, ...overrides } as unknown as Record<string, unknown>;
  };

  const unsafeStorageUrl =
    'https://demofixture.supabase.co/storage/v1/object/sign/project-public-assets/private.bin?token=synthetic';

  const activeUrlFields: [string, (url: string) => Record<string, unknown>][] = [
    ['poster', (url) => ({ poster: url })],
    ['posterPdf', (url) => ({ posterPdf: url })],
    [
      'snapshots',
      (url) => ({
        snapshots: [url],
        snapshotMedia: [{ url, altText: 'Synthetic unsafe snapshot.', galleryPosition: 1 }],
      }),
    ],
    [
      'snapshotMedia[].url',
      (url) => ({
        snapshots: [url],
        snapshotMedia: [{ url, altText: 'Synthetic unsafe snapshot.', galleryPosition: 1 }],
      }),
    ],
    ['videoUrl', (url) => ({ videoUrl: url })],
    ['demoUrl', (url) => ({ demoUrl: url })],
    ['repositoryUrl', (url) => ({ repositoryUrl: url })],
    ['externalLinks[].url', (url) => ({ externalLinks: [{ label: 'Unsafe attachment', url }] })],
  ];

  it.each(activeUrlFields)('rejects a private signed URL in %s', (_field, buildOverrides) => {
    const result = validatePublicFeed([publishedRecord(buildOverrides(unsafeStorageUrl))]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('public-safe'))).toBe(true);
  });

  it.each(['token', 'TOKEN', 'Token', 'access_token', 'ACCESS_TOKEN'])(
    'rejects the canonical private-access query key %s on Supabase Storage',
    (queryKey) => {
      const url = `https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/demo.mp4?${queryKey}=synthetic`;
      const result = validatePublicFeed([publishedRecord({ videoUrl: url })]);

      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes('private-access credential'))).toBe(true);
    },
  );

  it('rejects duplicate mixed-case private-access query keys on Supabase Storage', () => {
    const url =
      'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/demo.mp4?download=1&TOKEN=one&token=two';
    const result = validatePublicFeed([publishedRecord({ videoUrl: url })]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('private-access credential'))).toBe(true);
  });

  it.each(['#Token=synthetic', '#section?ACCESS_TOKEN=synthetic'])(
    'rejects private-access material in the Supabase Storage fragment %s',
    (fragment) => {
      const url = `https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/demo.mp4${fragment}`;
      const result = validatePublicFeed([publishedRecord({ videoUrl: url })]);

      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes('private-access credential'))).toBe(true);
    },
  );

  it.each([
    'https://cdn.example.test/public.jpg?ref=/drafts/example',
    'https://project-drafts-private.example.test/public.jpg',
    'https://cdn.example.test/files/project-drafts-private/public.jpg?token=ordinary-site-value',
    'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/project-drafts-private-summary.jpg',
    'https://demofixture.supabase.co/storage/v1/object/public/project-public-assets/drafts-overview.jpg',
  ])('does not classify unrelated URL text as a private storage path: %s', (url) => {
    const result = validatePublicFeed([publishedRecord({ demoUrl: url })]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('keeps legitimate query strings and fragments on ordinary external URLs', () => {
    const result = validatePublicFeed([
      publishedRecord({
        videoUrl: 'https://www.youtube.com/watch?v=AbCdEfGhI12',
        demoUrl: 'https://demo.example.test/launch?ref=showcase&mode=public',
        repositoryUrl: 'https://code.example.test/project?tab=readme#install',
        externalLinks: [
          { label: 'Overview', url: 'https://projects.example.test/project?section=summary&view=public' },
        ],
      }),
    ]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it.each([
    'https://operator:secret@demo.example.test/launch',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    '/relative/path',
  ])('rejects a generally unsafe active URL: %s', (url) => {
    const result = validatePublicFeed([publishedRecord({ repositoryUrl: url })]);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('public-safe'))).toBe(true);
  });
});
