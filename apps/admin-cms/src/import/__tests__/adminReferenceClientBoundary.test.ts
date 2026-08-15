import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ADMIN_REFERENCE_LIMITS,
  CANONICAL_MATCHABLE_FIELDS,
  CANONICAL_COMPARABLE_FIELDS,
  adminReferenceFieldMappingSchema,
  adminReferenceMappingConfigSchema,
} from '../adminReferenceSharedContract';
import * as serverReconciliation from '../adminReferenceReconciliation';

describe('Admin Reference Client/Server Boundary Architecture', () => {
  it('exports all canonical lookup constants and schemas from the client-safe shared contract', () => {
    expect(ADMIN_REFERENCE_LIMITS).toBeDefined();
    expect(ADMIN_REFERENCE_LIMITS.MAX_WORKBOOK_BYTES).toBe(5 * 1024 * 1024);
    expect(CANONICAL_MATCHABLE_FIELDS).toContain('publicId');
    expect(CANONICAL_MATCHABLE_FIELDS).toContain('title');
    expect(CANONICAL_COMPARABLE_FIELDS).toContain('title');
    expect(CANONICAL_COMPARABLE_FIELDS).toContain('teamMembers');

    const validMapping = adminReferenceMappingConfigSchema.safeParse({
      worksheet: 'REFERENCE',
      matchMappings: [{ canonicalField: 'publicId', referenceColumn: 'Public ID' }],
      comparisonMappings: [{ canonicalField: 'title', referenceColumn: 'Official Project Title' }],
      reconciliationContractVersion: 'admin-reference-reconciliation-v1',
    });
    expect(validMapping.success).toBe(true);
  });

  it('re-exports shared contracts from adminReferenceReconciliation for server-side compatibility', () => {
    expect(serverReconciliation.CANONICAL_MATCHABLE_FIELDS).toEqual(CANONICAL_MATCHABLE_FIELDS);
    expect(serverReconciliation.CANONICAL_COMPARABLE_FIELDS).toEqual(CANONICAL_COMPARABLE_FIELDS);
    expect(serverReconciliation.ADMIN_REFERENCE_LIMITS).toEqual(ADMIN_REFERENCE_LIMITS);
    expect(typeof serverReconciliation.computeAdminReferenceWorkbookFingerprint).toBe('function');
  });

  it('ensures adminReferenceSharedContract has zero server-only Node or ExcelJS imports', () => {
    const sharedContractPath = path.resolve(__dirname, '../adminReferenceSharedContract.ts');
    const content = fs.readFileSync(sharedContractPath, 'utf8');

    expect(content).not.toMatch(/from\s+['"]exceljs['"]/);
    expect(content).not.toMatch(/from\s+['"](?:node:)?crypto['"]/);
    expect(content).not.toMatch(/from\s+['"](?:node:)?fs['"]/);
    expect(content).not.toMatch(/from\s+['"](?:node:)?path['"]/);
    expect(content).not.toMatch(/from\s+['"]\.\/adminReferenceReconciliation['"]/);
  });

  it('ensures AdminReferenceDatasetSection imports only from client-safe shared contracts', () => {
    const componentPath = path.resolve(
      __dirname,
      '../../components/imports/AdminReferenceDatasetSection.tsx'
    );
    const content = fs.readFileSync(componentPath, 'utf8');

    expect(content).toMatch(/from\s+['"].*adminReferenceSharedContract['"]/);
    expect(content).not.toMatch(/from\s+['"].*adminReferenceReconciliation['"]/);
  });

  it('ensures BrowserImportPreviewClient does not import from server reconciliation module', () => {
    const clientPath = path.resolve(
      __dirname,
      '../../components/imports/BrowserImportPreviewClient.tsx'
    );
    const content = fs.readFileSync(clientPath, 'utf8');

    expect(content).not.toMatch(/from\s+['"].*adminReferenceReconciliation['"]/);
  });
});
