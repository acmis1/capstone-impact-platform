import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_SHORTLIST_LIMITS,
  hashDuplicateCorpus,
  normalizeDuplicateText,
  rankDuplicateCandidates,
  type DuplicateProjectProse,
} from '../duplicate-detection/duplicateRanker';

const current: DuplicateProjectProse = {
  publicId: 'current-project',
  title: 'Flood Alert Platform',
  summary: 'Local sensors detect rising water.',
  background: 'Manual inspection delays warnings.',
  solution: 'A dashboard notifies maintenance teams.',
};

function candidate(publicId: string, overrides: Partial<DuplicateProjectProse> = {}): DuplicateProjectProse {
  return { ...current, publicId, ...overrides };
}

describe('production lexical duplicate ranker', () => {
  it('excludes the current project, bounds the shortlist, and distinguishes exact and normalized-title signals', () => {
    const candidates = [
      current,
      candidate('exact'),
      candidate('normalized-title', { title: 'FLOOD-ALERT PLATFORM', summary: 'Different content.' }),
      ...Array.from({ length: 8 }, (_, index) => candidate(`other-${index}`, {
        title: `Other Project ${index}`,
        summary: `Unrelated project summary ${index}.`,
      })),
    ];
    const ranked = rankDuplicateCandidates(current, candidates);
    expect(ranked).toHaveLength(DUPLICATE_SHORTLIST_LIMITS.shortlist);
    expect(ranked.some((item) => item.publicId === current.publicId)).toBe(false);
    expect(ranked[0]).toMatchObject({ publicId: 'exact', lexicalScore: 1, exactContentMatch: true });
    expect(ranked.find((item) => item.publicId === 'normalized-title')).toMatchObject({
      exactContentMatch: false,
      normalizedTitleMatch: true,
    });
  });

  it('uses public ID as the deterministic tie breaker and handles a small corpus naturally', () => {
    const tied = [
      candidate('project-z', { title: 'No overlap', summary: '', background: '', solution: '' }),
      candidate('project-a', { title: 'No overlap', summary: '', background: '', solution: '' }),
    ];
    expect(rankDuplicateCandidates(current, tied).map((item) => item.publicId))
      .toEqual(['project-a', 'project-z']);
    expect(rankDuplicateCandidates(current, [])).toEqual([]);
  });

  it('normalizes Unicode deterministically and never splits a surrogate pair in excerpts', () => {
    const query = candidate('query', { title: 'Straße research', summary: 'emoji 😀' });
    const match = candidate('unicode-1', {
      title: 'STRASSE research',
      summary: `emoji ${'a'.repeat(233)}😀tail`,
    });
    const [ranked] = rankDuplicateCandidates(query, [match]);

    expect(normalizeDuplicateText(query.title)).toBe(normalizeDuplicateText(match.title));
    expect(ranked.normalizedTitleMatch).toBe(true);
    expect(ranked.summaryExcerpt).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('hashes the canonical corpus independently of database order and changes for every semantic corpus mutation', () => {
    const first = candidate('project-a');
    const second = candidate('project-b', { title: 'Other', summary: 'Other summary' });
    const baseline = hashDuplicateCorpus([first, second]);
    expect(hashDuplicateCorpus([second, first])).toBe(baseline);
    expect(hashDuplicateCorpus([first])).not.toBe(baseline);
    for (const changed of [
      { ...second, title: 'Changed' },
      { ...second, summary: 'Changed' },
      { ...second, background: 'Changed' },
      { ...second, solution: 'Changed' },
    ]) expect(hashDuplicateCorpus([first, changed])).not.toBe(baseline);
    expect(hashDuplicateCorpus([first, second, candidate('project-c')])).not.toBe(baseline);
  });

  it('fails closed above the measured candidate-pool maximum', () => {
    const oversized = Array.from(
      { length: DUPLICATE_SHORTLIST_LIMITS.candidatePool + 1 },
      (_, index) => candidate(`project-${index}`),
    );
    expect(() => rankDuplicateCandidates(current, oversized)).toThrow('DUPLICATE_CANDIDATE_POOL_LIMIT_EXCEEDED');
    expect(() => hashDuplicateCorpus(oversized)).toThrow('DUPLICATE_CANDIDATE_POOL_LIMIT_EXCEEDED');
  });
});

interface FrozenManifest {
  duplicate_queries: Array<DuplicateProjectProse & { id: string }>;
  duplicate_candidates: Array<{ id: string; title: string; summary: string; background: string; solution: string }>;
}

interface FrozenReport {
  duplicates: {
    records: Array<{ query_id: string; top_5: Array<{ candidate_id: string; score: number }> }>;
  };
}

const repoRoot = resolve(process.cwd(), '..', '..');
const manifest = JSON.parse(readFileSync(
  resolve(repoRoot, 'tools', 'assistive-validation-benchmark', 'phase6', 'corpus', 'manifest.json'),
  'utf8',
)) as FrozenManifest;
const report = JSON.parse(readFileSync(
  resolve(repoRoot, 'docs', 'assistive-validation', 'evidence', 'phase-6a-report.json'),
  'utf8',
)) as FrozenReport;

describe('frozen Phase 6A TypeScript parity', () => {
  const representativeQueries = [
    'dq6-001-exact',
    'dq6-001-near',
    'dq6-003-near',
    'dq6-004-exact',
    'dq6-005-near',
    'dq6-013-near',
  ];

  it.each(representativeQueries)('reproduces ordering and score for %s', (queryId) => {
    const query = manifest.duplicate_queries.find((item) => item.id === queryId)!;
    const expected = report.duplicates.records.find((item) => item.query_id === queryId)!.top_5;
    const actual = rankDuplicateCandidates(
      { ...query, publicId: query.id },
      manifest.duplicate_candidates.map((item) => ({ ...item, publicId: item.id })),
    );
    expect(actual.map((item) => item.publicId)).toEqual(expected.map((item) => item.candidate_id));
    actual.forEach((item, index) => {
      // JavaScript and Python use the same formula; only binary floating representation may differ.
      expect(Math.abs(item.lexicalScore - expected[index].score)).toBeLessThanOrEqual(1e-12);
    });
  });
});

describe('bounded in-memory ranker performance evidence', () => {
  it.each([100, 500, 1_000])('records repeated pure-ranker timings for %i candidates', (count) => {
    const candidates = Array.from({ length: count }, (_, index) => candidate(`synthetic-${String(index).padStart(4, '0')}`, {
      title: `Synthetic Water Monitoring Project ${index}`,
      summary: `Synthetic summary ${index} for deterministic ranker measurement.`,
      background: `Background evidence ${index % 17} remains local and bounded.`,
      solution: `Solution ${index % 23} uses a dashboard and sensor workflow.`,
    }));
    rankDuplicateCandidates(current, candidates);
    const timings = Array.from({ length: 20 }, () => {
      const started = performance.now();
      rankDuplicateCandidates(current, candidates);
      return performance.now() - started;
    }).sort((left, right) => left - right);
    const p50 = timings[Math.ceil(timings.length * 0.50) - 1];
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
    console.info(`[duplicate-ranker-performance] candidates=${count} p50_ms=${p50.toFixed(3)} p95_ms=${p95.toFixed(3)}`);
    expect(p95).toBeLessThan(2_000);
  });
});
