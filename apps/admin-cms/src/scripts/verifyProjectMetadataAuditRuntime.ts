import { createClient } from '@supabase/supabase-js';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

type MetadataRpcResponse = {
  resultCode?: string;
  auditRecordId?: string;
};

type RpcResult = { data: MetadataRpcResponse | null; error: { message: string } | null };

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
    throw new Error(`Local metadata audit runtime query failed: ${detail}`);
  }
}

function queryLocalJson<T>(sql: string): T {
  const output = executeLocalSql(sql).trim();
  if (!output) throw new Error('Local metadata audit runtime query returned no result.');
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error('Local metadata audit runtime query returned malformed JSON.');
  }
}

type LookupFixture = {
  programId: string;
  disciplineIds: string[];
  industryCategoryIds: string[];
  adminUserId: string;
  adminFullName: string;
  adminEmail: string;
};

function getLookupFixture(): LookupFixture {
  executeLocalSql(`
    INSERT INTO public.admin_users (id, email, full_name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'admin@example.com', 'Admin User') ON CONFLICT DO NOTHING;
    INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000a1', 'admin') ON CONFLICT DO NOTHING;
  `);

  const fixture = queryLocalJson<LookupFixture>(`
    SELECT pg_catalog.jsonb_build_object(
      'programId', (SELECT id::text FROM public.programs ORDER BY name LIMIT 1),
      'disciplineIds', ARRAY(SELECT id::text FROM public.disciplines ORDER BY name LIMIT 2),
      'industryCategoryIds', ARRAY(SELECT id::text FROM public.industry_categories ORDER BY name LIMIT 2),
      'adminUserId', (SELECT id::text FROM public.admin_users au WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = au.id AND ur.role = 'admin') LIMIT 1),
      'adminFullName', (SELECT full_name FROM public.admin_users au WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = au.id AND ur.role = 'admin') LIMIT 1),
      'adminEmail', (SELECT email FROM public.admin_users au WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = au.id AND ur.role = 'admin') LIMIT 1)
    )
  `);
  if (!fixture.programId || fixture.disciplineIds.length < 2 || fixture.industryCategoryIds.length < 2 || !fixture.adminUserId) {
    throw new Error('Local metadata runtime requires one program, two discipline/category fixtures, and an admin.');
  }
  return fixture;
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

export async function verifyProjectMetadataAuditRuntime(): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const publicId = `audit-runtime-${suffix}`;
  let verifierError: unknown;

  try {
    const fixture = getLookupFixture();
    const serviceClient = createServiceClient();
    
    executeLocalSql(`
      DO $$
      DECLARE project_id uuid;
      BEGIN
        INSERT INTO public.projects (public_id, title, summary, background, solution, year, program_id, program_name, discipline, industry, group_name)
        VALUES ('${publicId}', 'Original Title', 'Original summary', 'Original background', 'Original solution', 2025, '${fixture.programId}'::uuid, 'legacy', 'legacy', 'legacy', 'unrelated field')
        RETURNING id INTO project_id;
        INSERT INTO public.project_disciplines (project_id, discipline_id) VALUES (project_id, '${fixture.disciplineIds[0]}'::uuid);
        INSERT INTO public.project_industry_categories (project_id, industry_category_id) VALUES (project_id, '${fixture.industryCategoryIds[0]}'::uuid);
      END $$;
    `);

    const initial = queryLocalJson<{ updatedAt: string }>(`SELECT pg_catalog.jsonb_build_object('updatedAt', updated_at) FROM public.projects WHERE public_id = '${publicId}'`);

    const update1 = await serviceClient.rpc('update_project_metadata', {
      p_public_id: publicId,
      p_title: 'Changed Title',
      p_summary: 'Changed summary',
      p_background: 'Original background',
      p_solution: 'Original solution',
      p_year: 2025,
      p_program_id: fixture.programId,
      p_discipline_ids: fixture.disciplineIds,
      p_industry_category_ids: [fixture.industryCategoryIds[1]],
      p_expected_updated_at: initial.updatedAt,
      p_admin_id: fixture.adminUserId,
    }) as RpcResult;

    if (update1.error || update1.data?.resultCode !== 'SUCCESS') throw new Error('Update 1 failed');
    
    const audit1Id = update1.data.auditRecordId;
    if (!audit1Id) throw new Error('No audit record ID returned');

    const audit1 = queryLocalJson<{ action_taken: string; actor_full_name_snapshot: string; actor_email_snapshot: string; event_details: { version: number; type: string; changedFields: string[] } }>(`
      SELECT pg_catalog.jsonb_build_object(
        'action_taken', action_taken,
        'actor_full_name_snapshot', actor_full_name_snapshot,
        'actor_email_snapshot', actor_email_snapshot,
        'event_details', event_details
      ) FROM public.approval_records WHERE id = '${audit1Id}'
    `);

    if (audit1.action_taken !== 'update_metadata') throw new Error('Audit1: incorrect action');
    if (audit1.actor_full_name_snapshot !== fixture.adminFullName) throw new Error('Audit1: incorrect actor name snapshot');
    if (audit1.actor_email_snapshot !== fixture.adminEmail) throw new Error('Audit1: incorrect actor email snapshot');
    
    const details = audit1.event_details;
    if (details.version !== 1 || details.type !== 'project_metadata') throw new Error('Audit1: incorrect event details shape');
    const expectedChanges = ['title', 'summary', 'disciplines', 'industryCategories'];
    if (details.changedFields.length !== 4 || !expectedChanges.every(c => details.changedFields.includes(c))) throw new Error(`Audit1: expected [${expectedChanges.join(',')}], got ${details.changedFields}`);

    const state2 = queryLocalJson<{ updatedAt: string }>(`SELECT pg_catalog.jsonb_build_object('updatedAt', updated_at) FROM public.projects WHERE public_id = '${publicId}'`);
    const update2Noop = await serviceClient.rpc('update_project_metadata', {
      p_public_id: publicId,
      p_title: 'Changed Title',
      p_summary: 'Changed summary',
      p_background: 'Original background',
      p_solution: 'Original solution',
      p_year: 2025,
      p_program_id: fixture.programId,
      p_discipline_ids: [fixture.disciplineIds[1], fixture.disciplineIds[0]], // Re-order
      p_industry_category_ids: [fixture.industryCategoryIds[1]],
      p_expected_updated_at: state2.updatedAt,
      p_admin_id: fixture.adminUserId,
    }) as RpcResult;

    if (update2Noop.data?.resultCode !== 'NO_CHANGES') throw new Error('Update 2 NOOP failed: ' + update2Noop.data?.resultCode);
    
    const auditCount = queryLocalJson<{ c: number }>(`SELECT pg_catalog.jsonb_build_object('c', count(*)) FROM public.approval_records WHERE project_id = (SELECT id FROM public.projects WHERE public_id = '${publicId}')`);
    if (auditCount.c !== 1) throw new Error('Audit count should be 1 after NO-OP');

  } catch (error) {
    verifierError = error;
  } finally {
    try {
      executeLocalSql(`
        DELETE FROM public.approval_records WHERE project_id IN (SELECT id FROM public.projects WHERE public_id = '${publicId}');
        DELETE FROM public.project_disciplines WHERE project_id IN (SELECT id FROM public.projects WHERE public_id = '${publicId}');
        DELETE FROM public.project_industry_categories WHERE project_id IN (SELECT id FROM public.projects WHERE public_id = '${publicId}');
        DELETE FROM public.projects WHERE public_id = '${publicId}';
      `);
    } catch (cleanupError) {
      throw cleanupError;
    }
  }
  if (verifierError) throw verifierError;
  console.log('Project metadata audit runtime verification passed.');
}

if (require.main === module) {
  verifyProjectMetadataAuditRuntime().catch((error) => {
    console.error('Project metadata audit runtime verification failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
