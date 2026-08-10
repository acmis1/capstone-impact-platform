import { describe, expect, it } from 'vitest';
import { computeProjectReviewReadiness, ImportBatchReviewProjectInput } from './importBatchReviewReadiness';

const baseInput: ImportBatchReviewProjectInput = {
  publicId: 'synthetic-1',
  title: 'Title',
  summary: 'Summary',
  programId: 'a0000000-0000-4000-8000-000000000001',
  programName: 'Program',
  studyProgram: 'Study Program',
  discipline: 'Discipline',
  groupName: 'Group',
  teamMembers: ['Member A'],
  accessibilityText: 'Accessible description',
  snapshots: ['snap.png'],
  validationErrors: [],
  validationWarnings: [],
  validationFlags: [],
  status: 'draft',
  disciplineMappingCount: 1,
  industryMappingCount: 1,
  mediaAssets: [
    { assetType: 'poster_image', isPublicApproved: false, publicUrl: null },
    { assetType: 'poster_pdf', isPublicApproved: false, publicUrl: null },
  ],
};

describe('computeProjectReviewReadiness — validation_flags', () => {
  it('is ready with no validation flags', () => {
    const result = computeProjectReviewReadiness(baseInput);
    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
  });

  it('blocks on an unresolved error-severity flag', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      validationFlags: [{ severity: 'error', resolved: false, message: 'Missing required field X' }],
    });
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toContain('Unresolved validation error: Missing required field X');
  });

  it('does not block on a resolved error-severity flag', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      validationFlags: [{ severity: 'error', resolved: true, message: 'Previously blocking, now resolved' }],
    });
    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
    expect(result.warnings).not.toContain('Previously blocking, now resolved');
  });

  it('surfaces unresolved warning/info flags as non-blocking warnings', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      validationFlags: [
        { severity: 'warning', resolved: false, message: 'Consider double-checking the poster crop' },
        { severity: 'info', resolved: false, message: 'FYI: source folder had a nested duplicate' },
      ],
    });
    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toHaveLength(0);
    expect(result.warnings).toContain('Consider double-checking the poster crop');
    expect(result.warnings).toContain('FYI: source folder had a nested duplicate');
  });

  it('does not surface resolved warning/info flags', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      validationFlags: [{ severity: 'warning', resolved: true, message: 'Already addressed' }],
    });
    expect(result.warnings).not.toContain('Already addressed');
  });

  it('keeps existing projects.validation_warnings visible alongside flag-derived warnings', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      validationWarnings: ['Legacy ingestion warning'],
      validationFlags: [{ severity: 'warning', resolved: false, message: 'New flag warning' }],
    });
    expect(result.warnings).toContain('Legacy ingestion warning');
    expect(result.warnings).toContain('New flag warning');
  });

  it('preserves existing accessibility/snapshot warning behavior', () => {
    const result = computeProjectReviewReadiness({ ...baseInput, accessibilityText: '', snapshots: [] });
    expect(result.warnings).toContain('Accessibility text is missing.');
    expect(result.warnings).toContain('Snapshot gallery is empty.');
  });
});
