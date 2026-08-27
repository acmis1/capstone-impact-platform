import { describe, it, expect } from 'vitest';
import {
  normalizeSpreadsheetHeader,
  matchSpreadsheetHeaders,
  deriveDefaultReferenceMappings,
  referenceMappingSetsEqual,
  CANONICAL_FIELD_ALIASES,
} from '../adminReferenceAutoMatcher';
import { COLUMN_DEFINITIONS } from '../projectDetailsWorkbookContract';

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
      const headers = ['GroupName', 'Official Title', 'Degree Program', 'Academic Year', 'Team Roster'];
      const result = matchSpreadsheetHeaders(headers);

      expect(result.matched.groupName).toBe('GroupName');
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
      const headers = ['Record Number', 'Campus', 'Submission Date'];
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

  describe('alias dictionary evidence', () => {
    // Canonical fields whose aliases are published in the staff workbook column contract. The
    // workbook contract maps its single "Study program" column onto both internal program fields.
    const CONTRACT_INTERNAL_FIELD: Record<string, string> = {
      title: 'title',
      groupName: 'groupName',
      year: 'year',
      program: 'program',
      studyProgram: 'program',
      academicSupervisor: 'academicSupervisor',
      industryPartner: 'industryPartner',
      participantContactEmail: 'participantContactEmail',
      teamMembers: 'teamMembers',
    };

    // Header spellings that are not in the workbook contract but do appear verbatim in committed
    // School reference workbook fixtures, with the fixture that establishes each one.
    const FIXTURE_EVIDENCE: Record<string, string[]> = {
      // fixtures/syntheticImportPackages.ts reference workbook header, plus this application's
      // own staff-facing "Project ID" label for the same field.
      publicId: ['project id', 'public id', 'public_id'],
      // browserImportPreview.test.ts and adminReferenceClientBoundary.test.ts.
      title: ['official project title', 'official title'],
      // browserImportMetadataStage.test.ts.
      year: ['academic year'],
      // browserImportPreview.test.ts.
      program: ['degree program'],
      studyProgram: ['degree program'],
      // adminReferenceReconciliation.test.ts.
      teamMembers: ['team roster'],
    };

    it('includes every alias the staff workbook column contract already publishes', () => {
      for (const [canonicalField, internalField] of Object.entries(CONTRACT_INTERNAL_FIELD)) {
        const definition = COLUMN_DEFINITIONS.find((column) => column.internalField === internalField);
        expect(definition).toBeDefined();
        for (const alias of definition!.aliases) {
          expect(CANONICAL_FIELD_ALIASES[canonicalField]).toContain(alias);
        }
      }
    });

    it('carries no alias beyond the workbook contract and committed fixture headers', () => {
      for (const [canonicalField, aliases] of Object.entries(CANONICAL_FIELD_ALIASES)) {
        const internalField = CONTRACT_INTERNAL_FIELD[canonicalField];
        const contractAliases =
          COLUMN_DEFINITIONS.find((column) => column.internalField === internalField)?.aliases ?? [];
        const fixtureAliases = FIXTURE_EVIDENCE[canonicalField] ?? [];
        for (const alias of aliases) {
          expect({
            canonicalField,
            alias,
            supported: contractAliases.includes(alias) || fixtureAliases.includes(alias),
          }).toEqual({ canonicalField, alias, supported: true });
        }
      }
    });

    it('rejects invented synonyms that no contract or fixture supports', () => {
      const unsupportedHeaders = [
        'Team/Group Name',
        'Team Name',
        'Group',
        'Study Programme',
        'Programme',
        'Partner',
      ];
      const result = matchSpreadsheetHeaders(unsupportedHeaders);

      expect(result.matched).toEqual({});
      expect(result.ambiguous).toEqual({});
      expect(result.unmatched).toContain('groupName');
      expect(result.unmatched).toContain('program');
      expect(result.unmatched).toContain('industryPartner');
    });

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

  describe('referenceMappingSetsEqual', () => {
    const automatic = {
      matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
      comparisonMappings: [
        { canonicalField: 'title', referenceColumn: 'Project Title' },
        { canonicalField: 'program', referenceColumn: 'Program' },
      ],
    };

    it('treats a structurally identical configuration as equal', () => {
      expect(
        referenceMappingSetsEqual(automatic, {
          matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
          comparisonMappings: [
            { canonicalField: 'title', referenceColumn: 'Project Title' },
            { canonicalField: 'program', referenceColumn: 'Program' },
          ],
        }),
      ).toBe(true);
    });

    it('detects a changed spreadsheet column', () => {
      expect(
        referenceMappingSetsEqual(automatic, {
          ...automatic,
          matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Academic Year' }],
        }),
      ).toBe(false);
    });

    it('detects a changed project field', () => {
      expect(
        referenceMappingSetsEqual(automatic, {
          ...automatic,
          matchMappings: [{ canonicalField: 'year', referenceColumn: 'Group Name' }],
        }),
      ).toBe(false);
    });

    it('detects an added or removed mapping row', () => {
      expect(
        referenceMappingSetsEqual(automatic, {
          ...automatic,
          comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Project Title' }],
        }),
      ).toBe(false);
    });
  });
});
