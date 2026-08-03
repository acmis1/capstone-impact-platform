import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { createSupabaseAdminClientCore } from '../lib/supabase/adminCore';
import {
  evaluateStagingAuthReadiness,
  AdminIdentityRecord,
  RoleAssignmentRecord,
  AuditAttributionRecord,
  VerificationResult,
} from '../auth/stagingAuthVerification';
import { isMissingAuthUserIdColumnError } from '../auth/stagingAuthCheckErrors';
import { validateStagingGuard } from '../security/stagingExecutionGuard';

export interface StagingAuthCheckClient {
  from(table: string): {
    select(cols: string): Promise<{ data: Record<string, unknown>[] | null; error: unknown | null }>;
  };
}

export interface CheckStagingAuthRunnerResult {
  classification: 'READY_FOR_MANUAL_LOGIN_TEST' | 'INCOMPLETE' | 'FAILED';
  exitCode: 0 | 1 | 2;
  details?: VerificationResult;
}

/**
 * Testable worker executing database queries using an injected narrow client.
 * Performs NO environment loading, client creation, or guard checks.
 */
export async function checkStagingAuthWithClient(
  client: StagingAuthCheckClient
): Promise<CheckStagingAuthRunnerResult> {
  let migrationPresent = true;
  let adminUsers: AdminIdentityRecord[] = [];
  let userRoles: RoleAssignmentRecord[] = [];
  let approvalRecords: AuditAttributionRecord[] = [];

  // 1. SELECT-only query on admin_users table (id and auth_user_id fields)
  try {
    const { data, error } = await client.from('admin_users').select('id, auth_user_id');

    if (error) {
      if (isMissingAuthUserIdColumnError(error)) {
        migrationPresent = false;
        const { data: legacyData, error: legacyError } = await client.from('admin_users').select('id');

        if (legacyError) {
          throw legacyError;
        }
        adminUsers = ((legacyData as unknown as { id: string }[]) || []).map((row) => ({
          adminUserId: row.id,
          authUserId: null,
        }));
      } else {
        throw error;
      }
    } else {
      adminUsers = ((data as unknown as { id: string; auth_user_id: string | null }[]) || []).map((row) => ({
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
    const { data, error } = await client.from('user_roles').select('id, user_id, role');

    if (error) {
      throw error;
    }

    userRoles = ((data as unknown as { id: string; user_id: string; role: string }[]) || []).map((row) => ({
      adminUserId: row.user_id,
      role: row.role,
    }));
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return { classification: 'FAILED', exitCode: 1 };
  }

  // 3. SELECT-only query on approval_records table (selecting DB schema admin_id)
  try {
    const { data, error } = await client.from('approval_records').select('id, admin_id');

    if (error) {
      throw error;
    }

    approvalRecords = ((data as unknown as { id: string; admin_id: string | null }[]) || []).map((row) => ({
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

  const errorCodesStr = evaluation.errors.length > 0 ? evaluation.errors.join(',') : 'NONE';
  const warningCodesStr = evaluation.warnings.length > 0 ? evaluation.warnings.join(',') : 'NONE';

  console.log(`classification=${classification}`);
  console.log(`migration_present=${evaluation.migrationPresent ? 'YES' : 'NO'}`);
  console.log(`admin_users_count=${evaluation.totalAdminRows}`);
  console.log(`linked_auth_users_count=${evaluation.linkedAdminCount}`);
  console.log(`unlinked_admin_users_count=${evaluation.unlinkedAdminCount}`);
  console.log(`recognized_role_assignments=${evaluation.recognizedRoleAssignmentCount}`);
  console.log(`invalid_role_assignments=${evaluation.invalidRoleAssignmentCount}`);
  console.log(`linked_admins_without_recognized_role=${evaluation.linkedAdminsWithoutRecognizedRole}`);
  console.log(`audit_records_with_actor=${evaluation.auditRecordsWithAdminId}`);
  console.log(`audit_records_without_actor=${evaluation.auditRecordsWithoutAdminId}`);
  console.log(`error_codes=${errorCodesStr}`);
  console.log(`warning_codes=${warningCodesStr}`);

  return { classification, exitCode, details: evaluation };
}

/**
 * Public CLI runner function.
 * Enforces guard execution BEFORE environment-derived client creation,
 * then delegates query execution to checkStagingAuthWithClient.
 */
export async function runCheckStagingAuth(args?: string[]): Promise<CheckStagingAuthRunnerResult> {
  // 1. Staging guard MUST execute before client creation
  validateStagingGuard({ operationId: 'check-staging-auth', args });

  // 2. Create environment-derived client
  let supabase;
  try {
    supabase = createSupabaseAdminClientCore();
  } catch {
    console.error('STAGING_AUTH_CHECK_FAILED');
    return { classification: 'FAILED', exitCode: 1 };
  }

  // 3. Delegate execution to testable worker
  return checkStagingAuthWithClient(supabase as unknown as StagingAuthCheckClient);
}

if (require.main === module) {
  runCheckStagingAuth().then((res) => {
    process.exit(res.exitCode);
  }).catch(() => {
    console.error('STAGING_AUTH_CHECK_FAILED');
    process.exit(1);
  });
}
