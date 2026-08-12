import { describe, expect, it } from 'vitest';

import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { generateSyntheticProjects } from '../fixtures/syntheticProjects';
import {
  querySyntheticProjects,
  runSyntheticProjectBenchmark,
  SYNTHETIC_BENCHMARK_OPERATION_NAMES,
} from './syntheticProjectBenchmark';

describe('synthetic project query semantics', () => {
  const projects = generateSyntheticProjects({ count: 100 });

  it('matches the repository search fields and search normalization', () => {
    expect(querySyntheticProjects(projects, { search: '  SYNTHETIC   ' }).total).toBe(100);
    expect(querySyntheticProjects(projects, { search: projects[0].publicId }).total).toBeGreaterThan(0);
    expect(querySyntheticProjects(projects, { search: 'SYNTHETIC INDUSTRY PARTNER' }).total).toBe(100);
    expect(querySyntheticProjects(projects, { search: 'SYNTHETIC TEAM' }).total).toBe(100);
  });

  it('applies exact status, year, program, and discipline filters', () => {
    const firstProject = projects[0];
    const result = querySyntheticProjects(projects, {
      status: firstProject.status,
      year: firstProject.year,
      program: firstProject.program,
      discipline: firstProject.discipline,
      pageSize: 50,
    });

    expect(result.total).toBeGreaterThan(0);
    expect(result.projects.every((project) =>
      project.status === firstProject.status
      && project.year === firstProject.year
      && project.program === firstProject.program
      && project.discipline === firstProject.discipline,
    )).toBe(true);
  });

  it('sorts by the requested field with ascending public-ID tie-breaking', () => {
    const tiedProjects = [
      { ...projects[0], title: 'Synthetic Equal Title', publicId: 'synthetic-z' },
      { ...projects[1], title: 'Synthetic Equal Title', publicId: 'synthetic-a' },
    ];
    const result = querySyntheticProjects(tiedProjects, { sort: 'title', direction: 'desc', pageSize: 10 });

    expect(result.projects.map((project) => project.publicId)).toEqual(['synthetic-a', 'synthetic-z']);
  });

  it('implements page sizes, normal pages, final-page clamping, and empty results', () => {
    const normalPage = querySyntheticProjects(projects, { sort: 'title', direction: 'asc', page: 2, pageSize: 25 });
    const clampedPage = querySyntheticProjects(projects, { sort: 'title', direction: 'asc', page: 999, pageSize: 25 });
    const emptyPage = querySyntheticProjects(projects, { search: 'does-not-exist', page: 7, pageSize: 25 });

    expect(normalPage.projects).toHaveLength(25);
    expect(normalPage.page).toBe(2);
    expect(normalPage.pageCount).toBe(4);
    expect(clampedPage.page).toBe(4);
    expect(clampedPage.projects).toHaveLength(25);
    expect(emptyPage.projects).toHaveLength(0);
    expect(emptyPage.page).toBe(7);
    expect(emptyPage.pageCount).toBe(0);
  });
});

describe('synthetic project benchmark harness', () => {
  it('compiles only published records and validates the existing feed contract', () => {
    const projects = generateSyntheticProjects({ count: 100 });
    const feed = compilePublicFeed(projects);
    const validation = validatePublicFeed(feed);

    expect(feed.every((record) => projects.find((project) => project.id === record.id)?.status === 'published')).toBe(true);
    expect(feed.length).toBe(projects.filter((project) => project.status === 'published').length);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('runs all six operations with an injected clock and no latency threshold', () => {
    const projects = generateSyntheticProjects({ count: 100 });
    let clock = 0;
    const report = runSyntheticProjectBenchmark(projects, {
      seed: 42,
      warmupIterations: 1,
      iterations: 3,
      now: () => {
        clock += 1;
        return clock;
      },
    });

    expect(report.datasetSize).toBe(100);
    expect(report.seed).toBe(42);
    expect(report.warmupIterations).toBe(1);
    expect(report.timings.map((timing) => timing.operation)).toEqual([...SYNTHETIC_BENCHMARK_OPERATION_NAMES]);
    report.timings.forEach((timing) => {
      expect(timing.iterations).toBe(3);
      expect(timing.minimumMs).toBe(1);
      expect(timing.medianMs).toBe(1);
      expect(timing.meanMs).toBe(1);
      expect(timing.p95Ms).toBe(1);
    });
  });
});
