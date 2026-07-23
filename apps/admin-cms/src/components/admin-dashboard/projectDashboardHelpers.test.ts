import { describe, it, expect } from 'vitest';
import { getProjectDetailHref, getValidationOutcome } from './projectDashboardHelpers';

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
});
