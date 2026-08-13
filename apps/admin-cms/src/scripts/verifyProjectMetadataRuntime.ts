import { createClient } from '@supabase/supabase-js';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

type MetadataSnapshot = {
  publicId: string;
  title: string;
  summary: string;
  background: string;
  solution: string;
  year: number;
  programId: string;
  groupName: string;
  updatedAt: string;
  disciplineIds: string[];
  industryCategoryIds: string[];
};

type MetadataRpcResponse = {
  resultCode?: string;
  metadata?: {
    publicId?: string;
    title?: string;
    summary?: string;
    background?: string;
    solution?: string;
    year?: string;
    programId?: string;
    disciplineIds?: string[];
    industryCategoryIds?: string[];
    expectedUpdatedAt?: string;
  };
};

type RpcResult = { data: MetadataRpcResponse | null; error: { message: string } | null };

type MetadataRpcParameters = {
  p_public_id: string;
  p_title: string;
  p_summary: string;
  p_background: string;
  p_solution: string;
  p_year: number;
  p_program_id: string;
  p_discipline_ids: string[];
  p_industry_category_ids: string[];
  p_expected_updated_at: string;
  p_admin_id: string;
};

type LookupFixture = {
  programId: string;
  disciplineIds: string[];
  industryCategoryIds: string[];
  adminUserId: string;
  reviewerUserId: string;
};

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LOCAL_DB_CONTAINER = 'supabase_db_capstone-impact-platform';

function executeLocalSql(sql: string): string {
  try {
    return execFileSync(
      'docker',
      ['exec', LOCAL_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
      { encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: Buffer | string }).stderr ?? '')
      : '';
    throw new Error(`Local metadata runtime query failed: ${detail}`);
  }
}

function executeLocalSqlExpectingPermissionDenial(role: 'anon' | 'authenticated', sql: string): void {
  try {
    executeLocalSql(`SET ROLE ${role}; ${sql}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : '';
    if (detail.includes('permission denied')) return;
    throw new Error(`${role} runtime privilege check failed for an unexpected reason.`);
  }
  throw new Error(`${role} unexpectedly executed update_project_metadata.`);
}

function queryLocalJson<T>(sql: string): T {
  const output = executeLocalSql(sql).trim();
  if (!output) throw new Error('Local metadata runtime query returned no result.');
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error('Local metadata runtime query returned malformed JSON.');
  }
}

function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Metadata runtime returned an invalid timestamp.');
  return parsed.toISOString();
}

function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

function haveSameIds(left: string[], right: string[]): boolean {
  const normalizedLeft = sortedIds(left);
  const normalizedRight = sortedIds(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((id, index) => id === normalizedRight[index]);
}

function assertSnapshotEqual(actual: MetadataSnapshot, expected: MetadataSnapshot, context: string): void {
  const scalarMatches = actual.publicId === expected.publicId
    && actual.title === expected.title
    && actual.summary === expected.summary
    && actual.background === expected.background
    && actual.solution === expected.solution
    && actual.year === expected.year
    && actual.programId === expected.programId
    && actual.groupName === expected.groupName
    && normalizeTimestamp(actual.updatedAt) === normalizeTimestamp(expected.updatedAt);
  if (!scalarMatches || !haveSameIds(actual.disciplineIds, expected.disciplineIds) || !haveSameIds(actual.industryCategoryIds, expected.industryCategoryIds)) {
    throw new Error(`${context}: project metadata changed unexpectedly.`);
  }
}

function getProjectSnapshot(publicId: string): MetadataSnapshot {
  return queryLocalJson<MetadataSnapshot>(`
    SELECT pg_catalog.jsonb_build_object(
      'publicId', p.public_id,
      'title', p.title,
      'summary', p.summary,
      'background', p.background,
      'solution', p.solution,
      'year', p.year,
      'programId', p.program_id::text,
      'groupName', p.group_name,
      'updatedAt', p.updated_at,
      'disciplineIds', COALESCE((SELECT pg_catalog.jsonb_agg(pd.discipline_id::text ORDER BY pd.discipline_id) FROM public.project_disciplines pd WHERE pd.project_id = p.id), '[]'::jsonb),
      'industryCategoryIds', COALESCE((SELECT pg_catalog.jsonb_agg(pic.industry_category_id::text ORDER BY pic.industry_category_id) FROM public.project_industry_categories pic WHERE pic.project_id = p.id), '[]'::jsonb)
    )
    FROM public.projects p
    WHERE p.public_id = '${publicId}'
  `);
}

function getLookupFixture(): LookupFixture {
  executeLocalSql(`
    INSERT INTO public.admin_users (id, email, full_name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'admin@example.com', 'Admin User') ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000a1', 'admin') ON CONFLICT DO NOTHING;
    INSERT INTO public.admin_users (id, email, full_name) VALUES ('00000000-0000-0000-0000-0000000000a2', 'reviewer@example.com', 'Reviewer User') ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000a2', 'reviewer') ON CONFLICT DO NOTHING;
  `);
  
  const fixture = queryLocalJson<LookupFixture>(`
    SELECT pg_catalog.jsonb_build_object(
      'programId', (SELECT id::text FROM public.programs ORDER BY name LIMIT 1),
      'disciplineIds', ARRAY(SELECT id::text FROM public.disciplines ORDER BY name LIMIT 2),
      'industryCategoryIds', ARRAY(SELECT id::text FROM public.industry_categories ORDER BY name LIMIT 2),
      'adminUserId', (SELECT id::text FROM public.admin_users au WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = au.id AND ur.role = 'admin') LIMIT 1),
      'reviewerUserId', (SELECT id::text FROM public.admin_users au WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = au.id AND ur.role = 'reviewer') AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = au.id AND ur.role IN ('admin', 'editor')) LIMIT 1)
    )
  `);
  if (!fixture.programId || fixture.disciplineIds.length < 2 || fixture.industryCategoryIds.length < 2 || !fixture.adminUserId || !fixture.reviewerUserId) {
    throw new Error('Local metadata runtime requires one program, two discipline/category fixtures, an admin, and a reviewer.');
  }
  return fixture;
}

function seedProject(publicId: string, fixture: LookupFixture, title: string): void {
  executeLocalSql(`
    DO $$
    DECLARE project_id uuid;
    BEGIN
      INSERT INTO public.projects (public_id, title, summary, background, solution, year, program_id, program_name, discipline, industry, group_name)
      VALUES ('${publicId}', '${title}', 'Before summary', 'Before background', 'Before solution', 2025, '${fixture.programId}'::uuid, 'legacy', 'legacy', 'legacy', 'unrelated field')
      RETURNING id INTO project_id;
      INSERT INTO public.project_disciplines (project_id, discipline_id) VALUES (project_id, '${fixture.disciplineIds[0]}'::uuid);
      INSERT INTO public.project_industry_categories (project_id, industry_category_id) VALUES (project_id, '${fixture.industryCategoryIds[0]}'::uuid);
    END $$;
  `);
}

function makeParameters(publicId: string, fixture: LookupFixture, expectedUpdatedAt: string, title: string, disciplineIds = fixture.disciplineIds, industryCategoryIds = fixture.industryCategoryIds, adminUserId = fixture.adminUserId): MetadataRpcParameters {
  return {
    p_public_id: publicId,
    p_title: title,
    p_summary: `${title} summary`,
    p_background: `${title} background`,
    p_solution: `${title} solution`,
    p_year: 2026,
    p_program_id: fixture.programId,
    p_discipline_ids: disciplineIds,
    p_industry_category_ids: industryCategoryIds,
    p_expected_updated_at: expectedUpdatedAt,
    p_admin_id: adminUserId,
  };
}

function assertRpcCode(result: RpcResult, code: string, context: string): MetadataRpcResponse {
  if (result.error || result.data?.resultCode !== code) {
    throw new Error(`${context}: expected ${code}.`);
  }
  return result.data;
}

function snapshotFromSuccessfulResponse(response: MetadataRpcResponse, expected: MetadataSnapshot): MetadataSnapshot {
  const metadata = response.metadata;
  if (!metadata?.expectedUpdatedAt || !metadata.publicId || !metadata.title || !metadata.summary || !metadata.background || !metadata.solution || !metadata.year || !metadata.programId || !metadata.disciplineIds || !metadata.industryCategoryIds) {
    throw new Error('Successful metadata RPC response was incomplete.');
  }
  return {
    publicId: metadata.publicId,
    title: metadata.title,
    summary: metadata.summary,
    background: metadata.background,
    solution: metadata.solution,
    year: Number(metadata.year),
    programId: metadata.programId,
    groupName: expected.groupName,
    updatedAt: metadata.expectedUpdatedAt,
    disciplineIds: metadata.disciplineIds,
    industryCategoryIds: metadata.industryCategoryIds,
  };
}

export function evaluateConcurrentSaveResults(results: RpcResult[]): { successCount: number; staleVersionCount: number; successfulResponse: MetadataRpcResponse } {
  const successful = results.filter((result) => !result.error && result.data?.resultCode === 'SUCCESS').map((result) => result.data!);
  const stale = results.filter((result) => !result.error && result.data?.resultCode === 'STALE_VERSION');
  if (successful.length !== 1 || stale.length !== 1 || results.length !== 2) {
    throw new Error('Concurrent metadata save verification requires exactly one SUCCESS and one STALE_VERSION result.');
  }
  return { successCount: successful.length, staleVersionCount: stale.length, successfulResponse: successful[0] };
}

export function assertRuntimePrivilegeResults(results: { serviceRole: RpcResult; anonDenied: boolean; authenticatedDenied: boolean }): void {
  if (results.serviceRole.error || results.serviceRole.data?.resultCode !== 'SUCCESS') {
    throw new Error('Service-role metadata RPC execution did not succeed.');
  }
  if (!results.anonDenied || !results.authenticatedDenied) {
    throw new Error('Forbidden runtime role execution was not denied.');
  }
}

export function assertRuntimeCleanup(result: { syntheticProjectCount: number; temporaryTriggerCount: number; temporaryFunctionCount: number }): void {
  if (result.syntheticProjectCount !== 0 || result.temporaryTriggerCount !== 0 || result.temporaryFunctionCount !== 0) {
    throw new Error('Metadata runtime cleanup left synthetic records or temporary database objects behind.');
  }
}

function createServiceClient() {
  const cliPath = path.resolve(REPO_ROOT, 'node_modules/.bin/supabase');
  const output = execSync(`"${cliPath}" status --workdir "${path.resolve(REPO_ROOT, 'infra')}" -o env`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  const localEnv = parseSupabaseCliEnv(output);
  if (!localEnv.API_URL || !localEnv.SERVICE_ROLE_KEY || !isLoopbackUrl(localEnv.API_URL)) {
    throw new Error('Metadata runtime verifier requires a loopback-only local Supabase service-role client.');
  }
  return createClient(localEnv.API_URL, localEnv.SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function cleanupRuntimeArtifacts(projectIds: string[], triggerName: string, functionName: string): void {
  executeLocalSql(`
    DROP TRIGGER IF EXISTS ${triggerName} ON public.project_industry_categories;
    DROP FUNCTION IF EXISTS public.${functionName}();
    DELETE FROM public.project_disciplines WHERE project_id IN (SELECT id FROM public.projects WHERE public_id IN (${projectIds.map((id) => `'${id}'`).join(', ')}));
    DELETE FROM public.project_industry_categories WHERE project_id IN (SELECT id FROM public.projects WHERE public_id IN (${projectIds.map((id) => `'${id}'`).join(', ')}));
    DELETE FROM public.projects WHERE public_id IN (${projectIds.map((id) => `'${id}'`).join(', ')});
  `);
  const cleanup = queryLocalJson<{ syntheticProjectCount: number; temporaryTriggerCount: number; temporaryFunctionCount: number }>(`
    SELECT pg_catalog.jsonb_build_object(
      'syntheticProjectCount', (SELECT count(*) FROM public.projects WHERE public_id IN (${projectIds.map((id) => `'${id}'`).join(', ')})),
      'temporaryTriggerCount', (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname = '${triggerName}' AND NOT tgisinternal),
      'temporaryFunctionCount', (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${functionName}')
    )
  `);
  assertRuntimeCleanup(cleanup);
}

export async function verifyProjectMetadataRuntime(): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const successId = `metadata-runtime-success-${suffix}`;
  const failureId = `metadata-runtime-failure-${suffix}`;
  const concurrentId = `metadata-runtime-concurrent-${suffix}`;
  const triggerName = `temp_metadata_failure_trigger_${suffix}`;
  const functionName = `temp_metadata_failure_function_${suffix}`;
  const projectIds = [successId, failureId, concurrentId];
  let verifierError: unknown;

  try {
    const fixture = getLookupFixture();
    const serviceClient = createServiceClient();
    seedProject(successId, fixture, 'Before');
    const beforeSuccess = getProjectSnapshot(successId);

    const successResult = await serviceClient.rpc('update_project_metadata', makeParameters(successId, fixture, beforeSuccess.updatedAt, 'Successful atomic save')) as RpcResult;
    const successResponse = assertRpcCode(successResult, 'SUCCESS', 'Atomic success');
    const committedSuccess = getProjectSnapshot(successId);
    const expectedSuccess = snapshotFromSuccessfulResponse(successResponse, beforeSuccess);
    assertSnapshotEqual(committedSuccess, expectedSuccess, 'Atomic success');
    if (committedSuccess.groupName !== 'unrelated field') throw new Error('Atomic success changed an unrelated field.');

    const staleResult = await serviceClient.rpc('update_project_metadata', makeParameters(successId, fixture, beforeSuccess.updatedAt, 'Stale save')) as RpcResult;
    assertRpcCode(staleResult, 'STALE_VERSION', 'Stale save');
    assertSnapshotEqual(getProjectSnapshot(successId), committedSuccess, 'Stale save');

    const invalidCases: Array<{ name: string; parameters: MetadataRpcParameters }> = [
      { name: 'program', parameters: { ...makeParameters(successId, fixture, committedSuccess.updatedAt, 'Invalid program'), p_program_id: '00000000-0000-0000-0000-000000000000' } },
      { name: 'discipline', parameters: { ...makeParameters(successId, fixture, committedSuccess.updatedAt, 'Invalid discipline'), p_discipline_ids: ['00000000-0000-0000-0000-000000000000'] } },
      { name: 'industry category', parameters: { ...makeParameters(successId, fixture, committedSuccess.updatedAt, 'Invalid category'), p_industry_category_ids: ['00000000-0000-0000-0000-000000000000'] } },
    ];
    for (const invalidCase of invalidCases) {
      const invalidResult = await serviceClient.rpc('update_project_metadata', invalidCase.parameters) as RpcResult;
      assertRpcCode(invalidResult, 'VALIDATION_FAILED', `Invalid ${invalidCase.name}`);
      assertSnapshotEqual(getProjectSnapshot(successId), committedSuccess, `Invalid ${invalidCase.name}`);
    }

    const reviewerDeniedResult = await serviceClient.rpc('update_project_metadata', makeParameters(successId, fixture, committedSuccess.updatedAt, 'Reviewer edit', fixture.disciplineIds, fixture.industryCategoryIds, fixture.reviewerUserId)) as RpcResult;
    assertRpcCode(reviewerDeniedResult, 'PERMISSION_DENIED', 'Reviewer should be denied');
    assertSnapshotEqual(getProjectSnapshot(successId), committedSuccess, 'Reviewer denied');

    const noChangesParams = makeParameters(successId, fixture, committedSuccess.updatedAt, expectedSuccess.title, expectedSuccess.disciplineIds, expectedSuccess.industryCategoryIds);
    // Explicitly make the string fields exactly match the committed state
    noChangesParams.p_summary = expectedSuccess.summary;
    noChangesParams.p_background = expectedSuccess.background;
    noChangesParams.p_solution = expectedSuccess.solution;
    noChangesParams.p_year = expectedSuccess.year;
    
    const noChangesResult = await serviceClient.rpc('update_project_metadata', noChangesParams) as RpcResult;
    assertRpcCode(noChangesResult, 'NO_CHANGES', 'Exact no-op should return NO_CHANGES');
    assertSnapshotEqual(getProjectSnapshot(successId), committedSuccess, 'Exact no-op shouldn\'t modify record');

    seedProject(failureId, fixture, 'Atomic before');
    const beforeFailure = getProjectSnapshot(failureId);
    executeLocalSql(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'FORCED_METADATA_MAPPING_FAILURE'; END; $fn$;`);
    executeLocalSql(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.project_industry_categories FOR EACH ROW EXECUTE FUNCTION public.${functionName}();`);
    const forcedFailure = await serviceClient.rpc('update_project_metadata', makeParameters(failureId, fixture, beforeFailure.updatedAt, 'Atomic after')) as RpcResult;
    if (!forcedFailure.error || !forcedFailure.error.message.includes('FORCED_METADATA_MAPPING_FAILURE')) {
      throw new Error('Forced metadata mapping failure did not occur after the earlier RPC writes.');
    }
    assertSnapshotEqual(getProjectSnapshot(failureId), beforeFailure, 'Forced transactional failure');
    executeLocalSql(`DROP TRIGGER ${triggerName} ON public.project_industry_categories; DROP FUNCTION public.${functionName}();`);

    seedProject(concurrentId, fixture, 'Concurrent before');
    const beforeConcurrent = getProjectSnapshot(concurrentId);
    const concurrentClientA = createServiceClient();
    const concurrentClientB = createServiceClient();
    const [concurrentA, concurrentB] = await Promise.all([
      concurrentClientA.rpc('update_project_metadata', makeParameters(concurrentId, fixture, beforeConcurrent.updatedAt, 'Concurrent save A')).then((result) => result as RpcResult),
      concurrentClientB.rpc('update_project_metadata', makeParameters(concurrentId, fixture, beforeConcurrent.updatedAt, 'Concurrent save B', [fixture.disciplineIds[0]], [fixture.industryCategoryIds[0]])).then((result) => result as RpcResult),
    ]);
    const concurrentOutcome = evaluateConcurrentSaveResults([concurrentA, concurrentB]);
    const concurrentCommitted = getProjectSnapshot(concurrentId);
    assertSnapshotEqual(concurrentCommitted, snapshotFromSuccessfulResponse(concurrentOutcome.successfulResponse, beforeConcurrent), 'Concurrent save winner');

    const privilegeParameters = makeParameters(successId, fixture, committedSuccess.updatedAt, 'Forbidden role invocation');
    const privilegeSql = `SELECT public.update_project_metadata('${privilegeParameters.p_public_id}', '${privilegeParameters.p_title}', '${privilegeParameters.p_summary}', '${privilegeParameters.p_background}', '${privilegeParameters.p_solution}', ${privilegeParameters.p_year}, '${privilegeParameters.p_program_id}'::uuid, ARRAY[${privilegeParameters.p_discipline_ids.map((id) => `'${id}'::uuid`).join(', ')}], ARRAY[${privilegeParameters.p_industry_category_ids.map((id) => `'${id}'::uuid`).join(', ')}], '${privilegeParameters.p_expected_updated_at}'::timestamptz, '${privilegeParameters.p_admin_id}'::uuid);`;
    let anonDenied = false;
    let authenticatedDenied = false;
    executeLocalSqlExpectingPermissionDenial('anon', privilegeSql); anonDenied = true;
    executeLocalSqlExpectingPermissionDenial('authenticated', privilegeSql); authenticatedDenied = true;
    assertRuntimePrivilegeResults({ serviceRole: successResult, anonDenied, authenticatedDenied });

  } catch (error) {
    verifierError = error;
  } finally {
    try {
      cleanupRuntimeArtifacts(projectIds, triggerName, functionName);
    } catch (cleanupError) {
      throw cleanupError;
    }
  }
  if (verifierError) throw verifierError;
  console.log('Project metadata runtime verification passed (SUCCESS=1, STALE_VERSION=1, PERMISSION_DENIED, NO_CHANGES, forced rollback, service-role execution, anon/authenticated denial, cleanup verified).');
}

if (require.main === module) {
  verifyProjectMetadataRuntime().catch((error) => {
    console.error('Project metadata runtime verification failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
