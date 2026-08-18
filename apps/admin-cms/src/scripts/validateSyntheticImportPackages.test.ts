import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SyntheticImportValidationReport,
} from '../fixtures/syntheticImportPackageHarness';
import type { SyntheticImportPackageCount } from '../fixtures/syntheticImportPackages';
import { DEFAULT_SYNTHETIC_SEED } from '../fixtures/syntheticProjects';

const runHarnessMock = vi.hoisted(() => vi.fn());

vi.mock('../fixtures/syntheticImportPackageHarness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fixtures/syntheticImportPackageHarness')>();
  return {
    ...actual,
    runSyntheticImportValidationHarness: runHarnessMock,
  };
});

import { runSyntheticImportValidationCommand } from './validateSyntheticImportPackages';

function createReport(
  requestedCount: SyntheticImportPackageCount,
  seed: number,
): SyntheticImportValidationReport {
  const counts = {
    packageCount: requestedCount,
    validPackageCount: requestedCount,
    warningPackageCount: 0,
    invalidPackageCount: 0,
  };

  return {
    seed,
    requestedCount,
    baseline: {
      counts,
      canonicalPreview: {
        mode: requestedCount === 1 ? 'single' : 'batch',
        selectedRootName: 'synthetic-import-batch',
        packageCount: requestedCount,
        selectedFileCount: requestedCount * 4,
        validPackageCount: requestedCount,
        warningPackageCount: 0,
        invalidPackageCount: 0,
        totalWarnings: 0,
        totalErrors: 0,
        mediaValidationMode: 'descriptor_only',
        batchIssues: [],
        packages: [],
      },
      canonicalPreviewStable: true,
    },
    variantScenarios: [],
    counts: {
      packageCount: 0,
      validPackageCount: 0,
      warningPackageCount: 0,
      invalidPackageCount: 0,
    },
    issueDistribution: [],
  };
}

describe('runSyntheticImportValidationCommand', () => {
  beforeEach(() => {
    runHarnessMock.mockReset();
    runHarnessMock.mockImplementation(
      async ({ count, seed }: { count: SyntheticImportPackageCount; seed: number }) =>
        createReport(count, seed),
    );
  });

  it('runs all supported sizes with the default seed when no arguments are supplied', async () => {
    const output = await runSyntheticImportValidationCommand([]);

    expect(runHarnessMock.mock.calls.map(([options]) => options)).toEqual([
      { count: 1, seed: DEFAULT_SYNTHETIC_SEED },
      { count: 10, seed: DEFAULT_SYNTHETIC_SEED },
      { count: 25, seed: DEFAULT_SYNTHETIC_SEED },
    ]);
    expect(output.match(/Synthetic import validation harness/g)).toHaveLength(3);
  });

  it.each([1, 10, 25] as const)('runs only the requested --size=%i batch', async (size) => {
    const output = await runSyntheticImportValidationCommand([`--size=${size}`]);

    expect(runHarnessMock).toHaveBeenCalledOnce();
    expect(runHarnessMock).toHaveBeenCalledWith({ count: size, seed: DEFAULT_SYNTHETIC_SEED });
    expect(output).toContain(`baseline packages: ${size}`);
  });

  it('passes a deterministic explicit seed through to the harness and summary', async () => {
    const output = await runSyntheticImportValidationCommand(['--size=25', '--seed=9876']);

    expect(runHarnessMock).toHaveBeenCalledWith({ count: 25, seed: 9876 });
    expect(output).toContain('seed: 9876');
    expect(output).toContain('baseline valid: 25');
    expect(output).toContain('canonical preview stable: yes');
    expect(output).toContain('issue distribution:');
  });

  it('rejects a positive integer size outside the supported set', async () => {
    await expect(runSyntheticImportValidationCommand(['--size=2']))
      .rejects.toThrow('--size must be one of: 1, 10, 25.');
    expect(runHarnessMock).not.toHaveBeenCalled();
  });

  it.each([
    ['--size=1.5', '--size must be a non-negative safe integer.'],
    ['--size=not-a-number', '--size must be a non-negative safe integer.'],
    ['--size=-1', '--size must be a non-negative safe integer.'],
    ['--seed=1.5', '--seed must be a non-negative safe integer.'],
    ['--seed=not-a-number', '--seed must be a non-negative safe integer.'],
    ['--seed=-1', '--seed must be a non-negative safe integer.'],
  ])('rejects invalid argument %s', async (argument, message) => {
    await expect(runSyntheticImportValidationCommand([argument])).rejects.toThrow(message);
    expect(runHarnessMock).not.toHaveBeenCalled();
  });
});
