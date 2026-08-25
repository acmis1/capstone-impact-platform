import { describe, it, expect } from 'vitest';
import {
  validateProjectForReview,
  validateProjectForApproval,
  type ApprovalMediaInput,
} from './projectValidation';
import { createMockProject } from '../test/projectFixtures';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';

describe('projectValidation', () => {
  const completePrivateMedia: ApprovalMediaInput = {
    posterImage: { rowCount: 1, validPrivateCount: 1 },
    posterPdf: { rowCount: 1, validPrivateCount: 1 },
    snapshotMedia: [],
  };

  describe('validateProjectForReview', () => {
    it('generates warnings for missing metadata and assets but remains valid', () => {
      const incompleteProject = createMockProject({
        title: '',
        poster: '',
        posterPdf: '',
        accessibilityText: '',
        snapshots: [],
      });

      const result = validateProjectForReview(incompleteProject);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(5);
    });

    it('does not mutate the project object', () => {
      const project = createMockProject();
      const originalJson = JSON.stringify(project);
      validateProjectForReview(project);
      expect(JSON.stringify(project)).toBe(originalJson);
    });
  });

  describe('validateProjectForApproval', () => {
    it('passes validation for a complete project', () => {
      const project = createMockProject();
      const result = validateProjectForApproval(project, completePrivateMedia);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('blocks approval if any required public metadata field is missing', () => {
      const fieldsToTest = [
        'title', 'summary', 'year', 'program', 'studyProgram', 'discipline', 'groupName'
      ] as const;

      fieldsToTest.forEach(field => {
        const invalidProject = createMockProject({ [field]: '' });
        const result = validateProjectForApproval(invalidProject, completePrivateMedia);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain(`Required field "${field}" is empty`);
      });
    });

    it('blocks approval if teamMembers roster is empty', () => {
      const invalidProject = createMockProject({ teamMembers: [] });
      const result = validateProjectForApproval(invalidProject, completePrivateMedia);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Roster of team members ("teamMembers") is empty');
    });

    it('blocks approval if staged poster image media is missing', () => {
      const result = validateProjectForApproval(
        createMockProject({ poster: '' }),
        { ...completePrivateMedia, posterImage: { rowCount: 0, validPrivateCount: 0 } },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('Poster image is missing from staged project media');
    });

    it('blocks approval if staged poster PDF media is missing', () => {
      const result = validateProjectForApproval(
        createMockProject({ posterPdf: '' }),
        { ...completePrivateMedia, posterPdf: { rowCount: 0, validPrivateCount: 0 } },
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('Poster PDF is missing from staged project media');
    });

    it('allows null public URLs when authoritative private poster media is valid', () => {
      const result = validateProjectForApproval(
        createMockProject({ poster: '', posterPdf: '' }),
        completePrivateMedia,
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('does not let public URL values bypass absent authoritative media', () => {
      const result = validateProjectForApproval(createMockProject(), {
        posterImage: { rowCount: 0, validPrivateCount: 0 },
        posterPdf: { rowCount: 0, validPrivateCount: 0 },
        snapshotMedia: [],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('Poster image is missing');
      expect(result.errors.join(' ')).toContain('Poster PDF is missing');
    });

    it('fails closed on duplicate or contradictory poster media rows', () => {
      const result = validateProjectForApproval(createMockProject(), {
        posterImage: { rowCount: 2, validPrivateCount: 1 },
        posterPdf: { rowCount: 1, validPrivateCount: 0 },
        snapshotMedia: [],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('Poster image in staged project media is invalid');
      expect(result.errors.join(' ')).toContain('Poster PDF in staged project media is invalid');
    });

    it('fails closed when authoritative media evidence is unavailable', () => {
      const result = validateProjectForApproval(createMockProject(), null);
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('Project media could not be verified');
    });

    it('blocks approval if accessibilityText is missing', () => {
      const project = createMockProject({ accessibilityText: '' });
      const result = validateProjectForApproval(project, completePrivateMedia);
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes('Accessibility text is missing'))).toBe(true);
      expect(result.warnings.length).toBe(0);
    });

    it('blocks approval if posterText is missing', () => {
      const project = createMockProject({ posterText: '' });
      const result = validateProjectForApproval(project, completePrivateMedia);
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes('Poster full text is missing'))).toBe(true);
      expect(result.warnings.length).toBe(0);
    });

    it('blocks approval when whitespace-only accessible content is supplied', () => {
      const result = validateProjectForApproval(
        createMockProject({ posterText: '   ', accessibilityText: '\n\t ' }),
        completePrivateMedia,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes('Poster full text is missing'))).toBe(true);
      expect(result.errors.some((error) => error.includes('Accessibility text is missing'))).toBe(true);
    });

    it('blocks approval when accessible content exceeds its safety limit', () => {
      const result = validateProjectForApproval(createMockProject({
        posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText + 1),
        accessibilityText: 'y'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1),
      }), completePrivateMedia);
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes('Poster full text exceeds the 20,000 character safety limit'))).toBe(true);
      expect(result.errors.some((error) => error.includes('Accessibility text exceeds the 2,000 character safety limit'))).toBe(true);
      // Oversized content is an error, never a warning.
      expect(result.warnings.length).toBe(0);
    });

    it('allows approval with accessible content exactly at each ceiling', () => {
      const result = validateProjectForApproval(createMockProject({
        posterText: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText),
        accessibilityText: 'y'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText),
      }), completePrivateMedia);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('does not mutate the project object', () => {
      const project = createMockProject();
      const originalJson = JSON.stringify(project);
      validateProjectForApproval(project, completePrivateMedia);
      expect(JSON.stringify(project)).toBe(originalJson);
    });

    it('enforces snapshot alt text only when a valid private snapshot row exists', () => {
      expect(validateProjectForApproval(createMockProject(), {
        ...completePrivateMedia,
        snapshotMedia: [
          {
            galleryPosition: 1,
            validPrivate: true,
            altText: 'A described snapshot.',
          },
        ],
      }).valid).toBe(true);

      const blank = validateProjectForApproval(createMockProject(), {
        ...completePrivateMedia,
        snapshotMedia: [
          {
            galleryPosition: 1,
            validPrivate: true,
            altText: '   ',
          },
        ]
      });
      expect(blank.valid).toBe(false);
      expect(blank.errors.join(' ')).toContain('Snapshot image alt text is missing');

      expect(validateProjectForApproval(createMockProject(), completePrivateMedia).valid).toBe(true);
    });
  });
});
