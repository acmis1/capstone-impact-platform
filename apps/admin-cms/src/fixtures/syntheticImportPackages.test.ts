import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';

import { validateFolderDerivedPublicId } from '../import/publicIdValidation';
import {
  COLUMN_DEFINITIONS,
} from '../import/projectDetailsWorkbookContract';
import { parseProjectDetailsWorkbook } from '../import/parseProjectDetailsWorkbook';
import {
  validateBrowserImportPreviewResponse,
} from '../import/browserImportPreviewContract';
import { parseBrowserImportPreview } from '../import/parseBrowserImportPreview';
import {
  canonicalizeSyntheticPreview,
  runSyntheticImportValidationHarness,
} from './syntheticImportPackageHarness';
import {
  createSyntheticAdminReferenceOptions,
  generateSyntheticImportBatch,
  SYNTHETIC_IMPORT_PACKAGE_COUNTS,
  SYNTHETIC_IMPORT_VARIANTS,
  type SyntheticPreviewVariant,
} from './syntheticImportPackages';

async function workbookMetadataSnapshot(count: 1 | 10 | 25, seed: number) {
  const batch = await generateSyntheticImportBatch({ count, seed });
  return Promise.all(
    batch.packages.map(async (pkg) => ({
      variant: pkg.variant,
      publicId: pkg.publicId,
      descriptors: pkg.descriptors.map(({ originalPath, fileSizeBytes, browserMimeType }) => ({
        originalPath,
        fileSizeBytes,
        browserMimeType,
      })),
      workbook: await parseProjectDetailsWorkbook(pkg.workbookBuffer),
    })),
  );
}

describe('synthetic import package generator', () => {
  it.each(SYNTHETIC_IMPORT_PACKAGE_COUNTS)('generates exactly %i logical packages', async (count) => {
    const batch = await generateSyntheticImportBatch({ count, seed: 1234 });

    expect(batch.packages).toHaveLength(count);
    expect(batch.selectionManifest.selectedRootName).toBe(
      count === 1 ? batch.packages[0].publicId : 'synthetic-import-batch',
    );
    expect(batch.selectionManifest.fileCount).toBe(
      batch.packages.reduce((total, pkg) => total + pkg.descriptors.length, 0),
    );
  });

  it('reuses deterministic project content and materializes deterministic workbook values', async () => {
    const first = await workbookMetadataSnapshot(10, 1234);
    const second = await workbookMetadataSnapshot(10, 1234);
    const differentSeed = await workbookMetadataSnapshot(10, 5678);

    expect(first).toEqual(second);
    expect(differentSeed).not.toEqual(first);
  });

  it.each(SYNTHETIC_IMPORT_PACKAGE_COUNTS)('uses the existing synthetic ID and data conventions for %i', async (count) => {
    const batch = await generateSyntheticImportBatch({ count });
    const serialized = JSON.stringify(batch.packages.map((pkg) => pkg.project));

    batch.packages.forEach((pkg) => {
      expect(pkg.publicId).toMatch(/^synthetic-\d{4}-\d{4}$/);
      expect(validateFolderDerivedPublicId(pkg.publicId).valid).toBe(true);
      expect(pkg.project.groupName).toMatch(/^Synthetic Team \d{4}$/);
      expect(pkg.project.teamMembers.every((member) => member.startsWith('Synthetic Member '))).toBe(true);
      expect(pkg.descriptors.every((descriptor) => !descriptor.originalPath.includes('\\'))).toBe(true);
      expect(pkg.descriptors.every((descriptor) => !/^[A-Za-z]:/.test(descriptor.originalPath))).toBe(true);
    });

    expect(serialized).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  });

  it('uses the canonical workbook contract and production parser', async () => {
    const batch = await generateSyntheticImportBatch({ count: 1, seed: 1234 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(batch.packages[0].workbookBuffer as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
    const headerValues = (workbook.getWorksheet('Project details')?.getRow(1).values as unknown[]).slice(1);

    expect(headerValues).toEqual(COLUMN_DEFINITIONS.map((definition) => definition.canonicalName));
    const parsed = await parseProjectDetailsWorkbook(batch.packages[0].workbookBuffer);
    expect(parsed.metadata.title).toBe(batch.packages[0].project.title);
    expect(parsed.metadata.program).toBe(batch.packages[0].project.program);
    expect(parsed.metadata.teamMembers).toEqual(batch.packages[0].project.teamMembers);
  });

  it('produces a valid preview at every supported scale', async () => {
    for (const count of SYNTHETIC_IMPORT_PACKAGE_COUNTS) {
      const batch = await generateSyntheticImportBatch({ count, seed: 1234 });
      const preview = await parseBrowserImportPreview(
        batch.selectionManifest,
        batch.uploadedMetadataFiles,
      );

      expect(validateBrowserImportPreviewResponse(preview)).not.toBeNull();
      expect(preview.batch.validPackageCount).toBe(count);
      expect(preview.batch.warningPackageCount).toBe(0);
      expect(preview.batch.invalidPackageCount).toBe(0);
    }
  });

  it('keeps valid canonical previews stable for the same seed', async () => {
    const first = await generateSyntheticImportBatch({ count: 25, seed: 1234 });
    const second = await generateSyntheticImportBatch({ count: 25, seed: 1234 });
    const firstPreview = await parseBrowserImportPreview(first.selectionManifest, first.uploadedMetadataFiles);
    const secondPreview = await parseBrowserImportPreview(second.selectionManifest, second.uploadedMetadataFiles);

    expect(canonicalizeSyntheticPreview(firstPreview)).toEqual(canonicalizeSyntheticPreview(secondPreview));
  });
});

describe('synthetic import validation variants', () => {
  it('runs every required variant and reports the expected outcome', async () => {
    const adminCore = await import('../lib/supabase/adminCore');
    const createClientSpy = vi.spyOn(adminCore, 'createSupabaseAdminClientCore');
    const report = await runSyntheticImportValidationHarness({ count: 1, seed: 1234 });
    const scenarios = new Map(report.variantScenarios.map((scenario) => [scenario.variant, scenario]));

    expect([...scenarios.keys()]).toEqual([...SYNTHETIC_IMPORT_VARIANTS]);
    expect(report.baseline.counts).toEqual({
      packageCount: 1,
      validPackageCount: 1,
      warningPackageCount: 0,
      invalidPackageCount: 0,
    });
    expect(report.counts).toEqual({
      packageCount: 11,
      validPackageCount: 1,
      warningPackageCount: 2,
      invalidPackageCount: 8,
    });
    expect(scenarios.get('fully-valid')?.issueDistribution).toEqual([]);
    expect(scenarios.get('optional-files-absent')?.issueDistribution).toEqual([
      { code: 'FILE_MISSING_RECOMMENDED', severity: 'warning', count: 1 },
    ]);
    expect(scenarios.get('warning-level')?.issueDistribution).toEqual([
      { code: 'WORKBOOK_DUPLICATE_TEAM_MEMBER', severity: 'warning', count: 1 },
    ]);
    expect(scenarios.get('duplicate-public-id')?.duplicateStagingCode).toBe('INVALID_SELECTION');
    expect(createClientSpy).not.toHaveBeenCalled();
    createClientSpy.mockRestore();
  });

  it('routes invalid taxonomy through Admin Reference reconciliation', async () => {
    const batch = await generateSyntheticImportBatch({
      count: 1,
      seed: 1234,
      variants: ['invalid-taxonomy'],
    });
    const adminReference = await createSyntheticAdminReferenceOptions([batch.packages[0].project]);
    const preview = await parseBrowserImportPreview(
      batch.selectionManifest,
      batch.uploadedMetadataFiles,
      adminReference,
    );
    const pkg = preview.batch.packages[0];

    expect(pkg.status).toBe('invalid');
    expect(pkg.reconciliation).toEqual(expect.objectContaining({
      status: 'ADMIN_REFERENCE_FIELD_MISMATCH',
      mismatchedFields: ['program'],
    }));
    expect(pkg.errors.map((issue) => issue.code)).toContain('ADMIN_REFERENCE_FIELD_MISMATCH');
  });

  it('routes malformed workbook bytes through the existing malformed-workbook boundary', async () => {
    const batch = await generateSyntheticImportBatch({ count: 1, seed: 1234 });
    const malformed = new Map(batch.uploadedMetadataFiles);
    malformed.set(batch.packages[0].metadataUploadKey, Buffer.from('not an xlsx workbook', 'utf8'));
    const preview = await parseBrowserImportPreview(batch.selectionManifest, malformed);

    expect(preview.batch.packages[0].status).toBe('invalid');
    expect(preview.batch.packages[0].errors.map((issue) => issue.code)).toContain('WORKBOOK_MALFORMED');
  });

  it('supports explicit preview variant assignment without changing the package schema', async () => {
    const variants: SyntheticPreviewVariant[] = [
      'fully-valid',
      'optional-files-absent',
      'warning-level',
    ];
    const batch = await generateSyntheticImportBatch({ count: 10, seed: 1234, variants });

    expect(batch.packages.slice(0, 3).map((pkg) => pkg.variant)).toEqual(variants);
    expect(batch.packages.slice(3).every((pkg) => pkg.variant === 'fully-valid')).toBe(true);
    expect(batch.packages.every((pkg) => pkg.descriptors.some((descriptor) => descriptor.originalPath.endsWith('project-details.xlsx')))).toBe(true);
  });
});
