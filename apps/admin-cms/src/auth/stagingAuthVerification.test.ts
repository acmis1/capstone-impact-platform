import { describe, it, expect } from 'vitest';
import { evaluateStagingAuthReadiness, VerificationInput } from './stagingAuthVerification';

describe('Staging Auth Verification Evaluator', () => {
  const validUuid = 'd7170068-bc23-4554-ba5e-f00de7a7872d';

  it('1. Migration present, one linked admin, valid admin role -> ready = true', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'admin' }],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('2. Migration missing -> ready = false, MIGRATION_0003_MISSING returned', () => {
    const input: VerificationInput = {
      migrationPresent: false,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'admin' }],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(false);
    expect(result.errors).toContain('MIGRATION_0003_MISSING');
  });

  it('3. Migration present but no linked admins -> ready = false, NO_LINKED_ADMIN returned', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: null }],
      userRoles: [{ adminUserId: 'admin1', role: 'admin' }],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(false);
    expect(result.errors).toContain('NO_LINKED_ADMIN');
  });

  it('4. Linked admin with no role -> ready = false', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(false);
  });

  it('5. Linked admin with reviewer role -> ready = true', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'reviewer' }],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(true);
  });

  it('6. Linked admin with editor role -> ready = true', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'editor' }],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(true);
  });

  it('7. Unknown role -> does not create permissions or readiness incorrectly', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'unknown_role' }],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(false);
    expect(result.errors).toContain('INVALID_ROLE_ASSIGNED');
  });

  it('8. Multiple role assignments counts are correct and duplicates do not distort admin counts', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [
        { adminUserId: 'admin1', role: 'reviewer' },
        { adminUserId: 'admin1', role: 'editor' },
      ],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(true);
    expect(result.recognizedRoleAssignmentCount).toBe(2);
    expect(result.linkedAdminCount).toBe(1);
  });

  it('9. Unlinked legacy administrator rows counted but do not authorize readiness', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [
        { adminUserId: 'admin1', authUserId: null },
        { adminUserId: 'admin2', authUserId: '' },
      ],
      userRoles: [
        { adminUserId: 'admin1', role: 'admin' },
        { adminUserId: 'admin2', role: 'editor' },
      ],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(false);
    expect(result.unlinkedAdminCount).toBe(2);
    expect(result.linkedAdminCount).toBe(0);
  });

  it('10. Historical null audit actors warning only', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'admin' }],
      approvalRecords: [{ adminUserId: null }, { adminUserId: '' }],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(true);
    expect(result.warnings).toContain('HISTORICAL_NULL_AUDIT_ACTORS');
    expect(result.auditRecordsWithoutAdminId).toBe(2);
  });

  it('11. New audit records with non-null actors counted correctly', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'admin' }],
      approvalRecords: [{ adminUserId: 'admin1' }, { adminUserId: 'admin1' }],
    };
    const result = evaluateStagingAuthReadiness(input);
    expect(result.readyForManualLoginTest).toBe(true);
    expect(result.auditRecordsWithAdminId).toBe(2);
  });

  it('12. No output contains sensitive keys (email, full name, password, tokens)', () => {
    const input: VerificationInput = {
      migrationPresent: true,
      adminUsers: [{ adminUserId: 'admin1', authUserId: validUuid }],
      userRoles: [{ adminUserId: 'admin1', role: 'admin' }],
      approvalRecords: [],
    };
    const result = evaluateStagingAuthReadiness(input);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('email');
    expect(serialized).not.toContain('name');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
  });
});
