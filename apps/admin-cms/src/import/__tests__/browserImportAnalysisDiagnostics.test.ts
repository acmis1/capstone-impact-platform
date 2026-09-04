import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { materializeReleaseEvaluationCorpus } from '../../fixtures/releaseEvaluationCorpus';
import * as reconciliation from '../adminReferenceReconciliationCore';
import { analyzeBrowserImportServer } from '../parseBrowserImportPreview';

describe('server import reconciliation diagnostics', () => {
  let corpus: Awaited<ReturnType<typeof materializeReleaseEvaluationCorpus>>;
  beforeAll(async () => {
    corpus = await materializeReleaseEvaluationCorpus({ runNamespace: 'diagnostics-test' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('brackets the actual reconciliation once, after worksheet parsing, inside the combined analysis', async () => {
    const batch = corpus.acceptedBatches[0];
    const baseline = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions);
    const events: string[] = [];
    const parse = reconciliation.parseAdminReferenceWorksheet;
    const reconcile = reconciliation.reconcilePackagesAgainstAdminReference;
    vi.spyOn(reconciliation, 'parseAdminReferenceWorksheet').mockImplementation(async (...args) => {
      const result = await parse(...args);
      events.push('worksheet parsed');
      return result;
    });
    const observed = vi.spyOn(reconciliation, 'reconcilePackagesAgainstAdminReference').mockImplementation((input) => {
      events.push('reconciliation start');
      const result = reconcile(input);
      events.push('reconciliation end');
      return result;
    });
    const ticks = [10, 30, 37, 100];
    const now = () => { events.push('clock'); return ticks.shift()!; };
    const duration = vi.fn();
    const started = now();
    const result = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions, {
      now, onAdminReconciliationDuration: duration,
    });
    const combined = now() - started;
    expect(events).toEqual(['clock', 'worksheet parsed', 'clock', 'reconciliation start', 'reconciliation end', 'clock', 'clock']);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(duration).toHaveBeenCalledExactlyOnceWith(7);
    expect(combined).toBe(90);
    expect(result).toEqual(baseline);
  });

  it('preserves rejected-package decisions and fingerprints with or without diagnostics', async () => {
    const batch = corpus.rejectedBatches[0];
    const baseline = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions);
    const duration = vi.fn();
    const result = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions, {
      now: () => 5, onAdminReconciliationDuration: duration,
    });
    expect(result).toEqual(baseline);
    expect(result.packages.some((pkg) => pkg.reconciliation && pkg.reconciliation.status !== 'RECONCILED')).toBe(true);
    expect(duration).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('does not read the clock or report a reconciliation when no reference is supplied', async () => {
    const batch = corpus.acceptedBatches[0];
    const now = vi.fn();
    const duration = vi.fn();
    const baseline = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles);
    const result = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, undefined, {
      now, onAdminReconciliationDuration: duration,
    });
    expect(result).toEqual(baseline);
    expect(now).not.toHaveBeenCalled();
    expect(duration).not.toHaveBeenCalled();
  });

  it.each(['clock', 'observer'])('cannot change output when the optional %s throws', async (failure) => {
    const batch = corpus.rejectedBatches[0];
    const baseline = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions);
    const fail = () => { throw new Error('diagnostic failure'); };
    const result = await analyzeBrowserImportServer(batch.materialized.selectionManifest, batch.materialized.uploadedMetadataFiles, batch.adminReferenceOptions, {
      now: failure === 'clock' ? fail : () => 10,
      onAdminReconciliationDuration: failure === 'observer' ? fail : vi.fn(),
    });
    expect(result).toEqual(baseline);
  });
});
