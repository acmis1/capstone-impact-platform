import { describe, it, expect } from 'vitest';
import { validateProjectForReview, validateProjectForApproval } from './projectValidation';
import { createMockProject } from '../test/projectFixtures';

describe('projectValidation', () => {
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
      const result = validateProjectForApproval(project);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('blocks approval if any required public metadata field is missing', () => {
      const fieldsToTest = [
        'title', 'summary', 'year', 'program', 'studyProgram', 'discipline', 'groupName'
      ] as const;

      fieldsToTest.forEach(field => {
        const invalidProject = createMockProject({ [field]: '' });
        const result = validateProjectForApproval(invalidProject);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain(`Required field "${field}" is empty`);
      });
    });

    it('blocks approval if teamMembers roster is empty', () => {
      const invalidProject = createMockProject({ teamMembers: [] });
      const result = validateProjectForApproval(invalidProject);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Roster of team members ("teamMembers") is empty');
    });

    it('blocks approval if poster image URL is missing', () => {
      const invalidProject = createMockProject({ poster: '' });
      const result = validateProjectForApproval(invalidProject);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Missing public poster preview image URL');
    });

    it('blocks approval if poster PDF URL is missing', () => {
      const invalidProject = createMockProject({ posterPdf: '' });
      const result = validateProjectForApproval(invalidProject);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Missing public poster PDF URL');
    });

    it('produces a warning (not error) if accessibilityText is missing', () => {
      const project = createMockProject({ accessibilityText: '' });
      const result = validateProjectForApproval(project);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('Accessibility text is missing');
    });

    it('does not mutate the project object', () => {
      const project = createMockProject();
      const originalJson = JSON.stringify(project);
      validateProjectForApproval(project);
      expect(JSON.stringify(project)).toBe(originalJson);
    });
  });
});
