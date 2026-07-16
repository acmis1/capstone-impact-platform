import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { evaluateStagingAuthReadiness, AdminIdentityRecord, RoleAssignmentRecord, AuditAttributionRecord } from '../auth/stagingAuthVerification';
import { isMissingAuthUserIdColumnError } from '../auth/stagingAuthCheckErrors';

/**
 * Read-only script executing SELECT-only queries to check authentication readiness on staging database.
 * 
 * Rules:
 * - Does not perform updates, inserts, deletes or signUp triggers.
 * - Restricts selected fields to prevent printing email, full name, or credential tokens.
 * - Gracefully maps trusted missing-column errors to MIGRATION_0003_MISSING status.
 * - Exits with status 0 (Ready), 2 (Incomplete Setup), or 1 (Unexpected connection error).
 */
async function runCheck() {
  let supabase;
  try {
    supabase = createSupabaseAdminClientCore();
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    process.exit(1);
  }

  let migrationPresent = true;
  let adminUsers: AdminIdentityRecord[] = [];
  let userRoles: RoleAssignmentRecord[] = [];
  let approvalRecords: AuditAttributionRecord[] = [];

  // 1. SELECT-only query on admin_users table (id and auth_user_id fields only)
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('id, auth_user_id');

    if (error) {
      if (isMissingAuthUserIdColumnError(error)) {
        migrationPresent = false;
        // Column is missing. Count legacy administrators using ID only.
        const { data: legacyData, error: legacyError } = await supabase
          .from('admin_users')
          .select('id');
        
        if (legacyError) {
          throw legacyError;
        }
        adminUsers = (legacyData || []).map((row) => {
          const r = row as { id: string };
          return {
            adminUserId: r.id,
            authUserId: null
          };
        });
      } else {
        throw error;
      }
    } else {
      adminUsers = (data || []).map((row) => {
        const r = row as { id: string; auth_user_id: string | null };
        return {
          adminUserId: r.id,
          authUserId: r.auth_user_id
        };
      });
    }
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    process.exit(1);
  }

  // 2. SELECT-only query on user_roles table (user_id and role fields only)
  try {
    const { data, error } = await supabase
      .from('user_roles')
      .select('user_id, role');

    if (error) {
      throw error;
    }
    userRoles = (data || []).map((row) => {
      const r = row as { user_id: string; role: string };
      return {
        adminUserId: r.user_id,
        role: r.role
      };
    });
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    process.exit(1);
  }

  // 3. SELECT-only query on approval_records table (admin_id field only)
  try {
    const { data, error } = await supabase
      .from('approval_records')
      .select('admin_id');

    if (error) {
      throw error;
    }
    approvalRecords = (data || []).map((row) => {
      const r = row as { admin_id: string | null };
      return {
        adminUserId: r.admin_id
      };
    });
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    process.exit(1);
  }

  // 4. Run pure evaluator to compile counts
  const evaluation = evaluateStagingAuthReadiness({
    migrationPresent,
    adminUsers,
    userRoles,
    approvalRecords
  });

  console.log('====================================================');
  console.log('🛡️  STAGING AUTHENTICATION STATUS SUMMARY');
  console.log('====================================================');
  console.log(`Migration Status (0003):      ${evaluation.migrationPresent ? 'PRESENT' : 'MIGRATION_0003_MISSING'}`);
  console.log(`Total Administrator Rows:     ${evaluation.totalAdminRows}`);
  console.log(`Linked Administrators:        ${evaluation.linkedAdminCount}`);
  console.log(`Unlinked Administrators:      ${evaluation.unlinkedAdminCount}`);
  console.log(`Recognized Role Assignments:  ${evaluation.recognizedRoleAssignmentCount}`);
  console.log(`Invalid Role Assignments:     ${evaluation.invalidRoleAssignmentCount}`);
  console.log(`Linked Admins Lacking Role:   ${evaluation.linkedAdminsWithoutRecognizedRole}`);
  console.log(`Audit Rows (with Actor):      ${evaluation.auditRecordsWithAdminId}`);
  console.log(`Audit Rows (Historical Null): ${evaluation.auditRecordsWithoutAdminId}`);
  console.log('----------------------------------------------------');
  console.log(`Readiness Status:             ${evaluation.readyForManualLoginTest ? 'READY_FOR_MANUAL_LOGIN_TEST' : 'INCOMPLETE'}`);
  
  if (evaluation.errors.length > 0) {
    console.log('Errors:');
    evaluation.errors.forEach((err) => console.log(`  - [ERROR]: ${err}`));
  }
  if (evaluation.warnings.length > 0) {
    console.log('Warnings:');
    evaluation.warnings.forEach((warn) => console.log(`  - [WARNING]: ${warn}`));
  }
  console.log('====================================================\n');

  if (!evaluation.readyForManualLoginTest) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

runCheck();
