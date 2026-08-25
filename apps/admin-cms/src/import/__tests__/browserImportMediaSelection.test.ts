import { describe, it, expect } from 'vitest';
import { resolveExpectedBrowserImportMedia } from '../browserImportMediaSelection';
import { ServerDerivedDescriptor } from '../browserImportPreviewContract';
import { BrowserImportServerPackage } from '../parseBrowserImportPreview';

function descriptor(overrides: Partial<ServerDerivedDescriptor> & { fileName: string; packagePath: string }): ServerDerivedDescriptor {
  return {
    uploadKey: `${overrides.packagePath}/${overrides.fileName}`.toLowerCase().replace(/[^a-z0-9._-]/g, '_'),
    originalPath: `${overrides.packagePath}/${overrides.fileName}`,
    normalizedPath: `${overrides.packagePath}/${overrides.fileName}`,
    fileSizeBytes: 1000,
    browserMimeType: 'application/octet-stream',
    canonicalMimeType: overrides.fileName.endsWith('.pdf') ? 'application/pdf' : 'image/png',
    mimeConflict: false,
    ...overrides,
  };
}

function serverPackage(overrides: Partial<BrowserImportServerPackage> & { packagePath: string }): BrowserImportServerPackage {
  return {
    folderName: overrides.packagePath.split('/').pop() || overrides.packagePath,
    proposedPublicId: overrides.packagePath.split('/').pop() || overrides.packagePath,
    status: 'valid',
    metadataSource: 'json',
    manifest: null,
    filePresence: {
      xlsxPresent: false,
      jsonPresent: true,
      posterImagePresent: false,
      posterPdfPresent: false,
      snapshotPresent: false,
    },
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe('resolveExpectedBrowserImportMedia', () => {
  it('resolves poster/pdf/snapshot media for a selected package with all files present', () => {
    const pkg = serverPackage({
      packagePath: 'root/pkg-a',
      proposedPublicId: 'pkg-a',
      filePresence: { xlsxPresent: false, jsonPresent: true, posterImagePresent: true, posterPdfPresent: true, snapshotPresent: true },
    });

    const packagesMap = new Map<string, ServerDerivedDescriptor[]>([
      [
        'root/pkg-a',
        [
          descriptor({ packagePath: 'root/pkg-a', fileName: 'poster.png', fileSizeBytes: 300 }),
          descriptor({ packagePath: 'root/pkg-a', fileName: 'poster.pdf', fileSizeBytes: 500, canonicalMimeType: 'application/pdf' }),
          descriptor({ packagePath: 'root/pkg-a', fileName: 'snapshot-1.png', fileSizeBytes: 700 }),
          descriptor({ packagePath: 'root/pkg-a', fileName: 'project.json', fileSizeBytes: 90, canonicalMimeType: 'application/json' }),
        ],
      ],
    ]);

    const result = resolveExpectedBrowserImportMedia({
      preflight: { packagesMap },
      packages: [pkg],
      selectedPackagePaths: ['root/pkg-a'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files).toHaveLength(3);
    expect(result.files.map((f) => f.assetType).sort()).toEqual(['poster_image', 'poster_pdf', 'snapshot_image']);
    expect(result.files.every((f) => f.projectPublicId === 'pkg-a')).toBe(true);
  });

  it('resolves multiple snapshot images in deterministic gallery position order', () => {
    const pkg = serverPackage({
      packagePath: 'root/pkg-gallery',
      proposedPublicId: 'pkg-gallery',
      filePresence: {
        xlsxPresent: false,
        jsonPresent: true,
        posterImagePresent: false,
        posterPdfPresent: false,
        snapshotPresent: true,
      },
    });

    const packagesMap = new Map<string, ServerDerivedDescriptor[]>([
      [
        'root/pkg-gallery',
        [
          descriptor({
            packagePath: 'root/pkg-gallery',
            fileName: 'snapshot-3.png',
            fileSizeBytes: 700,
          }),
          descriptor({
            packagePath: 'root/pkg-gallery',
            fileName: 'snapshot-1.png',
            fileSizeBytes: 500,
          }),
          descriptor({
            packagePath: 'root/pkg-gallery',
            fileName: 'snapshot-2.png',
            fileSizeBytes: 600,
          }),
        ],
      ],
    ]);

    const result = resolveExpectedBrowserImportMedia({
      preflight: { packagesMap },
      packages: [pkg],
      selectedPackagePaths: ['root/pkg-gallery'],
    });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.files).toHaveLength(3);

    expect(
      result.files.map((file) => ({
        fileName: file.fileName,
        assetType: file.assetType,
        galleryPosition: file.galleryPosition,
      })),
    ).toEqual([
      {
        fileName: 'snapshot-1.png',
        assetType: 'snapshot_image',
        galleryPosition: 1,
      },
      {
        fileName: 'snapshot-2.png',
        assetType: 'snapshot_image',
        galleryPosition: 2,
      },
      {
        fileName: 'snapshot-3.png',
        assetType: 'snapshot_image',
        galleryPosition: 3,
      },
    ]);
  });

  it('only resolves the media files actually marked present, even if a stray file exists in the manifest', () => {
    const pkg = serverPackage({
      packagePath: 'root/pkg-b',
      proposedPublicId: 'pkg-b',
      filePresence: { xlsxPresent: false, jsonPresent: true, posterImagePresent: true, posterPdfPresent: false, snapshotPresent: false },
    });

    const packagesMap = new Map<string, ServerDerivedDescriptor[]>([
      [
        'root/pkg-b',
        [
          descriptor({ packagePath: 'root/pkg-b', fileName: 'poster.png', fileSizeBytes: 300 }),
          descriptor({ packagePath: 'root/pkg-b', fileName: 'poster.pdf', fileSizeBytes: 500, canonicalMimeType: 'application/pdf' }),
        ],
      ],
    ]);

    const result = resolveExpectedBrowserImportMedia({
      preflight: { packagesMap },
      packages: [pkg],
      selectedPackagePaths: ['root/pkg-b'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0].assetType).toBe('poster_image');
  });

  it('excludes media belonging to packages that are not selected', () => {
    const selectedPkg = serverPackage({
      packagePath: 'root/selected',
      proposedPublicId: 'selected',
      filePresence: { xlsxPresent: false, jsonPresent: true, posterImagePresent: true, posterPdfPresent: false, snapshotPresent: false },
    });
    const unselectedPkg = serverPackage({
      packagePath: 'root/unselected',
      proposedPublicId: 'unselected',
      filePresence: { xlsxPresent: false, jsonPresent: true, posterImagePresent: true, posterPdfPresent: false, snapshotPresent: false },
    });

    const packagesMap = new Map<string, ServerDerivedDescriptor[]>([
      ['root/selected', [descriptor({ packagePath: 'root/selected', fileName: 'poster.png', fileSizeBytes: 300 })]],
      ['root/unselected', [descriptor({ packagePath: 'root/unselected', fileName: 'poster.png', fileSizeBytes: 300 })]],
    ]);

    const result = resolveExpectedBrowserImportMedia({
      preflight: { packagesMap },
      packages: [selectedPkg, unselectedPkg],
      selectedPackagePaths: ['root/selected'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files).toHaveLength(1);
    expect(result.files[0].projectPublicId).toBe('selected');
  });

  it('fails with UNKNOWN_SELECTED_PACKAGE_PATH when a selected path has no matching package analysis', () => {
    const result = resolveExpectedBrowserImportMedia({
      preflight: { packagesMap: new Map() },
      packages: [],
      selectedPackagePaths: ['root/missing'],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('UNKNOWN_SELECTED_PACKAGE_PATH');
  });

  it('returns an empty file list (not an error) for a selected package with no recognized media present', () => {
    const pkg = serverPackage({ packagePath: 'root/no-media', proposedPublicId: 'no-media' });
    const result = resolveExpectedBrowserImportMedia({
      preflight: { packagesMap: new Map([['root/no-media', []]]) },
      packages: [pkg],
      selectedPackagePaths: ['root/no-media'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files).toHaveLength(0);
  });
});
