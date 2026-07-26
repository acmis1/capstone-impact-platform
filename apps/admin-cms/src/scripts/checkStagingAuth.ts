import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { evaluateStagingAuthReadiness, AdminIdentityRecord, RoleAssignmentRecord, AuditAttributionRecord } from '../auth/stagingAuthVerification';
import { isMissingAuthUserIdColumnError } from '../auth/stagingAuthCheckErrors';
import { validateStagingGuard } from '../security/stagingExecutionGuard';

export async function runCheckStagingAuth(args?: string[]): Promise<boolean> {
  validateStagingGuard({ operationId: 'check-staging-auth', args });

  let supabase;
  try {
    supabase = createSupabaseAdminClientCore();
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return false;
  }

  let migrationPresent = true;
  let adminUsers: AdminIdentityRecord[] = [];
  let userRoles: RoleAssignmentRecord[] = [];
  let approvalRecords: AuditAttributionRecord[] = [];

  // 1. SELECT-only query on admin_users table
  try {
    const { data, error } = await supabase
      .from('admin_users')
      .select('id, auth_user_id');

    if (error) {
      if (isMissingAuthUserIdColumnError(error)) {
        migrationPresent = false;
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
            authUserId: null,
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
          authUserId: r.auth_user_id,
        };
      });
    }
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return false;
  }

  // 2. SELECT-only query on user_roles table
  try {
    const { data, error } = await supabase
      .from('user_roles')
      .select('id, admin_user_id, role');

    if (error) {
      throw error;
    }

    userRoles = (data || []).map((row) => {
      const r = row as { id: string; admin_user_id: string; role: string };
      return {
        roleRecordId: r.id,
        adminUserId: r.admin_user_id,
        role: r.role,
      };
    });
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return false;
  }

  // 3. SELECT-only query on approval_records table
  try {
    const { data, error } = await supabase
      .from('approval_records')
      .select('id, admin_user_id');

    if (error) {
      throw error;
    }

    approvalRecords = (data || []).map((row) => {
      const r = row as { id: string; admin_user_id: string };
      return {
        approvalRecordId: r.id,
        adminUserId: r.admin_user_id,
      };
    });
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return false;
  }

  const evaluation = evaluateStagingAuthReadiness({
    migrationPresent,
    adminUsers,
    userRoles,
    approvalRecords,
  });

  const classification = evaluation.readyForManualLoginTest ? 'STAGING_AUTH_READY' : 'INCOMPLETE_SETUP';

  console.log(`classification=${classification}`);
  console.log(`admin_users_count=${evaluation.totalAdminRows}`);
  console.log(`linked_auth_users_count=${evaluation.linkedAdminCount}`);
  console.log(`unlinked_admin_users_count=${evaluation.unlinkedAdminCount}`);
  console.log(`user_roles_count=${evaluation.recognizedRoleAssignmentCount}`);
  console.log(`approval_records_count=${evaluation.auditRecordsWithAdminId}`);

  return evaluation.readyForManualLoginTest;
}

if (require.main === module) {
  runCheckStagingAuth().then((success) => {
    if (!success) process.exit(1);
  }).catch(() => {
    console.error('STAGING_AUTH_CHECK_FAILED');
    process.exit(1);
  });
}
