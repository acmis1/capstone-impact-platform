export interface AdminIdentityRecord {
  adminUserId: string;
  authUserId: string | null;
}

export interface RoleAssignmentRecord {
  adminUserId: string;
  role: string;
}

export interface AuditAttributionRecord {
  adminUserId: string | null;
}

export interface VerificationInput {
  migrationPresent: boolean;
  adminUsers: AdminIdentityRecord[];
  userRoles: RoleAssignmentRecord[];
  approvalRecords: AuditAttributionRecord[];
}

export interface VerificationResult {
  migrationPresent: boolean;
  totalAdminRows: number;
  linkedAdminCount: number;
  unlinkedAdminCount: number;
  recognizedRoleAssignmentCount: number;
  invalidRoleAssignmentCount: number;
  linkedAdminsWithoutRecognizedRole: number;
  auditRecordsWithAdminId: number;
  auditRecordsWithoutAdminId: number;
  readyForManualLoginTest: boolean;
  errors: string[];
  warnings: string[];
}

const RECOGNIZED_ROLES = ['admin', 'reviewer', 'editor'];

/**
 * Pure offline evaluator of database state readiness for authentication.
 * Never performs network, filesystem or environment reads.
 * Reports counts and status flags without exposing sensitive names/emails.
 */
export function evaluateStagingAuthReadiness(input: VerificationInput): VerificationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const totalAdminRows = input.adminUsers.length;
  let linkedAdminCount = 0;
  let unlinkedAdminCount = 0;

  const linkedAdminUserIds = new Set<string>();

  input.adminUsers.forEach((admin) => {
    if (admin.authUserId && admin.authUserId.trim() !== '') {
      linkedAdminCount++;
      linkedAdminUserIds.add(admin.adminUserId);
    } else {
      unlinkedAdminCount++;
    }
  });

  let recognizedRoleAssignmentCount = 0;
  let invalidRoleAssignmentCount = 0;
  const adminIdsWithRecognizedRole = new Set<string>();

  input.userRoles.forEach((roleAssignment) => {
    if (RECOGNIZED_ROLES.includes(roleAssignment.role)) {
      recognizedRoleAssignmentCount++;
      adminIdsWithRecognizedRole.add(roleAssignment.adminUserId);
    } else {
      invalidRoleAssignmentCount++;
    }
  });

  // Check linked admins without recognized roles
  let linkedAdminsWithoutRecognizedRole = 0;
  linkedAdminUserIds.forEach((adminId) => {
    if (!adminIdsWithRecognizedRole.has(adminId)) {
      linkedAdminsWithoutRecognizedRole++;
    }
  });

  // Calculate audit counts
  let auditRecordsWithAdminId = 0;
  let auditRecordsWithoutAdminId = 0;

  input.approvalRecords.forEach((record) => {
    if (record.adminUserId) {
      auditRecordsWithAdminId++;
    } else {
      auditRecordsWithoutAdminId++;
    }
  });

  // Apply error & warning rules
  if (!input.migrationPresent) {
    errors.push('MIGRATION_0003_MISSING');
  }

  if (input.migrationPresent && linkedAdminCount === 0) {
    errors.push('NO_LINKED_ADMIN');
  }

  if (input.migrationPresent && linkedAdminCount > 0 && linkedAdminsWithoutRecognizedRole === linkedAdminCount) {
    errors.push('LINKED_ADMIN_WITHOUT_ROLE');
  }

  if (invalidRoleAssignmentCount > 0) {
    errors.push('INVALID_ROLE_ASSIGNED');
  }

  if (auditRecordsWithoutAdminId > 0) {
    warnings.push('HISTORICAL_NULL_AUDIT_ACTORS');
  }

  const readyForManualLoginTest =
    input.migrationPresent &&
    linkedAdminCount > 0 &&
    linkedAdminsWithoutRecognizedRole < linkedAdminCount &&
    invalidRoleAssignmentCount === 0 &&
    errors.length === 0;

  return {
    migrationPresent: input.migrationPresent,
    totalAdminRows,
    linkedAdminCount,
    unlinkedAdminCount,
    recognizedRoleAssignmentCount,
    invalidRoleAssignmentCount,
    linkedAdminsWithoutRecognizedRole,
    auditRecordsWithAdminId,
    auditRecordsWithoutAdminId,
    readyForManualLoginTest,
    errors,
    warnings,
  };
}
