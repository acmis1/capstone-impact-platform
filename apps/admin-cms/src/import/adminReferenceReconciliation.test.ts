import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  inspectAdminReferenceWorkbook,
  validateAdminReferenceMapping,
  reconcilePackagesAgainstAdminReference,
  canonicalizeAdminReferenceMapping,
  computeAdminReferenceWorkbookFingerprint,
  type AdminReferenceMappingConfig,
} from './adminReferenceReconciliation';

async function createSyntheticWorkbookBuffer(
  sheetsData: Record<string, { headers: string[]; rows: Array<Record<string, unknown>> }>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [sheetName, data] of Object.entries(sheetsData)) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(data.headers);
    for (const rowObj of data.rows) {
      const rowValues = data.headers.map((h) => rowObj[h] ?? '');
      sheet.addRow(rowValues);
    }
  }
  const arrayBuf = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuf);
}

describe('adminReferenceReconciliation unit test suite', () => {
  describe('inspection and fingerprints', () => {
    it('inspects a valid multi-sheet workbook and extracts sheet names and headers without raw cell data', async () => {
      const buf = await createSyntheticWorkbookBuffer({
        ROSTER_2026: {
          headers: ['Group Name', 'Project Title', 'Degree Program', 'Academic Year'],
          rows: [{ 'Group Name': 'Alpha', 'Project Title': 'Smart Grid', 'Degree Program': 'CS', 'Academic Year': 2026 }],
        },
        REVIEWERS: {
          headers: ['Staff Name', 'Email'],
          rows: [{ 'Staff Name': 'Dr. Smith', Email: 'smith@capstone.invalid' }],
        },
      });

      const res = await inspectAdminReferenceWorkbook(buf);
      expect(res.success).toBe(true);
      expect(res.referenceWorkbookFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(res.fileSizeBytes).toBeGreaterThan(0);
      expect(res.worksheets).toHaveLength(2);
      expect(res.worksheets[0].name).toBe('ROSTER_2026');
      expect(res.worksheets[0].headers).toEqual(['Group Name', 'Project Title', 'Degree Program', 'Academic Year']);
      expect(res.worksheets[1].name).toBe('REVIEWERS');
      // Proof: raw cell contents (like 'Dr. Smith') are not in structure summary
      expect(JSON.stringify(res.worksheets)).not.toContain('Dr. Smith');
      expect(JSON.stringify(res.worksheets)).not.toContain('Smart Grid');
    });

    it('produces a deterministic SHA-256 fingerprint from uploaded bytes', async () => {
      const buf = await createSyntheticWorkbookBuffer({
        Sheet1: { headers: ['ColA'], rows: [{ ColA: 'Val1' }] },
      });

      const hash1 = computeAdminReferenceWorkbookFingerprint(buf);
      const hash2 = computeAdminReferenceWorkbookFingerprint(buf);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('mapping validation', () => {
    const validHeaders = ['Group Name', 'Project Title', 'Program', 'Year', 'Contact Email'];

    it('accepts a valid single-field or composite match key mapping', () => {
      const validConfig: AdminReferenceMappingConfig = {
        worksheet: 'ROSTER_2026',
        matchMappings: [
          { canonicalField: 'groupName', referenceColumn: 'Group Name' },
          { canonicalField: 'year', referenceColumn: 'Year' },
        ],
        comparisonMappings: [
          { canonicalField: 'title', referenceColumn: 'Project Title' },
          { canonicalField: 'program', referenceColumn: 'Program' },
        ],
        reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      };

      const res = validateAdminReferenceMapping(validConfig, validHeaders);
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.canonicalMapping.matchMappings[0].canonicalField).toBe('groupName');
      }
    });

    it('canonicalizes mapping order deterministically', () => {
      const configA: AdminReferenceMappingConfig = {
        worksheet: 'ROSTER_2026',
        matchMappings: [
          { canonicalField: 'year', referenceColumn: 'Year' },
          { canonicalField: 'groupName', referenceColumn: 'Group Name' },
        ],
        comparisonMappings: [
          { canonicalField: 'title', referenceColumn: 'Project Title' },
          { canonicalField: 'program', referenceColumn: 'Program' },
        ],
        reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      };

      const canonical = canonicalizeAdminReferenceMapping(configA);
      expect(canonical.matchMappings[0].canonicalField).toBe('groupName');
      expect(canonical.matchMappings[1].canonicalField).toBe('year');
    });

    it('rejects unknown canonical fields or missing reference columns', () => {
      const invalidCanonical = {
        worksheet: 'ROSTER_2026',
        matchMappings: [{ canonicalField: 'completelyUnknownField', referenceColumn: 'Group Name' }],
        comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Project Title' }],
        reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      };
      expect(validateAdminReferenceMapping(invalidCanonical, validHeaders).valid).toBe(false);

      const missingCol = {
        worksheet: 'ROSTER_2026',
        matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'NonExistentColumn' }],
        comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Project Title' }],
        reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      };
      expect(validateAdminReferenceMapping(missingCol, validHeaders).valid).toBe(false);
    });

    it('rejects duplicate canonical match or comparison fields', () => {
      const dupMatch = {
        worksheet: 'ROSTER_2026',
        matchMappings: [
          { canonicalField: 'groupName', referenceColumn: 'Group Name' },
          { canonicalField: 'groupName', referenceColumn: 'Program' },
        ],
        comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Project Title' }],
        reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      };
      expect(validateAdminReferenceMapping(dupMatch, validHeaders).valid).toBe(false);
    });
  });

  describe('reconciliation scenarios', () => {
    const mapping: AdminReferenceMappingConfig = {
      worksheet: 'ROSTER_2026',
      matchMappings: [
        { canonicalField: 'groupName', referenceColumn: 'Group Name' },
        { canonicalField: 'year', referenceColumn: 'Year' },
      ],
      comparisonMappings: [
        { canonicalField: 'title', referenceColumn: 'Project Title' },
        { canonicalField: 'program', referenceColumn: 'Program' },
        { canonicalField: 'participantContactEmail', referenceColumn: 'Contact Email' },
        { canonicalField: 'teamMembers', referenceColumn: 'Team Roster' },
      ],
      reconciliationContractVersion: 'admin-reference-reconciliation-v1',
    };

    it('successfully reconciles an exact and whitespace/case-normalized match', () => {
      const refRows = [
        {
          rowNumber: 2,
          values: {
            groupName: 'Group Alpha',
            year: '2026',
            title: 'AI Traffic Optimization System',
            program: 'Bachelor of Computer Science',
            participantContactEmail: 'alpha@capstone.invalid',
            teamMembers: 'Alice Smith, Bob Jones',
          },
        },
      ];

      const submitted = [
        {
          packagePath: 'projects/alpha',
          manifest: {
            groupName: '  group alpha  ',
            year: 2026,
            title: 'AI Traffic Optimization System',
            program: 'Bachelor of Computer Science',
            participantContactEmail: 'ALPHA@capstone.invalid',
            teamMembers: ['Bob Jones', 'Alice Smith'],
          },
        },
      ];

      const res = reconcilePackagesAgainstAdminReference({
        packages: submitted,
        referenceRows: refRows,
        mapping,
      });

      expect(res.packageResults.get('projects/alpha')?.status).toBe('RECONCILED');
      expect(res.packageResults.get('projects/alpha')?.matchedRowNumber).toBe(2);
      expect(res.packageResults.get('projects/alpha')?.mismatchedFields).toEqual([]);
      expect(res.unusedReferenceRowCount).toBe(0);
    });

    it('identifies ADMIN_REFERENCE_NO_MATCH when package has no matching reference row', () => {
      const refRows = [
        {
          rowNumber: 2,
          values: { groupName: 'Group Beta', year: '2026', title: 'Beta Project' },
        },
      ];

      const submitted = [
        {
          packagePath: 'projects/alpha',
          manifest: { groupName: 'Group Alpha', year: 2026, title: 'Alpha Project' },
        },
      ];

      const res = reconcilePackagesAgainstAdminReference({
        packages: submitted,
        referenceRows: refRows,
        mapping,
      });

      expect(res.packageResults.get('projects/alpha')?.status).toBe('ADMIN_REFERENCE_NO_MATCH');
      expect(res.unusedReferenceRowCount).toBe(1);
    });

    it('identifies ADMIN_REFERENCE_AMBIGUOUS_MATCH on duplicate reference match keys', () => {
      const refRows = [
        { rowNumber: 2, values: { groupName: 'Group Alpha', year: '2026', title: 'Title A' } },
        { rowNumber: 3, values: { groupName: 'Group Alpha', year: '2026', title: 'Title B' } },
      ];

      const submitted = [
        {
          packagePath: 'projects/alpha',
          manifest: { groupName: 'Group Alpha', year: 2026, title: 'Title A' },
        },
      ];

      const res = reconcilePackagesAgainstAdminReference({
        packages: submitted,
        referenceRows: refRows,
        mapping,
      });

      expect(res.packageResults.get('projects/alpha')?.status).toBe('ADMIN_REFERENCE_AMBIGUOUS_MATCH');
    });

    it('identifies ADMIN_REFERENCE_AMBIGUOUS_MATCH on duplicate submitted package match keys', () => {
      const refRows = [
        { rowNumber: 2, values: { groupName: 'Group Alpha', year: '2026', title: 'Title A' } },
      ];

      const submitted = [
        { packagePath: 'projects/alpha1', manifest: { groupName: 'Group Alpha', year: 2026, title: 'Title A' } },
        { packagePath: 'projects/alpha2', manifest: { groupName: 'Group Alpha', year: 2026, title: 'Title A' } },
      ];

      const res = reconcilePackagesAgainstAdminReference({
        packages: submitted,
        referenceRows: refRows,
        mapping,
      });

      expect(res.packageResults.get('projects/alpha1')?.status).toBe('ADMIN_REFERENCE_AMBIGUOUS_MATCH');
      expect(res.packageResults.get('projects/alpha2')?.status).toBe('ADMIN_REFERENCE_AMBIGUOUS_MATCH');
    });

    it('identifies field mismatches explicitly without altering submitted project metadata', () => {
      const refRows = [
        {
          rowNumber: 5,
          values: {
            groupName: 'Group Alpha',
            year: '2026',
            title: 'Official School Title',
            program: 'Bachelor of Computer Science',
          },
        },
      ];

      const submitted = [
        {
          packagePath: 'projects/alpha',
          manifest: {
            groupName: 'Group Alpha',
            year: 2026,
            title: 'Submitted Project Title',
            program: 'Bachelor of Software Engineering',
          },
        },
      ];

      const res = reconcilePackagesAgainstAdminReference({
        packages: submitted,
        referenceRows: refRows,
        mapping,
      });

      const result = res.packageResults.get('projects/alpha')!;
      expect(result.status).toBe('ADMIN_REFERENCE_FIELD_MISMATCH');
      expect(result.matchedRowNumber).toBe(5);
      expect(result.mismatchedFields).toContain('title');
      expect(result.mismatchedFields).toContain('program');
      // Proof: project metadata is NOT auto-modified
      expect(submitted[0].manifest.title).toBe('Submitted Project Title');
    });

    it('treats extra unused admin reference rows as a summary metric without failing valid packages', () => {
      const refRows = [
        { rowNumber: 2, values: { groupName: 'Group Alpha', year: '2026', title: 'Title A', program: 'CS' } },
        { rowNumber: 3, values: { groupName: 'Group Unsubmitted', year: '2026', title: 'Title X', program: 'CS' } },
        { rowNumber: 4, values: { groupName: 'Group Unsubmitted 2', year: '2026', title: 'Title Y', program: 'CS' } },
      ];

      const submitted = [
        {
          packagePath: 'projects/alpha',
          manifest: { groupName: 'Group Alpha', year: 2026, title: 'Title A', program: 'CS' },
        },
      ];

      const res = reconcilePackagesAgainstAdminReference({
        packages: submitted,
        referenceRows: refRows,
        mapping,
      });

      expect(res.packageResults.get('projects/alpha')?.status).toBe('RECONCILED');
      expect(res.totalReferenceRowsCount).toBe(3);
      expect(res.unusedReferenceRowCount).toBe(2);
    });

    it('rejects duplicate reference column mapping configurations', () => {
      const dupMapping: AdminReferenceMappingConfig = {
        worksheet: 'Sheet1',
        matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Col A' }],
        comparisonMappings: [
          { canonicalField: 'title', referenceColumn: 'Col A' }, // Duplicate column mapping
        ],
        reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      };
      const res = validateAdminReferenceMapping(dupMapping, ['Col A', 'Col B']);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.code).toBe('DUPLICATE_REFERENCE_COLUMN_MAPPING');
      }
    });

    it('flags duplicate normalized worksheet headers during validation', () => {
      const mapping: AdminReferenceMappingConfig = {
        worksheet: 'Sheet1',
        matchMappings: [{ canonicalField: 'groupName', referenceColumn: 'Group Name' }],
        comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Title' }],
        reconciliationContractVersion: 'admin-reference-reconciliation-v1',
      };
      const res = validateAdminReferenceMapping(mapping, ['Group Name', '  group   name  ']);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.code).toBe('DUPLICATE_NORMALIZED_HEADER');
      }
    });
  });
});
