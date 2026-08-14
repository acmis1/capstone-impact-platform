import { describe, expect, it } from 'vitest';

import { computeCanonicalMediaIntentHash } from '../browserImportMediaStageContract';
import { resolveExpectedBrowserImportMedia } from '../browserImportMediaSelection';
import type { ManifestPreflightSuccess, ServerDerivedDescriptor } from '../browserImportPreviewContract';
import type { BrowserImportServerPackage } from '../parseBrowserImportPreview';
import type { ImportPackageManifest } from '../importTypes';

const PACKAGE_PATH = 'batch/2026-synthetic';
const VALID_ALT = 'Screenshot of the mock control panel showing three active sensor feeds.';

function descriptor(fileName: string, uploadKey: string): ServerDerivedDescriptor {
  return {
    uploadKey,
    originalPath: `${PACKAGE_PATH}/${fileName}`,
    normalizedPath: `${PACKAGE_PATH}/${fileName}`,
    fileName,
    fileSizeBytes: 2048,
    browserMimeType: 'image/png',
    canonicalMimeType: 'image/png',
    mimeConflict: false,
    packagePath: PACKAGE_PATH,
  };
}

function serverPackage(manifest: Partial<ImportPackageManifest> | null): BrowserImportServerPackage {
  return {
    packagePath: PACKAGE_PATH,
    folderName: '2026-synthetic',
    proposedPublicId: '2026-synthetic',
    status: 'valid',
    metadataSource: 'xlsx',
    manifest: manifest === null ? null : ({
      publicId: '2026-synthetic', title: 'T', summary: 'S', background: '', solution: '', year: '2026',
      program: 'P', studyProgram: 'P', discipline: 'D', industry: '', industryPartner: '',
      academicSupervisor: '', groupName: 'G', participantContactEmail: '', teamMembers: ['A'],
      layoutConfig: {},
      ...manifest,
    } as ImportPackageManifest),
    filePresence: {
      xlsxPresent: true, jsonPresent: false,
      posterImagePresent: true, posterPdfPresent: true, snapshotPresent: true,
    },
    errors: [],
    warnings: [],
  };
}

function resolve(manifest: Partial<ImportPackageManifest> | null) {
  const preflight = {
    packagesMap: new Map<string, ServerDerivedDescriptor[]>([[PACKAGE_PATH, [
      descriptor('poster.png', 'u1'),
      descriptor('poster.pdf', 'u2'),
      descriptor('snapshot-1.png', 'u3'),
    ]]]),
  } as Pick<ManifestPreflightSuccess, 'packagesMap'>;

  const result = resolveExpectedBrowserImportMedia({
    preflight,
    packages: [serverPackage(manifest)],
    selectedPackagePaths: [PACKAGE_PATH],
  });
  if (!result.success) throw new Error(`Unexpected failure: ${result.code}`);
  return result.files;
}

describe('server-authoritative snapshot alt derivation', () => {
  it('takes the alt text from the reparsed package manifest', () => {
    const snapshot = resolve({ snapshotAltText: VALID_ALT }).find((f) => f.assetType === 'snapshot_image');
    expect(snapshot?.snapshotAltText).toBe(VALID_ALT);
  });

  it('trims the derived value so what is staged is what gets persisted', () => {
    const snapshot = resolve({ snapshotAltText: `  ${VALID_ALT}  ` }).find((f) => f.assetType === 'snapshot_image');
    expect(snapshot?.snapshotAltText).toBe(VALID_ALT);
  });

  it('never invents a value for a legacy package that supplied none', () => {
    for (const manifest of [{}, { snapshotAltText: '   ' }, null]) {
      const snapshot = resolve(manifest).find((f) => f.assetType === 'snapshot_image');
      expect(snapshot?.snapshotAltText).toBeNull();
      // Specifically not the filename, which is file information rather than a description.
      expect(snapshot?.snapshotAltText).not.toBe('snapshot-1.png');
    }
  });

  it('leaves poster image and poster PDF alt null', () => {
    const files = resolve({ snapshotAltText: VALID_ALT });
    expect(files.find((f) => f.assetType === 'poster_image')?.snapshotAltText).toBeNull();
    expect(files.find((f) => f.assetType === 'poster_pdf')?.snapshotAltText).toBeNull();
  });
});

describe('canonical media intent binding', () => {
  const base = {
    batchId: '11111111-1111-4111-8111-111111111111',
    metadataIntentHash: 'a'.repeat(64),
  };
  const files = (snapshotAltText: string | null) => [
    { packagePath: PACKAGE_PATH, projectPublicId: '2026-synthetic', assetType: 'poster_image', fileName: 'poster.png', fileSizeBytes: 2048, snapshotAltText: null },
    { packagePath: PACKAGE_PATH, projectPublicId: '2026-synthetic', assetType: 'snapshot_image', fileName: 'snapshot-1.png', fileSizeBytes: 2048, snapshotAltText },
  ];

  it('is stable for an identical resubmission', () => {
    expect(computeCanonicalMediaIntentHash({ ...base, files: files(VALID_ALT) }))
      .toBe(computeCanonicalMediaIntentHash({ ...base, files: files(VALID_ALT) }));
  });

  it('changes when the authoritative snapshot alt changes', () => {
    // An alt text edited between attempts therefore cannot be smuggled through an older intent —
    // the finalization RPC rejects the mismatch exactly as it would any other media change.
    expect(computeCanonicalMediaIntentHash({ ...base, files: files(VALID_ALT) }))
      .not.toBe(computeCanonicalMediaIntentHash({ ...base, files: files('A different description.') }));
  });

  it('distinguishes an absent alt from a present one', () => {
    expect(computeCanonicalMediaIntentHash({ ...base, files: files(null) }))
      .not.toBe(computeCanonicalMediaIntentHash({ ...base, files: files(VALID_ALT) }));
  });

  it('stays order-independent across the expected file set', () => {
    const forward = computeCanonicalMediaIntentHash({ ...base, files: files(VALID_ALT) });
    const reversed = computeCanonicalMediaIntentHash({ ...base, files: [...files(VALID_ALT)].reverse() });
    expect(forward).toBe(reversed);
  });
});
