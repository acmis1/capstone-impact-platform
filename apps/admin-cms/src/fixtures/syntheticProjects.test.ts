import { describe, expect, it } from 'vitest';

import { WORKFLOW_STATUSES } from '../domain/workflowStatus';
import {
  createInvalidSyntheticProjectFixtures,
  createValidationFlags,
  findDuplicatePublicIds,
  generateSyntheticProjects,
  SYNTHETIC_PROJECT_COUNTS,
  SYNTHETIC_WORKFLOW_STATUSES,
  validateInvalidSyntheticFixture,
} from './syntheticProjects';
import { isSafeExternalPreviewUrl } from '../previews/participantPreviewHtml';
import { PROJECT_METADATA_LIMITS, projectMetadataInputSchema } from '../projects/projectMetadata';
import { validateMediaAsset } from '../storage/mediaValidation';
import { validateProjectForApproval } from '../validation/projectValidation';
import { validateFolderDerivedPublicId } from '../import/publicIdValidation';

describe('synthetic project generator', () => {
  it('is structurally deterministic for the same seed and count', () => {
    const first = generateSyntheticProjects({ count: 100, seed: 1234 });
    const second = generateSyntheticProjects({ count: 100, seed: 1234 });
    const differentSeed = generateSyntheticProjects({ count: 100, seed: 5678 });

    expect(first).toEqual(second);
    expect(differentSeed).not.toEqual(first);
  });

  it.each(SYNTHETIC_PROJECT_COUNTS)('generates exactly %i projects', (count) => {
    expect(generateSyntheticProjects({ count })).toHaveLength(count);
  });

  it.each(SYNTHETIC_PROJECT_COUNTS)('covers required dimensions for %i projects', (count) => {
    const projects = generateSyntheticProjects({ count });
    const unique = (values: string[]) => new Set(values);

    expect(unique(projects.map((project) => project.year))).toEqual(
      new Set(['2022', '2023', '2024', '2025', '2026']),
    );
    expect(unique(projects.map((project) => project.program).filter(Boolean))).toEqual(
      new Set(['Synthetic Software Systems', 'Synthetic Engineering Design', 'Synthetic Data Practice', 'Synthetic Digital Experience']),
    );
    expect(unique(projects.map((project) => project.discipline).filter(Boolean))).toEqual(
      new Set([
        'Synthetic Software Engineering',
        'Synthetic Mechanical Design',
        'Synthetic Data Systems',
        'Synthetic Digital Media',
        'Synthetic Network Practice',
      ]),
    );
    expect(unique(projects.map((project) => project.industry).filter(Boolean))).toEqual(
      new Set([
        'Synthetic Technology',
        'Synthetic Health Systems',
        'Synthetic Agriculture',
        'Synthetic Climate Services',
        'Synthetic Civic Infrastructure',
      ]),
    );
    expect(unique(projects.map((project) => project.status))).toEqual(new Set(SYNTHETIC_WORKFLOW_STATUSES));
    expect(unique(projects.map((project) => String(project.teamMembers.length)))).toEqual(new Set(['1', '2', '3', '4', '5']));
  });

  it('creates unique, predictable, valid public IDs', () => {
    const projects = generateSyntheticProjects({ count: 1000 });
    const publicIds = projects.map((project) => project.publicId ?? '');

    expect(new Set(publicIds).size).toBe(projects.length);
    projects.forEach((project, index) => {
      expect(project.publicId).toBe(`synthetic-${project.year}-${String(index + 1).padStart(4, '0')}`);
      expect(validateFolderDerivedPublicId(project.publicId ?? '').valid).toBe(true);
    });
  });

  it('covers optional media and validation flag profiles without PII', () => {
    const projects = generateSyntheticProjects({ count: 100 });
    const hasOptionalMedia = projects.some((project) =>
      project.snapshots.length > 0
      || Boolean(project.videoUrl)
      || Boolean(project.demoUrl)
      || Boolean(project.repositoryUrl)
      || project.externalLinks.length > 0,
    );
    const hasNoOptionalMedia = projects.some((project) =>
      project.snapshots.length === 0
      && !project.videoUrl
      && !project.demoUrl
      && !project.repositoryUrl
      && project.externalLinks.length === 0,
    );
    const flagProfiles = new Set(projects.map((project) => JSON.stringify(project.validationFlags)));
    const serialized = JSON.stringify(projects);
    const urls = serialized.match(/https?:\/\/[^"\\]+/g) ?? [];

    expect(hasOptionalMedia).toBe(true);
    expect(hasNoOptionalMedia).toBe(true);
    expect(flagProfiles.size).toBe(4);
    expect(projects.some((project) => project.validationFlags?.hasErrors)).toBe(true);
    expect(projects.some((project) => project.validationFlags?.hasWarnings)).toBe(true);
    expect(serialized).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => new URL(url).hostname.endsWith('.synthetic.invalid'))).toBe(true);
  });
});

describe('invalid synthetic project fixtures', () => {
  it('generates and rejects all eight invalid fixture variants at their intended boundaries', () => {
    const fixtures = createInvalidSyntheticProjectFixtures();
    const kinds = fixtures.map((fixture) => fixture.kind);

    expect(new Set(kinds)).toEqual(new Set([
      'missing-title',
      'missing-year',
      'invalid-status',
      'duplicate-public-id',
      'invalid-url',
      'oversized-text',
      'unsupported-media-type',
      'missing-required-category',
    ]));
    expect(fixtures).toHaveLength(8);
    fixtures.forEach((fixture) => expect(validateInvalidSyntheticFixture(fixture)).toBe(true));
  });

  it('contains the specific invalid condition for every fixture', () => {
    const fixtures = Object.fromEntries(
      createInvalidSyntheticProjectFixtures().map((fixture) => [fixture.kind, fixture]),
    );

    expect((fixtures['missing-title'].payload as { title: string }).title).toBe('');
    expect(validateProjectForApproval(fixtures['missing-title'].payload as never).errors.join(' ')).toContain('title');
    expect((fixtures['missing-year'].payload as { year: string }).year).toBe('');
    expect(validateProjectForApproval(fixtures['missing-year'].payload as never).errors.join(' ')).toContain('year');

    const invalidStatus = (fixtures['invalid-status'].payload as { status: string }).status;
    expect(WORKFLOW_STATUSES).not.toContain(invalidStatus);

    const duplicateProjects = fixtures['duplicate-public-id'].payload as { publicId?: string }[];
    expect(findDuplicatePublicIds(duplicateProjects)).toHaveLength(1);

    const invalidUrl = (fixtures['invalid-url'].payload as { externalLinks: { url: string }[] }).externalLinks[0].url;
    expect(isSafeExternalPreviewUrl(invalidUrl)).toBe(false);

    const oversizedInput = fixtures['oversized-text'].payload as { summary: string };
    expect(oversizedInput.summary).toHaveLength(PROJECT_METADATA_LIMITS.summary + 1);
    expect(projectMetadataInputSchema.safeParse(oversizedInput).success).toBe(false);

    const unsupportedMedia = fixtures['unsupported-media-type'].payload as {
      fileName: string;
      fileSizeBytes: number;
      mimeType: string;
    };
    expect(validateMediaAsset(unsupportedMedia).valid).toBe(false);

    const missingCategory = fixtures['missing-required-category'].payload as { industryCategoryIds: string[] };
    expect(missingCategory.industryCategoryIds).toHaveLength(0);
    expect(projectMetadataInputSchema.safeParse(missingCategory).success).toBe(false);
  });

  it('produces the expected validation flag profiles without changing production validators', () => {
    expect(createValidationFlags(0)).toEqual(expect.objectContaining({ hasErrors: false, hasWarnings: false }));
    expect(createValidationFlags(1)).toEqual(expect.objectContaining({ hasErrors: false, hasWarnings: true }));
    expect(createValidationFlags(2)).toEqual(expect.objectContaining({ hasErrors: true, hasWarnings: true }));
    expect(createValidationFlags(3)).toEqual(expect.objectContaining({ hasModel3d: true, hasAudio: true }));
  });
});
