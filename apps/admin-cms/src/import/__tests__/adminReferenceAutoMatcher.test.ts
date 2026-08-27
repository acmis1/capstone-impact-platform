import { describe, it, expect } from 'vitest';
import {
  normalizeSpreadsheetHeader,
  matchSpreadsheetHeaders,
  deriveDefaultReferenceMappings,
  CANONICAL_FIELD_ALIASES,
} from '../adminReferenceAutoMatcher';

describe('adminReferenceAutoMatcher', () => {
  describe('normalizeSpreadsheetHeader', () => {
    it('trims leading/trailing whitespace and converts to lowercase', () => {
      expect(normalizeSpreadsheetHeader('  Group Name  ')).toBe('group name');
    });

    it('normalizes hyphens, underscores, and consecutive whitespace', () => {
      expect(normalizeSpreadsheetHeader('GROUP_NAME')).toBe('group name');
      expect(normalizeSpreadsheetHeader(' project -  title ')).toBe('project title');
      expect(normalizeSpreadsheetHeader('Public_ID')).toBe('public id');
      expect(normalizeSpreadsheetHeader('participant-contact-email')).toBe('participant contact email');
    });
  });

  describe('matchSpreadsheetHeaders with required fixtures', () => {
    // Fixture A: Exact expected headers
    it('Fixture A: matches exact expected headers unambiguously', () => {
      const headers = ['Group Name', 'Project Title', 'Program'];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.groupName).toBe('Group Name');
      expect(result.matched.title).toBe('Project Title');
      expect(result.matched.program).toBe('Program');
      expect(result.ambiguous).toEqual({});
    });

    // Fixture B: Case/spacing/separator variants
    it('Fixture B: matches case, spacing, and separator variants', () => {
      const headers = ['GROUP_NAME', ' project   title ', 'PROGRAM'];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.groupName).toBe('GROUP_NAME');
      expect(result.matched.title).toBe(' project   title ');
      expect(result.matched.program).toBe('PROGRAM');
      expect(result.ambiguous).toEqual({});
    });

    // Fixture C: Supported aliases justified by repository contracts
    it('Fixture C: matches legitimate synonyms justified by repository contracts', () => {
      const headers = ['Team Name', 'Official Title', 'Degree Program', 'Academic Year', 'Team Roster'];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.groupName).toBe('Team Name');
      expect(result.matched.title).toBe('Official Title');
      expect(result.matched.program).toBe('Degree Program');
      expect(result.matched.year).toBe('Academic Year');
      expect(result.matched.teamMembers).toBe('Team Roster');
      expect(result.ambiguous).toEqual({});
    });

    // Fixture D: Ambiguous duplicate headers
    it('Fixture D: marks field ambiguous when multiple headers normalize to the same canonical field', () => {
      const headers = ['Group Name', 'Project Title', 'Title', 'Program'];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.groupName).toBe('Group Name');
      expect(result.matched.program).toBe('Program');
      // Both "Project Title" and "Title" alias to title -> MUST NOT guess!
      expect(result.matched.title).toBeUndefined();
      expect(result.ambiguous.title).toEqual(['Project Title', 'Title']);
    });

    // Fixture E: Missing header
    it('Fixture E: leaves missing headers unresolved in unmatched list', () => {
      const headers = ['Group Name', 'Project Title'];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.groupName).toBe('Group Name');
      expect(result.matched.title).toBe('Project Title');
      expect(result.matched.program).toBeUndefined();
      expect(result.unmatched).toContain('program');
    });

    // Fixture F: Unrelated columns (CRITICAL: prove old first/second/third fallback is gone)
    it('Fixture F: does not map unrelated columns merely by position', () => {
      const headers = ['Student Number', 'Campus', 'Submission Date'];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.groupName).toBeUndefined();
      expect(result.matched.title).toBeUndefined();
      expect(result.matched.program).toBeUndefined();
      expect(Object.keys(result.matched)).toHaveLength(0);
      expect(result.unmatched).toContain('groupName');
      expect(result.unmatched).toContain('title');
      expect(result.unmatched).toContain('program');
    });

    it('matches long column headers correctly without breaking', () => {
      const headers = [
        'Participant Contact Email Address for Showcase Confirmation',
        'Participant Contact Email',
        'Academic Supervisor',
      ];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.participantContactEmail).toBe('Participant Contact Email');
      expect(result.matched.academicSupervisor).toBe('Academic Supervisor');
    });
  });

  describe('deriveDefaultReferenceMappings', () => {
    it('derives default mappings when all required fields are confident matches', () => {
      const headers = ['Group Name', 'Project Title', 'Program', 'Academic Year'];
      const derivation = deriveDefaultReferenceMappings(headers);

      expect(derivation.isAllRequiredMatched).toBe(true);
      expect(derivation.matchMappings).toEqual([
        { canonicalField: 'groupName', referenceColumn: 'Group Name' },
      ]);
      expect(derivation.comparisonMappings).toEqual([
        { canonicalField: 'title', referenceColumn: 'Project Title' },
        { canonicalField: 'program', referenceColumn: 'Program' },
      ]);
    });

    it('leaves missing fields as empty string when not all required fields match', () => {
      const headers = ['Group Name', 'Academic Year'];
      const derivation = deriveDefaultReferenceMappings(headers);

      expect(derivation.isAllRequiredMatched).toBe(false);
      expect(derivation.matchMappings).toEqual([
        { canonicalField: 'groupName', referenceColumn: 'Group Name' },
      ]);
      expect(derivation.comparisonMappings).toEqual([
        { canonicalField: 'title', referenceColumn: '' },
        { canonicalField: 'program', referenceColumn: '' },
      ]);
    });

    it('does not assign positional fallbacks on completely unrelated headers', () => {
      const headers = ['Column1', 'Column2', 'Column3'];
      const derivation = deriveDefaultReferenceMappings(headers);

      expect(derivation.isAllRequiredMatched).toBe(false);
      expect(derivation.matchMappings).toEqual([
        { canonicalField: 'groupName', referenceColumn: '' },
      ]);
      expect(derivation.comparisonMappings).toEqual([
        { canonicalField: 'title', referenceColumn: '' },
        { canonicalField: 'program', referenceColumn: '' },
      ]);
    });
  });

  describe('alias dictionary documentation and sanity check', () => {
    it('contains all canonical matchable and comparable fields', () => {
      const expectedFields = [
        'publicId',
        'title',
        'groupName',
        'year',
        'program',
        'studyProgram',
        'academicSupervisor',
        'industryPartner',
        'participantContactEmail',
        'teamMembers',
      ];
      for (const field of expectedFields) {
        expect(CANONICAL_FIELD_ALIASES[field]).toBeDefined();
        expect(CANONICAL_FIELD_ALIASES[field].length).toBeGreaterThan(0);
      }
    });
  });
});
