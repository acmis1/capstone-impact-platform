import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import { evaluateStagingAuthReadiness, AdminIdentityRecord, RoleAssignmentRecord, AuditAttributionRecord } from '../auth/stagingAuthVerification';
import { isMissingAuthUserIdColumnError } from '../auth/stagingAuthCheckErrors';
import { validateStagingGuard } from '../security/stagingExecutionGuard';

export interface CheckStagingAuthRunnerResult {
  classification: 'READY_FOR_MANUAL_LOGIN_TEST' | 'INCOMPLETE' | 'FAILED';
  exitCode: 0 | 1 | 2;
}

export async function runCheckStagingAuth(
  args?: string[],
  clientFactory?: () => any
): Promise<CheckStagingAuthRunnerResult> {
  // Staging guard MUST execute before client creation
  validateStagingGuard({ operationId: 'check-staging-auth', args });

  let supabase;
  try {
    supabase = clientFactory ? clientFactory() : createSupabaseAdminClientCore();
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return { classification: 'FAILED', exitCode: 1 };
  }

  let migrationPresent = true;
  let adminUsers: AdminIdentityRecord[] = [];
  let userRoles: RoleAssignmentRecord[] = [];
  let approvalRecords: AuditAttributionRecord[] = [];

  // 1. SELECT-only query on admin_users table (id and auth_user_id fields)
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
        adminUsers = (legacyData || []).map((row: { id: string }) => ({
          adminUserId: row.id,
          authUserId: null,
        }));
      } else {
        throw error;
      }
    } else {
      adminUsers = (data || []).map((row: { id: string; auth_user_id: string | null }) => ({
        adminUserId: row.id,
        authUserId: row.auth_user_id,
      }));
    }
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return { classification: 'FAILED', exitCode: 1 };
  }

  // 2. SELECT-only query on user_roles table (selecting DB schema user_id)
  try {
    const { data, error } = await supabase
      .from('user_roles')
      .select('id, user_id, role');

    if (error) {
      throw error;
    }

    userRoles = (data || []).map((row: { id: string; user_id: string; role: string }) => ({
      adminUserId: row.user_id,
      role: row.role,
    }));
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return { classification: 'FAILED', exitCode: 1 };
  }

  // 3. SELECT-only query on approval_records table (selecting DB schema admin_id)
  try {
    const { data, error } = await supabase
      .from('approval_records')
      .select('id, admin_id');

    if (error) {
      throw error;
    }

    approvalRecords = (data || []).map((row: { id: string; admin_id: string | null }) => ({
      adminUserId: row.admin_id,
    }));
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return { classification: 'FAILED', exitCode: 1 };
  }

  const evaluation = evaluateStagingAuthReadiness({
    migrationPresent,
    adminUsers,
    userRoles,
    approvalRecords,
  });

  const classification: 'READY_FOR_MANUAL_LOGIN_TEST' | 'INCOMPLETE' = evaluation.readyForManualLoginTest
    ? 'READY_FOR_MANUAL_LOGIN_TEST'
    : 'INCOMPLETE';

  const exitCode: 0 | 2 = evaluation.readyForManualLoginTest ? 0 : 2;

  console.log(`classification=${classification}`);
  console.log(`admin_users_count=${evaluation.totalAdminRows}`);
  console.log(`linked_auth_users_count=${evaluation.linkedAdminCount}`);
  console.log(`unlinked_admin_users_count=${evaluation.unlinkedAdminCount}`);
  console.log(`user_roles_count=${evaluation.recognizedRoleAssignmentCount}`);
  console.log(`approval_records_count=${evaluation.auditRecordsWithAdminId}`);

  return { classification, exitCode };
}

if (require.main === module) {
  runCheckStagingAuth().then((res) => {
    process.exit(res.exitCode);
  }).catch(() => {
    console.error('STAGING_AUTH_CHECK_FAILED');
    process.exit(1);
  });
}
