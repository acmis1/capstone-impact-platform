import { describe, expect, it } from 'vitest';
import { computeProjectReviewReadiness, ImportBatchReviewProjectInput } from './importBatchReviewReadiness';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';

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
  posterText: 'Full textual version of the poster content.',
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

  it('preserves the existing snapshot warning behavior', () => {
    const result = computeProjectReviewReadiness({ ...baseInput, snapshots: [] });
    expect(result.warnings).toContain('Snapshot gallery is empty.');
    expect(result.ready).toBe(true);
  });

  it('blocks submission when poster full text is missing', () => {
    const result = computeProjectReviewReadiness({ ...baseInput, posterText: null });
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toContain('Poster full text is missing.');
    expect(result.warnings).not.toContain('Poster full text is missing.');
  });

  it('blocks submission when accessibility text is missing', () => {
    const result = computeProjectReviewReadiness({ ...baseInput, accessibilityText: null });
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toContain('Accessibility text is missing.');
    expect(result.warnings).not.toContain('Accessibility text is missing.');
  });

  it('treats whitespace-only accessible content as absent', () => {
    const result = computeProjectReviewReadiness({ ...baseInput, posterText: '   ', accessibilityText: '\n\t' });
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toContain('Poster full text is missing.');
    expect(result.blockingReasons).toContain('Accessibility text is missing.');
  });

  it('is ready when both accessible content values are present', () => {
    const result = computeProjectReviewReadiness(baseInput);
    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  it('blocks submission when poster full text exceeds its safety limit', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText + 1),
    });
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toContain('Poster full text exceeds the 20,000 character safety limit.');
    // Oversized is never downgraded to an acknowledgeable warning.
    expect(result.warnings).not.toContain('Poster full text exceeds the 20,000 character safety limit.');
  });

  it('blocks submission when accessibility text exceeds its safety limit', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      accessibilityText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1),
    });
    expect(result.ready).toBe(false);
    expect(result.blockingReasons).toContain('Accessibility text exceeds the 2,000 character safety limit.');
  });

  it('accepts accessible content exactly at each ceiling', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText),
      accessibilityText: 'y'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText),
    });
    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  it('reports absence and oversize as distinct blockers rather than one generic reason', () => {
    const result = computeProjectReviewReadiness({
      ...baseInput,
      posterText: null,
      accessibilityText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1),
    });
    expect(result.blockingReasons).toContain('Poster full text is missing.');
    expect(result.blockingReasons).toContain('Accessibility text exceeds the 2,000 character safety limit.');
  });
});
