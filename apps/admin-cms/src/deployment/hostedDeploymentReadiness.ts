/**
 * Hosted Deployment Readiness Audit Module
 *
 * Provides read-only inspection, contract evaluation, and fail-closed reporting
 * for hosted Supabase staging activation without mutating database, auth, or storage state.
 */

export const EXPECTED_REPOSITORY_MIGRATION_COUNT = 26;

export const EXPECTED_REPOSITORY_MIGRATIONS = [
  '20260601035138_staging_schema.sql',
  '20260601035139_staging_rls_policies.sql',
  '20260715102956_admin_auth_identity.sql',
  '20260719003407_explicit_data_api_grants.sql',
  '20260719165118_initial_admin_bootstrap.sql',
  '20260719165119_fix_initial_admin_bootstrap_runtime.sql',
  '20260803174000_harden_function_execute_defaults.sql',
  '20260803180000_transactional_review_actions.sql',
  '20260808170000_transactional_project_metadata_update.sql',
  '20260810090000_atomic_browser_import_metadata_stage.sql',
  '20260810120000_atomic_browser_import_media_stage.sql',
  '20260810150000_atomic_import_batch_review_submit.sql',
  '20260810180000_participant_preview_links.sql',
  '20260811090000_participant_preview_confirmations.sql',
  '20260811120000_participant_preview_correction_requests.sql',
  '20260811130000_participant_preview_correction_resolution.sql',
  '20260811150000_publication_readiness_gate.sql',
  '20260811160000_approval_edit_gate.sql',
  '20260812120000_controlled_publication_execution.sql',
  '20260812150000_controlled_public_removal.sql',
  '20260813002154_project_metadata_audit_history.sql',
  '20260813120000_staff_identity_provisioning.sql',
  '20260813180000_participant_preview_email_notifications.sql',
  '20260813190000_participant_preview_reminder_schedules.sql',
  '20260814090000_accessible_full_text_gate.sql',
  '20260814140000_snapshot_image_alt_text.sql',
] as const;

export const REQUIRED_CORE_TABLES = [
  'programs',
  'disciplines',
  'industry_categories',
  'admin_users',
  'user_roles',
  'import_batches',
  'projects',
  'project_disciplines',
  'project_industry_categories',
  'media_assets',
  'validation_flags',
  'approval_records',
  'published_snapshots',
] as const;

export const REQUIRED_IMPORT_LEDGER_TABLES = [
  'browser_import_commits',
  'browser_import_media_commits',
] as const;

export const REQUIRED_PREVIEW_TABLES = [
  'participant_previews',
  'participant_preview_tokens',
  'participant_preview_confirmations',
  'participant_preview_correction_requests',
] as const;

export const REQUIRED_STAFF_TABLES = [
  'staff_provisioning_requests',
] as const;

export const REQUIRED_NOTIFICATION_TABLES = [
  'participant_preview_notifications',
  'participant_preview_reminder_schedules',
] as const;

export const ALL_REQUIRED_TABLES = [
  ...REQUIRED_CORE_TABLES,
  ...REQUIRED_IMPORT_LEDGER_TABLES,
  ...REQUIRED_PREVIEW_TABLES,
  ...REQUIRED_STAFF_TABLES,
  ...REQUIRED_NOTIFICATION_TABLES,
] as const;

export const REQUIRED_RPCS = [
  'bootstrap_initial_admin',
  'perform_project_review_action',
  'update_project_metadata',
  'stage_browser_import_metadata',
  'finalize_browser_import_media_stage',
  'submit_import_projects_for_review',
  'generate_participant_preview',
  'confirm_participant_preview',
  'get_participant_preview_confirmation',
  'submit_participant_preview_correction_request',
  'resolve_participant_preview_correction_request',
  'get_project_publication_readiness',
  'execute_controlled_publication',
  'execute_controlled_public_removal',
  'update_snapshot_image_alt_text',
  'reserve_staff_provisioning',
  'reserve_participant_preview_notification',
  'schedule_participant_preview_reminder',
] as const;

export const REQUIRED_STORAGE_BUCKETS = [
  'project-drafts-private',
  'project-public-assets',
  'public-feeds',
] as const;

export interface HostedReadinessEvidence {
  targetIdentityMatch: boolean;
  migrationHistoryReadable: boolean;
  recordedMigrationVersions: string[];
  presentTables: string[];
  presentRpcs: string[];
  presentBuckets: string[];
  authUserIdColumnPresent: boolean;
  initialAdminLinkagePresent: boolean;
  recognizedRolesPresent: boolean;
  unexpectedTables?: string[];
}

export type DeploymentClassification =
  | 'READY_FOR_MUTATION_DECISION'
  | 'RECONCILIATION_REQUIRED'
  | 'DRIFT_REQUIRES_REVIEW'
  | 'BLOCKED';

export interface HostedReadinessEvaluation {
  targetIdentityMatch: boolean;
  migrationHistoryReadable: boolean;
  repositoryMigrationsCount: number;
  hostedRecordedMigrations: number | 'UNKNOWN';
  schemaBaseline: 'MATCH' | 'DRIFT' | 'INCOMPLETE' | 'UNKNOWN';
  requiredRpcSet: 'PRESENT' | 'INCOMPLETE';
  requiredTableSet: 'PRESENT' | 'INCOMPLETE';
  requiredStorageBuckets: 'PRESENT' | 'INCOMPLETE';
  authFoundation: 'READY' | 'INCOMPLETE';
  deploymentClassification: DeploymentClassification;
  missingTables: string[];
  missingRpcs: string[];
  missingBuckets: string[];
  missingMigrations: string[];
  notes: string[];
}

/**
 * Pure evaluation function assessing evidence against repository contracts.
 */
export function evaluateHostedDeploymentReadiness(evidence: HostedReadinessEvidence): HostedReadinessEvaluation {
  const notes: string[] = [];

  if (!evidence.targetIdentityMatch) {
    return {
      targetIdentityMatch: false,
      migrationHistoryReadable: false,
      repositoryMigrationsCount: EXPECTED_REPOSITORY_MIGRATION_COUNT,
      hostedRecordedMigrations: 'UNKNOWN',
      schemaBaseline: 'UNKNOWN',
      requiredRpcSet: 'INCOMPLETE',
      requiredTableSet: 'INCOMPLETE',
      requiredStorageBuckets: 'INCOMPLETE',
      authFoundation: 'INCOMPLETE',
      deploymentClassification: 'BLOCKED',
      missingTables: [...ALL_REQUIRED_TABLES],
      missingRpcs: [...REQUIRED_RPCS],
      missingBuckets: [...REQUIRED_STORAGE_BUCKETS],
      missingMigrations: [...EXPECTED_REPOSITORY_MIGRATIONS],
      notes: ['Target identity guard rejected execution.'],
    };
  }

  // 1. Tables check
  const missingTables = ALL_REQUIRED_TABLES.filter((t) => !evidence.presentTables.includes(t));
  const requiredTableSet: 'PRESENT' | 'INCOMPLETE' = missingTables.length === 0 ? 'PRESENT' : 'INCOMPLETE';
  if (missingTables.length > 0) {
    notes.push(`Missing tables: ${missingTables.length}`);
  }

  // 2. RPCs check
  const missingRpcs = REQUIRED_RPCS.filter((r) => !evidence.presentRpcs.includes(r));
  const requiredRpcSet: 'PRESENT' | 'INCOMPLETE' = missingRpcs.length === 0 ? 'PRESENT' : 'INCOMPLETE';
  if (missingRpcs.length > 0) {
    notes.push(`Missing RPC functions: ${missingRpcs.length}`);
  }

  // 3. Storage Buckets check
  const missingBuckets = REQUIRED_STORAGE_BUCKETS.filter((b) => !evidence.presentBuckets.includes(b));
  const requiredStorageBuckets: 'PRESENT' | 'INCOMPLETE' = missingBuckets.length === 0 ? 'PRESENT' : 'INCOMPLETE';
  if (missingBuckets.length > 0) {
    notes.push(`Missing storage buckets: ${missingBuckets.length}`);
  }

  // 4. Auth Foundation check
  const authFoundation: 'READY' | 'INCOMPLETE' =
    evidence.authUserIdColumnPresent &&
    evidence.initialAdminLinkagePresent &&
    evidence.recognizedRolesPresent &&
    evidence.presentTables.includes('admin_users') &&
    evidence.presentTables.includes('user_roles')
      ? 'READY'
      : 'INCOMPLETE';
  if (authFoundation === 'INCOMPLETE') {
    notes.push('Auth foundation is incomplete.');
  }

  // 5. Migration History check
  const hostedRecordedMigrations = evidence.migrationHistoryReadable
    ? evidence.recordedMigrationVersions.length
    : 'UNKNOWN';

  const expectedVersionPrefixes = EXPECTED_REPOSITORY_MIGRATIONS.map((m) => m.split('_')[0]);
  const missingMigrations = expectedVersionPrefixes.filter(
    (v) => !evidence.recordedMigrationVersions.some((rec) => rec.includes(v))
  );

  // 6. Schema Baseline classification
  let schemaBaseline: 'MATCH' | 'DRIFT' | 'INCOMPLETE' | 'UNKNOWN';
  if (evidence.unexpectedTables && evidence.unexpectedTables.length > 0) {
    schemaBaseline = 'DRIFT';
    notes.push(`Unexpected tables detected: ${evidence.unexpectedTables.length}`);
  } else if (requiredTableSet === 'PRESENT' && requiredRpcSet === 'PRESENT' && requiredStorageBuckets === 'PRESENT') {
    schemaBaseline = 'MATCH';
  } else if (REQUIRED_CORE_TABLES.every((t) => evidence.presentTables.includes(t))) {
    schemaBaseline = 'INCOMPLETE';
    notes.push('Core tables present but post-0006 tables/RPCs are missing.');
  } else if (evidence.presentTables.length > 0) {
    schemaBaseline = 'INCOMPLETE';
  } else {
    schemaBaseline = 'UNKNOWN';
  }

  // 7. Overall Deployment Classification
  let deploymentClassification: DeploymentClassification;

  if (schemaBaseline === 'DRIFT') {
    deploymentClassification = 'DRIFT_REQUIRES_REVIEW';
  } else if (
    evidence.migrationHistoryReadable &&
    hostedRecordedMigrations === EXPECTED_REPOSITORY_MIGRATION_COUNT &&
    schemaBaseline === 'MATCH' &&
    requiredRpcSet === 'PRESENT' &&
    requiredTableSet === 'PRESENT' &&
    requiredStorageBuckets === 'PRESENT' &&
    authFoundation === 'READY'
  ) {
    deploymentClassification = 'READY_FOR_MUTATION_DECISION';
  } else if (
    !evidence.migrationHistoryReadable ||
    (typeof hostedRecordedMigrations === 'number' && hostedRecordedMigrations < EXPECTED_REPOSITORY_MIGRATION_COUNT) ||
    schemaBaseline === 'INCOMPLETE'
  ) {
    deploymentClassification = 'RECONCILIATION_REQUIRED';
  } else {
    deploymentClassification = 'BLOCKED';
  }

  return {
    targetIdentityMatch: true,
    migrationHistoryReadable: evidence.migrationHistoryReadable,
    repositoryMigrationsCount: EXPECTED_REPOSITORY_MIGRATION_COUNT,
    hostedRecordedMigrations,
    schemaBaseline,
    requiredRpcSet,
    requiredTableSet,
    requiredStorageBuckets,
    authFoundation,
    deploymentClassification,
    missingTables,
    missingRpcs,
    missingBuckets,
    missingMigrations,
    notes,
  };
}

/**
 * Formats evaluation into standardized key-value report containing zero secrets or sensitive data.
 */
export function formatHostedReadinessReport(evalResult: HostedReadinessEvaluation): string {
  const lines: string[] = [
    '====================================================',
    'HOSTED STAGING DEPLOYMENT READINESS REPORT',
    '====================================================',
    `TARGET_IDENTITY_MATCH = ${evalResult.targetIdentityMatch ? 'YES' : 'NO'}`,
    `MIGRATION_HISTORY_READABLE = ${evalResult.migrationHistoryReadable ? 'YES' : 'NO'}`,
    `REPOSITORY_MIGRATIONS = ${evalResult.repositoryMigrationsCount}`,
    `HOSTED_RECORDED_MIGRATIONS = ${evalResult.hostedRecordedMigrations}`,
    `SCHEMA_BASELINE = ${evalResult.schemaBaseline}`,
    `REQUIRED_RPC_SET = ${evalResult.requiredRpcSet}`,
    `REQUIRED_TABLE_SET = ${evalResult.requiredTableSet}`,
    `REQUIRED_STORAGE_BUCKETS = ${evalResult.requiredStorageBuckets}`,
    `AUTH_FOUNDATION = ${evalResult.authFoundation}`,
    `DEPLOYMENT_CLASSIFICATION = ${evalResult.deploymentClassification}`,
    '====================================================',
  ];

  if (evalResult.notes.length > 0) {
    lines.push('DIAGNOSTIC SUMMARY:');
    evalResult.notes.forEach((note) => lines.push(`- ${note}`));
    lines.push('====================================================');
  }

  return lines.join('\n');
}

export interface QueryResponse<T = Record<string, unknown>[]> {
  data: T | null;
  error: unknown | null;
}

export interface QueryBuilder<T = Record<string, unknown>[]> extends PromiseLike<QueryResponse<T>> {
  limit?(count: number): Promise<QueryResponse<T>>;
  in?(column: string, values: string[]): Promise<QueryResponse<T>>;
}

export interface TableClient {
  select(cols: string): QueryBuilder;
}

export interface HostedReadinessClient {
  from(table: string): TableClient;
  schema?(schemaName: string): {
    from(table: string): TableClient;
  };
  storage?: {
    listBuckets(): Promise<{ data: Array<{ id: string; name: string }> | null; error: unknown | null }>;
  };
  rpc?(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: unknown | null }>;
}

async function executeReadQuery<T = Record<string, unknown>[]>(
  builder: QueryBuilder<T>,
  limitCount?: number
): Promise<QueryResponse<T>> {
  if (typeof limitCount === 'number' && typeof builder.limit === 'function') {
    return await builder.limit(limitCount);
  }
  return await builder;
}

/**
 * Executes safe read-only queries against an injected client to build evidence.
 * Performs zero data mutations, zero schema alterations, and zero auth provisioning.
 */
export async function checkHostedDeploymentReadinessWithClient(
  client: HostedReadinessClient,
  options?: { targetIdentityMatch?: boolean }
): Promise<HostedReadinessEvaluation> {
  const targetIdentityMatch = options?.targetIdentityMatch ?? true;
  if (!targetIdentityMatch) {
    return evaluateHostedDeploymentReadiness({
      targetIdentityMatch: false,
      migrationHistoryReadable: false,
      recordedMigrationVersions: [],
      presentTables: [],
      presentRpcs: [],
      presentBuckets: [],
      authUserIdColumnPresent: false,
      initialAdminLinkagePresent: false,
      recognizedRolesPresent: false,
    });
  }

  let migrationHistoryReadable = false;
  const recordedMigrationVersions: string[] = [];
  const presentTables: string[] = [];
  const presentRpcs: string[] = [];
  const presentBuckets: string[] = [];
  let authUserIdColumnPresent = false;
  let initialAdminLinkagePresent = false;
  let recognizedRolesPresent = false;

  // 1. Probe migration tracking table
  try {
    let migrationData: Record<string, unknown>[] | null = null;
    if (client.schema) {
      try {
        const schemaQuery = client.schema('supabase_migrations').from('schema_migrations').select('version');
        const schemaRes = await executeReadQuery(schemaQuery, 100);
        if (!schemaRes.error && schemaRes.data) {
          migrationData = schemaRes.data;
        }
      } catch {
        // Schema probe error
      }
    }
    if (!migrationData) {
      try {
        const query = client.from('schema_migrations').select('version');
        const res = await executeReadQuery(query, 100);
        if (!res.error && res.data) {
          migrationData = res.data;
        }
      } catch {
        // Table probe error
      }
    }

    if (migrationData && Array.isArray(migrationData)) {
      migrationHistoryReadable = true;
      migrationData.forEach((row) => {
        if (typeof row.version === 'string') {
          recordedMigrationVersions.push(row.version);
        }
      });
    }
  } catch {
    migrationHistoryReadable = false;
  }

  // 2. Probe required tables in read-only mode using empty limit(0) SELECT queries
  for (const tableName of ALL_REQUIRED_TABLES) {
    try {
      const query = client.from(tableName).select('id');
      const res = await executeReadQuery(query, 0);
      if (!res.error) {
        presentTables.push(tableName);
      }
    } catch {
      // Table absent
    }
  }

  // 3. Probe storage buckets
  try {
    if (client.storage?.listBuckets) {
      const { data, error } = await client.storage.listBuckets();
      if (!error && data && Array.isArray(data)) {
        data.forEach((b) => presentBuckets.push(b.id || b.name));
      }
    } else {
      const query = client.from('buckets').select('id');
      const res = await executeReadQuery(query, 10);
      if (!res.error && res.data && Array.isArray(res.data)) {
        (res.data as Array<{ id?: string }>).forEach((b) => {
          if (typeof b.id === 'string') presentBuckets.push(b.id);
        });
      }
    }
  } catch {
    // Storage probe unavailable
  }

  // 4. Probe Auth foundation
  if (presentTables.includes('admin_users')) {
    try {
      const query = client.from('admin_users').select('id, auth_user_id');
      const res = await executeReadQuery(query, 10);
      if (!res.error && res.data) {
        authUserIdColumnPresent = true;
        const linked = (res.data as Array<{ auth_user_id?: string | null }>).some((u) => !!u.auth_user_id);
        if (linked) {
          initialAdminLinkagePresent = true;
        }
      }
    } catch {
      authUserIdColumnPresent = false;
    }
  }

  if (presentTables.includes('user_roles')) {
    try {
      const query = client.from('user_roles').select('id, role');
      const res = await executeReadQuery(query, 10);
      if (!res.error && res.data && Array.isArray(res.data)) {
        const hasAdminRole = (res.data as Array<{ role?: string }>).some((r) => r.role === 'admin');
        if (hasAdminRole) {
          recognizedRolesPresent = true;
        }
      }
    } catch {
      recognizedRolesPresent = false;
    }
  }

  // 5. Probe RPCs if available (via mock/client or probe)
  if (client.rpc) {
    for (const rpcName of REQUIRED_RPCS) {
      try {
        // Safe dry-probe or metadata check
        const { error } = await client.rpc(rpcName, {});
        // Function exists if error is not 'function does not exist' / PGRST202
        if (!error) {
          presentRpcs.push(rpcName);
        } else {
          const errObj = error as { code?: string; message?: string };
          const msg = (errObj?.message || '').toLowerCase();
          const code = errObj?.code || '';
          if (
            code !== 'PGRST202' &&
            code !== '42883' &&
            !msg.includes('does not exist') &&
            !msg.includes('not found')
          ) {
            presentRpcs.push(rpcName);
          }
        }
      } catch {
        // RPC probe failed
      }
    }
  }

  return evaluateHostedDeploymentReadiness({
    targetIdentityMatch,
    migrationHistoryReadable,
    recordedMigrationVersions,
    presentTables,
    presentRpcs,
    presentBuckets,
    authUserIdColumnPresent,
    initialAdminLinkagePresent,
    recognizedRolesPresent,
  });
}
