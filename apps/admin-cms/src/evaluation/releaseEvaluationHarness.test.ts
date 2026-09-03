import { describe, expect, it, vi } from 'vitest';

import {
  deriveActualPreviewObservations,
  runReleaseEvaluation,
  runForcedFailureCleanupProbe,
  validateReleaseEvaluationRunNamespace,
  assertReleaseLocalTarget,
  assertCohortAccounting,
  readinessField,
  cleanupOwnedState,
  cleanupInterruptedReleaseEvaluationRun,
} from './releaseEvaluationHarness';
import { getStagingBuckets } from '../lib/supabase/buckets';
vi.mock('../lib/supabase/buckets', () => ({
  getStagingBuckets: () => ({ DRAFT_PRIVATE: 'private', PUBLIC_ASSETS: 'public', PUBLIC_FEEDS: 'feeds' }),
}));
import { buildReleaseEvaluationCorpus } from '../fixtures/releaseEvaluationCorpus';
import {
  createReleaseEvidenceLedger,
  deriveFailureStageDistribution,
  evaluateReleaseAccounting,
  recordReleaseObservation,
} from './releaseEvaluationReport';

function previewPackage(overrides: Partial<Parameters<typeof deriveActualPreviewObservations>[1]> = {}) {
  return {
    status: 'invalid' as const,
    reconciliation: undefined,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function interruptedCleanupFixture() {
  const runNamespace = 'run-1-0123456789abcdef';
  const publicId = `release-${runNamespace}-synthetic-2022-0001`;
  const ownedPath = `drafts/${publicId}/poster_image/poster.png`;
  const ordinaryPath = 'drafts/ordinary-project/poster_image/poster.png';
  const similarPath = `drafts/release-${runNamespace}0-synthetic-2022-0001/poster_image/poster.png`;
  const objects = new Set([ownedPath, ordinaryPath, similarPath]);
  const rows: Record<string, Record<string, string>[]> = {
    projects: [{ id: 'owned-project', public_id: publicId }, { id: 'ordinary-project', public_id: 'ordinary-project' }],
    media_assets: [{ project_id: 'owned-project', storage_bucket: getStagingBuckets().DRAFT_PRIVATE, storage_path: ownedPath }],
  };
  const failures = { remove: true, list: false };
  const remove = vi.fn(async (paths: string[]) => {
    if (failures.remove) return { error: { message: 'injected Storage outage' } };
    paths.forEach((path) => objects.delete(path));
    return { error: null };
  });
  const list = vi.fn(async (prefix: string, options: { limit: number; offset?: number }) => {
    if (failures.list) return { data: null, error: { message: 'injected listing outage' } };
    const entries = new Map<string, { name: string; id: string | null }>();
    for (const path of objects) {
      if (!path.startsWith(`${prefix}/`)) continue;
      const relative = path.slice(prefix.length + 1);
      const name = relative.split('/')[0];
      entries.set(name, { name, id: relative.includes('/') ? null : 'storage-object' });
    }
    const offset = options.offset || 0;
    return { data: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + options.limit), error: null };
  });
  const client = {
    supabaseUrl: 'http://127.0.0.1:54321',
    from: (table: string) => {
      let deleting = false;
      let filter: (row: Record<string, string>) => boolean = () => true;
      const query = {
        select: () => query,
        delete: () => { deleting = true; return query; },
        in: (column: string, values: string[]) => { filter = (row) => values.includes(row[column]); return query; },
        like: (column: string, pattern: string) => { filter = (row) => row[column]?.startsWith(pattern.slice(0, -1)); return query; },
        then: (resolve: (value: unknown) => unknown) => {
          const data = (rows[table] || []).filter(filter);
          if (deleting) rows[table] = (rows[table] || []).filter((row) => !filter(row));
          return Promise.resolve({ data, count: data.length, error: null }).then(resolve);
        },
      };
      return query;
    },
    storage: { from: () => ({ list, remove }) },
  } as unknown as Parameters<typeof cleanupOwnedState>[0];
  return { runNamespace, publicId, ownedPath, ordinaryPath, similarPath, objects, rows, failures, remove, list, client };
}

describe('release evaluation harness safety', () => {
  it('recovers orphaned Storage using only the run namespace after failed removal and successful DB cleanup', async () => {
    const fixture = interruptedCleanupFixture();
    const runtime = { privateBucket: getStagingBuckets().DRAFT_PRIVATE, ownedPublicIds: new Set([fixture.publicId]), ownedBatchIds: new Set<string>(), ownedStoragePaths: new Set([fixture.ownedPath]), previewIds: new Set<string>() };
    const first = await cleanupOwnedState(fixture.client, runtime);
    expect(first.completed).toBe(false);
    expect(first.residue.projects).toBe(0);
    expect(first.residue.privateStorageObjects).toBe(1);
    expect(fixture.rows.projects).toEqual([{ id: 'ordinary-project', public_id: 'ordinary-project' }]);
    expect(fixture.rows.media_assets).toEqual([]);
    expect((await cleanupOwnedState(fixture.client, runtime)).completed).toBe(false);
    expect(fixture.objects.has(fixture.ownedPath)).toBe(true);

    fixture.failures.remove = false;
    const recovered = await cleanupInterruptedReleaseEvaluationRun({ supabase: fixture.client, apiUrl: 'http://127.0.0.1:54321', runNamespace: fixture.runNamespace });
    expect(fixture.objects.has(fixture.ownedPath)).toBe(false);
    expect(recovered.completed).toBe(true);
    expect(Object.values(recovered.residue).every((count) => count === 0)).toBe(true);
    expect(fixture.objects).toEqual(new Set([fixture.ordinaryPath, fixture.similarPath]));
    expect(fixture.remove.mock.calls.every(([paths]) => paths.every((path) => path === fixture.ownedPath))).toBe(true);
  });

  it('reports orphaned Storage residue when recovery removal still fails', async () => {
    const fixture = interruptedCleanupFixture();
    fixture.rows.projects = [];
    fixture.rows.media_assets = [];
    const recovered = await cleanupInterruptedReleaseEvaluationRun({ supabase: fixture.client, apiUrl: 'http://127.0.0.1:54321', runNamespace: fixture.runNamespace });
    expect(recovered.completed).toBe(false);
    expect(recovered.residue.privateStorageObjects).toBe(1);
    expect(fixture.objects.has(fixture.ownedPath)).toBe(true);
  });

  it('fails closed before deletion when Storage discovery is unavailable', async () => {
    const fixture = interruptedCleanupFixture();
    fixture.failures.list = true;
    await expect(cleanupInterruptedReleaseEvaluationRun({ supabase: fixture.client, apiUrl: 'http://127.0.0.1:54321', runNamespace: fixture.runNamespace })).rejects.toThrow('no cleanup was attempted');
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.rows.projects).toHaveLength(2);
  });

  it.each(['similar-project', 'unknown-asset', 'nested-file'])('leaves ambiguous %s residue untouched and refuses success', async (kind) => {
    const fixture = interruptedCleanupFixture();
    const ambiguousPath = kind === 'similar-project'
      ? `drafts/release-${fixture.runNamespace}-synthetic-2022-0001-copy/poster_image/poster.png`
      : kind === 'unknown-asset' ? `drafts/${fixture.publicId}/ordinary/file.txt`
        : `drafts/${fixture.publicId}/poster_image/nested/file.png`;
    fixture.objects.add(ambiguousPath);
    fixture.failures.remove = false;
    await expect(cleanupInterruptedReleaseEvaluationRun({ supabase: fixture.client, apiUrl: 'http://127.0.0.1:54321', runNamespace: fixture.runNamespace })).rejects.toThrow('no cleanup was attempted');
    expect(fixture.remove).not.toHaveBeenCalled();
    expect(fixture.objects.has(ambiguousPath)).toBe(true);
    expect(fixture.rows.projects).toHaveLength(2);
  });

  it('discovers folders and counts/removes objects beyond the first Storage list page', async () => {
    const fixture = interruptedCleanupFixture();
    fixture.rows.projects = [];
    fixture.rows.media_assets = [];
    for (let index = 0; index < 1001; index += 1) {
      fixture.objects.add(`drafts/ordinary-${String(index).padStart(4, '0')}/poster_image/seed.png`);
      fixture.objects.add(`drafts/${fixture.publicId}/poster_image/extra-${index}.png`);
    }
    fixture.failures.remove = false;
    const recovered = await cleanupInterruptedReleaseEvaluationRun({ supabase: fixture.client, apiUrl: 'http://127.0.0.1:54321', runNamespace: fixture.runNamespace });
    expect(recovered.completed).toBe(true);
    expect(recovered.residue.privateStorageObjects).toBe(0);
    expect(fixture.objects.size).toBe(1003);
    expect(fixture.list.mock.calls.some(([prefix, options]) => prefix === 'drafts' && options.offset === 1000)).toBe(true);
    expect(fixture.list.mock.calls.some(([prefix, options]) => prefix.endsWith('/poster_image') && options.offset === 1000)).toBe(true);
    expect([...fixture.objects].some((path) => path.startsWith(`drafts/${fixture.publicId}/`))).toBe(false);
  });

  it.each(['https://localhost.example.com', 'https://127.0.0.1.example.com', 'https://127.0.0.1@host.example.com', 'ftp://127.0.0.1', 'http://127.0.0.1/forward', 'http://127.0.0.1?target=remote'])('refuses deceptive or non-HTTP target %s', (url) => {
    expect(() => assertReleaseLocalTarget(url)).toThrow('loopback');
  });

  it('verifies every actual client target, including the production staging singleton', () => {
    expect(() => assertReleaseLocalTarget('http://127.0.0.1:54321', ['https://example.supabase.co'])).toThrow('loopback');
    expect(() => assertReleaseLocalTarget('http://127.0.0.1:54321', ['http://127.0.0.1:54331'])).toThrow('match');
    expect(() => assertReleaseLocalTarget('http://[::1]:54321', ['http://[::1]:54321/'])).not.toThrow();
  });

  it('rejects dropped, duplicated, and substituted bulk results', () => {
    for (const result of [['a'], ['a', 'a'], ['a', 'foreign']]) expect(() => assertCohortAccounting(['a', 'b'], result)).toThrow();
    expect(() => assertCohortAccounting(['a', 'b'], ['b', 'a'])).not.toThrow();
    expect(readinessField('Poster full text is missing.')).toBe('posterText');
    expect(readinessField('Accessibility text is missing.')).toBe('accessibilityText');
  });
  it('refuses a non-loopback endpoint before touching the Supabase client', async () => {
    const supabase = {} as Parameters<typeof runReleaseEvaluation>[0]['supabase'];
    await expect(runReleaseEvaluation({ supabase, apiUrl: 'https://example.supabase.co' })).rejects.toThrow('loopback');
  });

  it('proves the tooling failure hook enters cleanup and leaves no residue', async () => {
    const createOwnedState = vi.fn(async () => undefined);
    const cleanupOwnedState = vi.fn(async () => ({ completed: true, residue: { projects: 0, media: 0, batches: 0 } }));
    const result = await runForcedFailureCleanupProbe({ createOwnedState, cleanupOwnedState });

    expect(createOwnedState).toHaveBeenCalledOnce();
    expect(cleanupOwnedState).toHaveBeenCalledOnce();
    expect(result).toEqual({ completed: true, residue: { projects: 0, media: 0, batches: 0 } });
  });

  it('does not certify a failed cleanup with zero visible residue', async () => {
    const result = await runForcedFailureCleanupProbe({ createOwnedState: async () => {}, cleanupOwnedState: async () => ({ completed: false, residue: { projects: 0 } }) });
    expect(result.completed).toBe(false);
  });

  it('continues cleanup after one deletion fails and never removes an unrelated media path', async () => {
    const deleted: string[] = [];
    const remove = vi.fn(async () => ({ error: null }));
    const client = {
      from: (table: string) => {
        let deleting = false;
        let head = false;
        const query = {
          select: (_columns: string, options?: { head?: boolean }) => { head = Boolean(options?.head); return query; },
          delete: () => { deleting = true; deleted.push(table); return query; },
          in: () => query,
          like: () => query,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve({
            data: deleting || head ? [] : table === 'projects' ? [{ id: 'owned-project' }]
              : table === 'media_assets' ? [{ storage_bucket: 'private', storage_path: 'drafts/ordinary-project/poster_image/poster.png' }] : [],
            error: deleting && table === 'approval_records' ? { code: 'injected-failure' } : null,
            count: 0,
          }).then(resolve),
        };
        return query;
      },
      storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove }) },
    } as unknown as Parameters<typeof cleanupOwnedState>[0];
    const result = await cleanupOwnedState(client, { privateBucket: 'private', ownedPublicIds: new Set(['release-run-1-0123456789abcdef-synthetic-001']), ownedBatchIds: new Set(['owned-batch']), ownedStoragePaths: new Set(), previewIds: new Set() });
    expect(result.completed).toBe(false);
    expect(deleted).toEqual(expect.arrayContaining(['approval_records', 'validation_flags', 'projects', 'import_batches']));
    expect(remove).not.toHaveBeenCalled();
  });

  it('accepts only evaluator-generated namespaces for interrupted-run cleanup', () => {
    expect(() => validateReleaseEvaluationRunNamespace('run-1-0123456789abcdef')).not.toThrow();
    expect(() => validateReleaseEvaluationRunNamespace('run-2-fedcba9876543210')).not.toThrow();
    expect(() => validateReleaseEvaluationRunNamespace('release-anything')).toThrow('exact namespace');
    expect(() => validateReleaseEvaluationRunNamespace('run-1-../unsafe')).toThrow('exact namespace');
  });

  it('preserves an actual replacement code and reports the expected-code mismatch', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'xlsx-missing-title');
    if (!expectedCase) throw new Error('Missing expected-code test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    const observations = deriveActualPreviewObservations(expectedCase.caseId, previewPackage({
      errors: [{ code: 'WORKBOOK_ACTUAL_CODE_B', message: 'Actual parser reason.', severity: 'error' }],
    }));
    observations.forEach((observation) => recordReleaseObservation(ledger, observation));

    expect(ledger.entries.get(expectedCase.caseId)?.terminalReasonCode).toBe('WORKBOOK_ACTUAL_CODE_B');
    expect(evaluateReleaseAccounting(ledger).expectedActualMismatchCaseIds).toContain(expectedCase.caseId);
  });

  it('keeps an absent actual code absent and reports the mismatch', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'xlsx-missing-title');
    if (!expectedCase) throw new Error('Missing expected-code test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    recordReleaseObservation(ledger, { caseId: expectedCase.caseId, stage: 'parse', outcome: 'rejected' });

    expect(ledger.entries.get(expectedCase.caseId)?.terminalReasonCode).toBeUndefined();
    expect(evaluateReleaseAccounting(ledger).expectedActualMismatchCaseIds).toContain(expectedCase.caseId);
  });

  it('keeps a staging failure as the actual stage when the manifest expects package validation', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'missing-poster-image');
    if (!expectedCase) throw new Error('Missing package-failure test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    recordReleaseObservation(ledger, { caseId: expectedCase.caseId, stage: 'metadata-staging', outcome: 'rejected', code: 'LOOKUP_NOT_FOUND', persisted: false });

    expect(ledger.entries.get(expectedCase.caseId)?.terminalFailureStage).toBe('metadata-staging');
    expect(deriveFailureStageDistribution({ ...corpus, cases: [expectedCase] }, ledger).actual).toEqual({ 'metadata-staging': 1 });
  });

  it('records unexpected persistence as actual persistence and fails accounting', () => {
    const corpus = buildReleaseEvaluationCorpus();
    const expectedCase = corpus.cases.find((item) => item.packageProfile === 'missing-poster-image');
    if (!expectedCase) throw new Error('Missing persistence test case.');
    const ledger = createReleaseEvidenceLedger({ ...corpus, cases: [expectedCase], seededIssues: [], negativeControls: [] });
    recordReleaseObservation(ledger, { caseId: expectedCase.caseId, stage: 'final-persistence', outcome: 'accepted', persisted: true });

    const accounting = evaluateReleaseAccounting(ledger);
    expect(deriveFailureStageDistribution({ ...corpus, cases: [expectedCase] }, ledger).actual).toEqual({ persisted: 1 });
    expect(accounting.unexpectedPersistenceCaseIds).toContain(expectedCase.caseId);
    expect(accounting.expectedActualMismatchCaseIds).toContain(expectedCase.caseId);
  });
});
