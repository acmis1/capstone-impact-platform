import { describe, it, expect } from 'vitest';
import { getProjectDetailHref, getValidationOutcome, getProjectColumnSortField, toProjectIndexRow } from './projectDashboardHelpers';
import { Project } from '../../domain/project';

describe('projectDashboardHelpers', () => {
  describe('getProjectDetailHref', () => {
    it('returns null for undefined, null, or empty string public IDs', () => {
      expect(getProjectDetailHref(undefined)).toBeNull();
      expect(getProjectDetailHref(null)).toBeNull();
      expect(getProjectDetailHref('')).toBeNull();
      expect(getProjectDetailHref('   ')).toBeNull();
    });

    it('returns URI-encoded project detail URL for valid public ID', () => {
      expect(getProjectDetailHref('2026-software-proj')).toBe('/admin/projects/2026-software-proj');
      expect(getProjectDetailHref('2026/proj #1')).toBe('/admin/projects/2026%2Fproj%20%231');
    });
  });

  describe('getValidationOutcome', () => {
    it('returns Ready for clean records with no errors or warnings', () => {
      const outcome = getValidationOutcome({});
      expect(outcome).toEqual({ label: 'Ready', variant: 'success' });
    });

    it('returns Needs attention or error count when blocking errors exist', () => {
      const flagsOnly = getValidationOutcome({ validationFlags: { hasErrors: true, hasWarnings: false } });
      expect(flagsOnly).toEqual({ label: 'Needs attention', variant: 'destructive' });

      const explicitErrors = getValidationOutcome({ validationErrors: ['Title missing', 'Year invalid'] });
      expect(explicitErrors).toEqual({ label: '2 Errors', variant: 'destructive' });
    });

    it('returns Warnings when warnings exist without blocking errors', () => {
      const flagsOnly = getValidationOutcome({ validationFlags: { hasErrors: false, hasWarnings: true } });
      expect(flagsOnly).toEqual({ label: 'Warnings', variant: 'warning' });

      const explicitWarnings = getValidationOutcome({ validationWarnings: ['Missing poster PDF'] });
      expect(explicitWarnings).toEqual({ label: '1 Warning', variant: 'warning' });
    });

    it('gives blocking errors precedence over warnings', () => {
      const mixed = getValidationOutcome({
        validationErrors: ['Error 1'],
        validationWarnings: ['Warning 1', 'Warning 2'],
      });
      expect(mixed).toEqual({ label: '1 Error', variant: 'destructive' });
    });
  });

  describe('getProjectColumnSortField', () => {
    it('maps title column to "title"', () => {
      expect(getProjectColumnSortField('title')).toBe('title');
    });

    it('maps status column to "status"', () => {
      expect(getProjectColumnSortField('status')).toBe('status');
    });

    it('maps year column to "year"', () => {
      expect(getProjectColumnSortField('year')).toBe('year');
    });

    it('maps updatedAt column to "updated_at"', () => {
      expect(getProjectColumnSortField('updatedAt')).toBe('updated_at');
    });

    it('returns null for non-sortable column IDs', () => {
      expect(getProjectColumnSortField('program')).toBeNull();
      expect(getProjectColumnSortField('validation')).toBeNull();
      expect(getProjectColumnSortField('actions')).toBeNull();
    });

    it('returns null for unknown or empty column IDs', () => {
      expect(getProjectColumnSortField('')).toBeNull();
      expect(getProjectColumnSortField('unknown_column')).toBeNull();
    });
  });

  describe('toProjectIndexRow client privacy DTO mapper', () => {
    it('maps allowed fields and excludes all internal CMS/sentinel fields', () => {
      const fullProject: Project = {
        id: 999,
        publicId: '2026-secret-proj',
        title: 'Secret Capstone Project',
        summary: 'SECRET_SUMMARY_TEXT',
        background: 'SECRET_BACKGROUND',
        solution: 'SECRET_SOLUTION',
        year: '2026',
        program: 'Software Engineering',
        studyProgram: 'BSE',
        discipline: 'AI',
        disciplines: ['AI'],
        industry: 'Tech',
        industryPartner: 'Acme Corp',
        academicSupervisor: 'Dr Smith',
        groupName: 'Group Alpha',
        teamMembers: ['Alice', 'Bob'],
        poster: 'https://secret.com/poster.jpg',
        posterPdf: 'https://secret.com/poster.pdf',
        posterText: 'Secret poster text',
        accessibilityText: 'Secret accessibility text',
        snapshots: ['https://secret.com/snap1.jpg'],
        videoUrl: 'https://youtube.com/watch?v=secret',
        demoUrl: 'https://demo.com',
        repositoryUrl: 'https://github.com/secret',
        externalLinks: [],
        citations: [],
        layoutConfig: { templateId: 'poster_showcase', featuredMedia: 'poster', sectionOrder: [] },
        status: 'in_review',
        importBatchId: 'BATCH_123',
        sourceFolder: '/private/uploads/',
        internalStaffNotes: 'CONFIDENTIAL_STAFF_NOTE',
        privateReviewComments: 'CONFIDENTIAL_REVIEW_COMMENT',
        validationFlags: { hasErrors: true, hasWarnings: true },
        validationErrors: ['Secret error string'],
        validationWarnings: ['Secret warning string'],
        archiveReason: 'CONFIDENTIAL_ARCHIVE_REASON',
        pendingRemovalFromPublic: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      };

      const dto = toProjectIndexRow(fullProject);

      // Verify allowed DTO properties exist
      expect(dto).toEqual({
        id: '999',
        publicId: '2026-secret-proj',
        title: 'Secret Capstone Project',
        status: 'in_review',
        program: 'Software Engineering',
        discipline: 'AI',
        year: '2026',
        groupName: 'Group Alpha',
        industryPartner: 'Acme Corp',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        validationLabel: '1 Error',
        validationVariant: 'destructive',
      });

      // Verify internal sentinel keys and values do not exist in mapped object
      const keys = Object.keys(dto);
      expect(keys).not.toContain('summary');
      expect(keys).not.toContain('poster');
      expect(keys).not.toContain('posterPdf');
      expect(keys).not.toContain('snapshots');
      expect(keys).not.toContain('validationErrors');
      expect(keys).not.toContain('validationWarnings');
      expect(keys).not.toContain('validationFlags');
      expect(keys).not.toContain('internalStaffNotes');
      expect(keys).not.toContain('privateReviewComments');
      expect(keys).not.toContain('importBatchId');
      expect(keys).not.toContain('sourceFolder');
      expect(keys).not.toContain('teamMembers');
      expect(keys).not.toContain('archiveReason');
      expect(keys).not.toContain('pendingRemovalFromPublic');

      const valuesStr = JSON.stringify(dto);
      expect(valuesStr).not.toContain('CONFIDENTIAL_STAFF_NOTE');
      expect(valuesStr).not.toContain('CONFIDENTIAL_REVIEW_COMMENT');
      expect(valuesStr).not.toContain('CONFIDENTIAL_ARCHIVE_REASON');
      expect(valuesStr).not.toContain('SECRET_SUMMARY_TEXT');
    });
  });
});
