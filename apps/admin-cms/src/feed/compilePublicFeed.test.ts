import { describe, it, expect } from 'vitest';
import { compilePublicFeed } from './compilePublicFeed';
import { createMockProject } from '../test/projectFixtures';
import { Project } from '../domain/project';

describe('compilePublicFeed', () => {
  it('includes approved and published records, and excludes other statuses', () => {
    const projects: Project[] = [
      createMockProject({ id: 1, status: 'draft' }),
      createMockProject({ id: 2, status: 'submitted' }),
      createMockProject({ id: 3, status: 'in_review' }),
      createMockProject({ id: 4, status: 'changes_requested' }),
      createMockProject({ id: 5, status: 'approved' }),
      createMockProject({ id: 6, status: 'published' }),
      createMockProject({ id: 7, status: 'archived' }),
      createMockProject({ id: 8, status: 'deleted' }),
    ];

    const result = compilePublicFeed(projects);
    expect(result.map(r => r.id)).toEqual([5, 6]);
  });

  it('removes all known internal fields', () => {
    const project = createMockProject({ status: 'approved' });
    const result = compilePublicFeed([project]);
    const record = result[0] as unknown as Record<string, unknown>;

    const forbiddenFields = [
      'status',
      'importBatchId',
      'sourceFolder',
      'internalStaffNotes',
      'privateReviewComments',
      'validationFlags',
      'validationErrors',
      'validationWarnings',
      'pendingRemovalFromPublic',
      'publicRemovalCompletedAt',
      'archivedAt',
      'archivedFromStatus',
      'archiveReason',
      'created_at',
      'updated_at',
    ];

    forbiddenFields.forEach(field => {
      expect(record[field]).toBeUndefined();
    });
  });

  it('preserves required public fields', () => {
    const project = createMockProject({
      id: 99,
      status: 'approved',
      title: 'Test Title',
      year: '2026',
    });
    const result = compilePublicFeed([project]);
    expect(result[0].id).toBe(99);
    expect(result[0].title).toBe('Test Title');
    expect(result[0].year).toBe('2026');
  });

  it('omits empty optional fields and includes non-empty optional fields', () => {
    const projectWithOptionals = createMockProject({
      status: 'approved',
      videoUrl: 'https://youtube.com/v',
      demoUrl: 'https://demo.com',
      repositoryUrl: 'https://github.com',
      externalLinks: [{ label: 'L', url: 'https://l' }],
      citations: ['Citation 1'],
    });

    const projectWithoutOptionals = createMockProject({
      status: 'approved',
      videoUrl: '',
      demoUrl: '',
      repositoryUrl: '',
      externalLinks: [],
      citations: [],
    });

    const results = compilePublicFeed([projectWithOptionals, projectWithoutOptionals]);

    expect(results[0].videoUrl).toBe('https://youtube.com/v');
    expect(results[0].demoUrl).toBe('https://demo.com');
    expect(results[0].repositoryUrl).toBe('https://github.com');
    expect(results[0].externalLinks).toEqual([{ label: 'L', url: 'https://l' }]);
    expect(results[0].citations).toEqual(['Citation 1']);

    expect(results[1].videoUrl).toBeUndefined();
    expect(results[1].demoUrl).toBeUndefined();
    expect(results[1].repositoryUrl).toBeUndefined();
    expect(results[1].externalLinks).toBeUndefined();
    expect(results[1].citations).toBeUndefined();
  });

  it('applies expected layout defaults', () => {
    const project = createMockProject({
      status: 'approved',
    });
    delete (project as unknown as Record<string, unknown>).layoutConfig;

    const result = compilePublicFeed([project]);
    expect(result[0].layoutConfig.templateId).toBe('poster_showcase');
    expect(result[0].layoutConfig.featuredMedia).toBe('poster');
    expect(result[0].layoutConfig.sectionOrder).toEqual(['background', 'solution', 'snapshots', 'video', 'links']);
  });

  it('does not mutate the input projects', () => {
    const project = createMockProject({ status: 'approved' });
    const originalJson = JSON.stringify(project);
    compilePublicFeed([project]);
    expect(JSON.stringify(project)).toBe(originalJson);
  });

  it('returns deterministic results for the same input', () => {
    const project1 = createMockProject({ status: 'approved' });
    const project2 = createMockProject({ status: 'approved' });
    const result1 = compilePublicFeed([project1, project2]);
    const result2 = compilePublicFeed([project1, project2]);
    expect(result1).toEqual(result2);
  });
});
