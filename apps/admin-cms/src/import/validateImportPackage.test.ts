import { describe, it, expect } from 'vitest';
import { validateImportPackage } from './validateImportPackage';
import { ImportPackageParseResult, ImportPackageManifest } from './importTypes';

function createMockParsedPackage(
  overrides: Partial<ImportPackageParseResult> = {},
  manifestOverrides: Partial<ImportPackageManifest> = {},
): ImportPackageParseResult {
  const defaultManifest: ImportPackageManifest = {
    publicId: '2026-optimizer',
    title: 'Wind Optimizer',
    summary: 'Optimizes wind turbines placements',
    background: 'Wind turbine background assessment',
    solution: 'Fluid dynamics modeling solution',
    year: '2026',
    program: 'Software Engineering',
    studyProgram: 'Software Engineering',
    discipline: 'Software Engineering',
    industry: 'Energy',
    industryPartner: 'WindCorp',
    academicSupervisor: 'Dr. Jane Wind',
    groupName: 'Wind Team',
    participantContactEmail: 'wind.team@example.invalid',
    teamMembers: ['Alice', 'Bob'],
    accessibilityText: 'Alternative text describing the layout.',
    posterText: 'Poster text about wind turbines.',
    layoutConfig: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background', 'solution'],
    },
  };

  const defaultSnapshot = {
    fileName: 'snapshot-1.png',
    fileSizeBytes: 500 * 1024,
    mimeType: 'image/png',
    content: Buffer.from([]),
  };

  const defaultPackage: ImportPackageParseResult = {
    manifest: {
      ...defaultManifest,
      ...manifestOverrides,
    },

    posterImage: {
      fileName: 'poster.png',
      fileSizeBytes: 1024 * 1024,
      mimeType: 'image/png',
      content: Buffer.from([]),
    },

    posterPdf: {
      fileName: 'poster.pdf',
      fileSizeBytes: 2 * 1024 * 1024,
      mimeType: 'application/pdf',
      content: Buffer.from([]),
    },

    galleryImages: [
      {
        position: 1,
        file: defaultSnapshot,
      },
    ],

    snapshot1: defaultSnapshot,
  };

  let galleryImages = defaultPackage.galleryImages;

  if (overrides.galleryImages !== undefined) {
    galleryImages = overrides.galleryImages;
  } else if (overrides.snapshot1 !== undefined) {
    galleryImages = overrides.snapshot1
      ? [
          {
            position: 1,
            file: overrides.snapshot1,
          },
        ]
      : [];
  }

  const positionOneImages = galleryImages.filter(
    (item) => item.position === 1,
  );

  const snapshot1 =
    positionOneImages.length === 1
      ? positionOneImages[0].file
      : null;

  return {
    ...defaultPackage,
    ...overrides,
    galleryImages,
    snapshot1,
  };
}
function galleryFile(
  position: number,
  extension = 'png',
  mimeType = 'image/png',
) {
  return {
    position,
    file: {
      fileName: `snapshot-${position}.${extension}`,
      fileSizeBytes: 500 * 1024,
      mimeType,
      content: Buffer.from([]),
    },
  };
}
describe('validateImportPackage', () => {
  it('passes validation for a complete safe package', () => {
    const pkg = createMockParsedPackage();
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
  it('accepts multiple valid gallery images', () => {
    const pkg = createMockParsedPackage({
      galleryImages: [
        galleryFile(1),
        galleryFile(2),
        galleryFile(3),
      ],
  });

  const result = validateImportPackage(pkg);

  expect(result.valid).toBe(true);
  expect(
    result.errors.some(
      (error) =>
        error.ruleCode === 'FILE_GALLERY_DUPLICATE_POSITION' ||
        error.ruleCode === 'FILE_GALLERY_POSITION_OUT_OF_RANGE' ||
        error.ruleCode === 'FILE_GALLERY_TOO_MANY_IMAGES',
    ),
  ).toBe(false);
  });

  it('accepts the maximum supported gallery size', () => {
    const pkg = createMockParsedPackage({
      galleryImages: Array.from(
        { length: 10 },
        (_, index) => galleryFile(index + 1),
      ),
    });

    const result = validateImportPackage(pkg);

    expect(result.valid).toBe(true);
    expect(
      result.errors.some(
        (error) => error.ruleCode === 'FILE_GALLERY_TOO_MANY_IMAGES',
      ),
    ).toBe(false);
  });

  it('rejects duplicate gallery positions', () => {
    const first = galleryFile(1);
    const duplicate = {
      position: 1,
      file: {
        fileName: 'snapshot-1.jpg',
        fileSizeBytes: 500 * 1024,
        mimeType: 'image/jpeg',
        content: Buffer.from([]),
      },
    };

    const pkg = createMockParsedPackage({
      galleryImages: [first, duplicate],
    });

    const result = validateImportPackage(pkg);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) => error.ruleCode === 'FILE_GALLERY_DUPLICATE_POSITION',
      ),
    ).toBe(true);
  });

  it('rejects a gallery position above the supported maximum', () => {
    const pkg = createMockParsedPackage({
      galleryImages: [galleryFile(11)],
    });

    const result = validateImportPackage(pkg);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) => error.ruleCode === 'FILE_GALLERY_POSITION_OUT_OF_RANGE',
      ),
    ).toBe(true);
  });

  it('rejects more than the maximum number of gallery images', () => {
    const pkg = createMockParsedPackage({
      galleryImages: Array.from(
        { length: 11 },
        (_, index) => galleryFile(index + 1),
      ),
    });

    const result = validateImportPackage(pkg);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) => error.ruleCode === 'FILE_GALLERY_TOO_MANY_IMAGES',
      ),
    ).toBe(true);
  });

  it('rejects an unsupported gallery media type', () => {
    const pkg = createMockParsedPackage({
      galleryImages: [
        galleryFile(1, 'gif', 'image/gif'),
      ],
    });

    const result = validateImportPackage(pkg);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) => error.ruleCode === 'FILE_INVALID_GALLERY_IMAGE',
      ),
    ).toBe(true);
  });

  it('accepts multiple gallery images when every position has authoritative alt text', () => {
    const pkg = createMockParsedPackage(
      {
        galleryImages: [
          galleryFile(1),
          galleryFile(2),
          galleryFile(3),
        ],
      },
      {
        galleryAltTexts: [
          { position: 1, altText: 'Overview of the project interface.' },
          { position: 2, altText: 'Dashboard showing project results.' },
          { position: 3, altText: 'Mobile view of the participant workflow.' },
        ],
      },
    );

    const result = validateImportPackage(pkg, {
      metadataSource: 'xlsx',
    });

    expect(result.valid).toBe(true);
  });

  it('rejects a gallery image whose matching alt text is missing', () => {
    const pkg = createMockParsedPackage(
      {
        galleryImages: [
          galleryFile(1),
          galleryFile(2),
        ],
      },
      {
        galleryAltTexts: [
          { position: 1, altText: 'Overview of the project interface.' },
        ],
      },
    );

    const result = validateImportPackage(pkg, {
      metadataSource: 'xlsx',
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.ruleCode === 'METADATA_MISSING_GALLERY_ALT_TEXT',
      ),
    ).toBe(true);
  });

  it('rejects gallery alt metadata that has no matching image', () => {
    const pkg = createMockParsedPackage(
      {
        galleryImages: [
          galleryFile(1),
        ],
      },
      {
        galleryAltTexts: [
          { position: 1, altText: 'Overview of the project interface.' },
          { position: 2, altText: 'This has no matching image.' },
        ],
      },
    );

    const result = validateImportPackage(pkg, {
      metadataSource: 'xlsx',
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.ruleCode === 'METADATA_UNMATCHED_GALLERY_ALT_TEXT',
      ),
    ).toBe(true);
  });

  it('rejects duplicate gallery alt metadata positions', () => {
    const pkg = createMockParsedPackage(
      {
        galleryImages: [
          galleryFile(1),
        ],
      },
      {
        galleryAltTexts: [
          { position: 1, altText: 'First description.' },
          { position: 1, altText: 'Second description.' },
        ],
      },
    );

    const result = validateImportPackage(pkg, {
      metadataSource: 'xlsx',
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.ruleCode === 'METADATA_DUPLICATE_GALLERY_ALT_POSITION',
      ),
    ).toBe(true);
  });

  it('rejects an empty gallery alt text', () => {
    const pkg = createMockParsedPackage(
      {
        galleryImages: [
          galleryFile(2),
        ],
      },
      {
        galleryAltTexts: [
          { position: 2, altText: '   ' },
        ],
      },
    );

    const result = validateImportPackage(pkg, {
      metadataSource: 'xlsx',
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.ruleCode === 'METADATA_EMPTY_GALLERY_ALT_TEXT',
      ),
    ).toBe(true);
  });

  it('rejects an oversized gallery alt text', () => {
    const pkg = createMockParsedPackage(
      {
        galleryImages: [
          galleryFile(2),
        ],
      },
      {
        galleryAltTexts: [
          {
            position: 2,
            altText: 'a'.repeat(2001),
          },
        ],
      },
    );

    const result = validateImportPackage(pkg, {
      metadataSource: 'xlsx',
    });

    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (error) =>
          error.ruleCode === 'METADATA_GALLERY_ALT_TEXT_TOO_LONG',
      ),
    ).toBe(true);
  });

  it('fails validation when required manifest fields are missing', () => {
    const pkg = createMockParsedPackage({}, { title: '' });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'METADATA_MISSING_TITLE')).toBe(true);
  });

  it('fails validation when teamMembers list is empty', () => {
    const pkg = createMockParsedPackage({}, { teamMembers: [] });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'METADATA_EMPTY_ROSTER')).toBe(true);
  });

  it('fails validation when layoutConfig is missing', () => {
    const pkg = createMockParsedPackage();
    (pkg.manifest as unknown as Record<string, unknown>).layoutConfig = null;
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'METADATA_INVALID_LAYOUT')).toBe(true);
  });

  it('fails validation when poster.png is missing', () => {
    const pkg = createMockParsedPackage({ posterImage: null });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'FILE_MISSING_POSTER_IMAGE')).toBe(true);
  });

  it('fails validation when poster.pdf is missing', () => {
    const pkg = createMockParsedPackage({ posterPdf: null });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'FILE_MISSING_POSTER_PDF')).toBe(true);
  });

  it('produces a warning when recommended snapshot is missing', () => {
    const pkg = createMockParsedPackage({ snapshot1: null });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.ruleCode === 'FILE_MISSING_RECOMMENDED')).toBe(true);
  });

  it('produces a warning when accessibilityText is missing', () => {
    const pkg = createMockParsedPackage({}, { accessibilityText: '' });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.ruleCode === 'RECOMMENDED_FIELD_MISSING' && w.fieldName === 'accessibilityText')).toBe(true);
  });

  it('produces a warning when posterText is missing', () => {
    const pkg = createMockParsedPackage({}, { posterText: '' });
    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.ruleCode === 'RECOMMENDED_FIELD_MISSING' && w.fieldName === 'posterText')).toBe(true);
  });

  it('propagates media validation errors (like invalid type or size)', () => {
    const pkg = createMockParsedPackage({
      posterImage: {
        fileName: 'poster.png',
        fileSizeBytes: 6 * 1024 * 1024, // 6 MB (Max 5MB)
        mimeType: 'image/png',
        content: Buffer.from([]),
      },
    });

    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'FILE_INVALID_POSTER_IMAGE')).toBe(true);
  });

  it('propagates media validation errors for unsupported MIME type', () => {
    const pkg = createMockParsedPackage({
      posterImage: {
        fileName: 'poster.png',
        fileSizeBytes: 1024,
        mimeType: 'application/octet-stream', // Unsupported mime type
        content: Buffer.from([]),
      },
    });

    const result = validateImportPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.ruleCode === 'FILE_INVALID_POSTER_IMAGE')).toBe(true);
    const mimeError = result.errors.find(e => e.ruleCode === 'FILE_INVALID_POSTER_IMAGE');
    expect(mimeError?.message).toContain('MIME type [application/octet-stream] is not allowed');
  });

  it('does not mutate the input package object', () => {
    const pkg = createMockParsedPackage();
    const originalJson = JSON.stringify(pkg);
    validateImportPackage(pkg);
    expect(JSON.stringify(pkg)).toBe(originalJson);
  });
});
