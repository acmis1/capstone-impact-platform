import { describe, expect, it } from 'vitest';

import { analyzeBrowserImportServer } from '../import/parseBrowserImportPreview';
import {
  assertExactIdentitySet,
  buildIntegratedCohortFixture,
  INTEGRATED_COHORT_SIZE,
  INTEGRATED_FORM_COUNT,
  INTEGRATED_PACKAGE_COUNT,
} from './integratedCohort';

describe('LV-01 integrated cohort fixture', () => {
  it('freezes one stable 100 package + 20 form identity manifest', async () => {
    const first = await buildIntegratedCohortFixture();
    const second = await buildIntegratedCohortFixture();

    expect(first.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.manifest.digest).toBe(first.manifest.digest);
    expect(first.manifest.entries).toHaveLength(INTEGRATED_COHORT_SIZE);
    expect(first.manifest.entries.filter((entry) => entry.intakeMode === 'package')).toHaveLength(INTEGRATED_PACKAGE_COUNT);
    expect(first.manifest.entries.filter((entry) => entry.intakeMode === 'form')).toHaveLength(INTEGRATED_FORM_COUNT);
    expect(new Set(first.manifest.entries.map((entry) => entry.publicId)).size).toBe(INTEGRATED_COHORT_SIZE);
    expect(new Set(first.manifest.entries.map((entry) => entry.program)).size).toBe(5);
    expect(new Set(first.manifest.entries.map((entry) => entry.layoutPreset)).size).toBe(3);
  });

  it('materializes form-origin members through the form authority into normal server analysis', async () => {
    const fixture = await buildIntegratedCohortFixture();
    const formBatch = fixture.batches.at(-1)!;
    const analysis = await analyzeBrowserImportServer(
      formBatch.materialized.selectionManifest,
      formBatch.materialized.uploadedMetadataFiles,
      fixture.adminReference,
    );
    expect(formBatch.entries.filter((item) => item.entry.intakeMode === 'form')).toHaveLength(INTEGRATED_FORM_COUNT);
    expect(analysis.packages).toHaveLength(formBatch.entries.length);
    expect(analysis.packages.every((item) => item.status === 'valid')).toBe(true);
    expect(analysis.packages.every((item) => item.reconciliation?.status === 'RECONCILED')).toBe(true);
  });

  it('fails closed for additions, omissions, substitutions, and duplicates', () => {
    expect(() => assertExactIdentitySet(['a', 'b'], ['a', 'b'], 'TEST')).not.toThrow();
    expect(() => assertExactIdentitySet(['a', 'b'], ['a'], 'TEST')).toThrow('LV01_TEST_IDENTITY_SET_MISMATCH');
    expect(() => assertExactIdentitySet(['a', 'b'], ['a', 'c'], 'TEST')).toThrow('LV01_TEST_IDENTITY_SET_MISMATCH');
    expect(() => assertExactIdentitySet(['a', 'b'], ['a', 'b', 'c'], 'TEST')).toThrow('LV01_TEST_IDENTITY_SET_MISMATCH');
    expect(() => assertExactIdentitySet(['a', 'b'], ['a', 'a'], 'TEST')).toThrow('LV01_TEST_ACTUAL_DUPLICATE_IDENTITY');
  });
});
