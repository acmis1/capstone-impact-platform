import { createClient } from '@supabase/supabase-js';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { projectMetadataInputSchema } from '../projects/projectMetadata';
import { metadataResponseSchema } from '../projects/projectMetadataService';

type MetadataView = {
  publicId: string;
  title: string;
  summary: string;
  background: string;
  solution: string;
  year: string;
  programId: string;
  disciplineIds: string[];
  industryCategoryIds: string[];
  expectedUpdatedAt: string;
};

type MetadataRpcResponse = {
  resultCode?: string;
  auditRecordId?: string;
  metadata?: MetadataView;
};

type RpcResult = { data: MetadataRpcResponse | null; error: { message: string } | null };

type MetadataRpcParameters = {
  p_public_id: string;
  p_title: string;
  p_summary: string;
  p_background: string | null;
  p_solution: string | null;
  p_year: number;
  p_program_id: string;
  p_discipline_ids: string[];
  p_industry_category_ids: string[];
  p_expected_updated_at: string;
  p_admin_id: string;
};

type NamedLookup = { id: string; name: string };
type ActorFixture = { id: string; fullName: string; email: string };
type RuntimeFixture = {
  programs: [NamedLookup, NamedLookup];
  disciplines: [NamedLookup, NamedLookup];
  industries: [NamedLookup, NamedLookup];
  admin: ActorFixture;
  editor: ActorFixture;
  reviewer: ActorFixture;
  dual: ActorFixture;
  retention: ActorFixture;
};

type ProjectState = {
  id: string;
  status: string;
  title: string;
  summary: string;
  background: string | null;
  solution: string | null;
  year: number;
  programId: string;
  programName: string | null;
  discipline: string | null;
  industry: string | null;
  updatedAt: string;
  disciplines: string[];
  industries: string[];
  audits: number;
};

type AuditEventDetails = {
  version: number;
  type: string;
  changedFields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

type AuditRow = {
  id: string;
  adminId: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: string;
  actorFullName: string | null;
  actorEmail: string | null;
  eventDetails: AuditEventDetails | null;
};

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LOCAL_DB_CONTAINER = 'supabase_db_capstone-impact-platform';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

function createServiceClient() {
  const cliPath = path.resolve(REPO_ROOT, 'node_modules/.bin/supabase');
  const output = execSync(`"${cliPath}" status --workdir "${path.resolve(REPO_ROOT, 'infra')}" -o env`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const localEnv = parseSupabaseCliEnv(output);
  if (!localEnv.API_URL || !localEnv.SERVICE_ROLE_KEY || !isLoopbackUrl(localEnv.API_URL)) {
    throw new Error('Metadata audit verifier requires a loopback-only local Supabase service-role client.');
  }
  return createClient(localEnv.API_URL, localEnv.SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function createFixture(prefix: string): RuntimeFixture {
  const named = (kind: string, index: number): NamedLookup => ({
    id: randomUUID(),
    name: `${prefix} ${kind} ${index}`,
  });
  const actor = (kind: string): ActorFixture => ({
    id: randomUUID(),
    fullName: `${prefix} ${kind}`,
    email: `${prefix}-${kind.toLowerCase()}@example.test`,
  });
  const fixture: RuntimeFixture = {
    programs: [named('Program', 1), named('Program', 2)],
    disciplines: [named('Discipline', 1), named('Discipline', 2)],
    industries: [named('Industry', 1), named('Industry', 2)],
    admin: actor('Admin'),
    editor: actor('Editor'),
    reviewer: actor('Reviewer'),
    dual: actor('Dual'),
    retention: actor('Retention'),
  };
  const lookups = [...fixture.programs, ...fixture.disciplines, ...fixture.industries];
  executeLocalSql(`
    INSERT INTO public.programs(id, name) VALUES
      ('${lookups[0].id}'::uuid, ${sqlText(lookups[0].name)}),
      ('${lookups[1].id}'::uuid, ${sqlText(lookups[1].name)});
    INSERT INTO public.disciplines(id, name) VALUES
      ('${lookups[2].id}'::uuid, ${sqlText(lookups[2].name)}),
      ('${lookups[3].id}'::uuid, ${sqlText(lookups[3].name)});
    INSERT INTO public.industry_categories(id, name) VALUES
      ('${lookups[4].id}'::uuid, ${sqlText(lookups[4].name)}),
      ('${lookups[5].id}'::uuid, ${sqlText(lookups[5].name)});
    INSERT INTO public.admin_users(id, email, full_name) VALUES
      ('${fixture.admin.id}'::uuid, ${sqlText(fixture.admin.email)}, ${sqlText(fixture.admin.fullName)}),
      ('${fixture.editor.id}'::uuid, ${sqlText(fixture.editor.email)}, ${sqlText(fixture.editor.fullName)}),
      ('${fixture.reviewer.id}'::uuid, ${sqlText(fixture.reviewer.email)}, ${sqlText(fixture.reviewer.fullName)}),
      ('${fixture.dual.id}'::uuid, ${sqlText(fixture.dual.email)}, ${sqlText(fixture.dual.fullName)}),
      ('${fixture.retention.id}'::uuid, ${sqlText(fixture.retention.email)}, ${sqlText(fixture.retention.fullName)});
    INSERT INTO public.user_roles(user_id, role) VALUES
      ('${fixture.admin.id}'::uuid, 'admin'),
      ('${fixture.editor.id}'::uuid, 'editor'),
      ('${fixture.reviewer.id}'::uuid, 'reviewer'),
      ('${fixture.dual.id}'::uuid, 'editor'),
      ('${fixture.dual.id}'::uuid, 'reviewer'),
      ('${fixture.retention.id}'::uuid, 'editor');
  `);
  return fixture;
}

function seedProject(
  prefix: string,
  label: string,
  fixture: RuntimeFixture,
  options: {
    status?: string;
    background?: string | null;
    solution?: string | null;
    disciplineIds?: string[];
    industryIds?: string[];
  } = {},
): string {
  const publicId = `${prefix}-${label}`;
  const disciplineIds = options.disciplineIds ?? [fixture.disciplines[0].id];
  const industryIds = options.industryIds ?? [fixture.industries[0].id];
  const background = options.background === undefined ? 'Original background' : options.background;
  const solution = options.solution === undefined ? 'Original solution' : options.solution;
  executeLocalSql(`
    WITH inserted AS (
      INSERT INTO public.projects(
        public_id, title, summary, background, solution, year, program_id, program_name,
        discipline, industry, group_name, status
      ) VALUES (
        ${sqlText(publicId)}, 'Original Title', 'Original summary', ${sqlText(background)},
        ${sqlText(solution)}, 2026, '${fixture.programs[0].id}'::uuid,
        ${sqlText(fixture.programs[0].name)}, ${sqlText(fixture.disciplines[0].name)},
        ${sqlText(fixture.industries[0].name)}, 'Unrelated group', ${sqlText(options.status ?? 'draft')}
      ) RETURNING id
    )
    INSERT INTO public.project_disciplines(project_id, discipline_id)
    SELECT inserted.id, x FROM inserted CROSS JOIN pg_catalog.unnest(ARRAY[${disciplineIds.map((id) => `'${id}'::uuid`).join(',')}]) x;
    INSERT INTO public.project_industry_categories(project_id, industry_category_id)
    SELECT p.id, x FROM public.projects p CROSS JOIN pg_catalog.unnest(ARRAY[${industryIds.map((id) => `'${id}'::uuid`).join(',')}]) x
    WHERE p.public_id = ${sqlText(publicId)};
  `);
  return publicId;
}

function projectState(publicId: string): ProjectState {
  return queryLocalJson<ProjectState>(`
    SELECT pg_catalog.jsonb_build_object(
      'id', p.id::text,
      'status', p.status,
      'title', p.title,
      'summary', p.summary,
      'background', p.background,
      'solution', p.solution,
      'year', p.year,
      'programId', p.program_id::text,
      'programName', p.program_name,
      'discipline', p.discipline,
      'industry', p.industry,
      'updatedAt', p.updated_at,
      'disciplines', (SELECT coalesce(pg_catalog.jsonb_agg(pd.discipline_id::text ORDER BY pd.discipline_id), '[]'::jsonb) FROM public.project_disciplines pd WHERE pd.project_id = p.id),
      'industries', (SELECT coalesce(pg_catalog.jsonb_agg(pic.industry_category_id::text ORDER BY pic.industry_category_id), '[]'::jsonb) FROM public.project_industry_categories pic WHERE pic.project_id = p.id),
      'audits', (SELECT pg_catalog.count(*) FROM public.approval_records ar WHERE ar.project_id = p.id)
    ) FROM public.projects p WHERE p.public_id = ${sqlText(publicId)}
  `);
}

function auditRows(publicId: string): AuditRow[] {
  return queryLocalJson<AuditRow[]>(`
    SELECT coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', ar.id::text,
        'adminId', ar.admin_id::text,
        'action', ar.action_taken,
        'fromStatus', ar.from_status,
        'toStatus', ar.to_status,
        'createdAt', ar.created_at,
        'actorFullName', ar.actor_full_name_snapshot,
        'actorEmail', ar.actor_email_snapshot,
        'eventDetails', ar.event_details
      ) ORDER BY ar.created_at DESC, ar.id DESC
    ), '[]'::jsonb)
    FROM public.approval_records ar
    JOIN public.projects p ON p.id = ar.project_id
    WHERE p.public_id = ${sqlText(publicId)}
  `);
}

function makeParameters(
  publicId: string,
  fixture: RuntimeFixture,
  actorAdminId: string,
  patch: Partial<MetadataRpcParameters> = {},
): MetadataRpcParameters {
  const current = projectState(publicId);
  return {
    p_public_id: publicId,
    p_title: current.title,
    p_summary: current.summary,
    p_background: current.background,
    p_solution: current.solution,
    p_year: current.year,
    p_program_id: current.programId,
    p_discipline_ids: current.disciplines,
    p_industry_category_ids: current.industries,
    p_expected_updated_at: current.updatedAt,
    p_admin_id: actorAdminId,
    ...patch,
  };
}

function expectCode(result: RpcResult, code: string, label: string): MetadataRpcResponse {
  assert(!result.error, `${label} returned an RPC error.`);
  assert(result.data?.resultCode === code, `${label} expected ${code}, received ${result.data?.resultCode ?? 'no result'}.`);
  return result.data;
}

function assertUnchanged(before: ProjectState, after: ProjectState, label: string): void {
  assert(JSON.stringify(after) === JSON.stringify(before), `${label} changed project, relationship, version, or audit state.`);
}

function executeAsRoleExpectingPermissionDenial(role: 'anon' | 'authenticated', sql: string): void {
  try {
    executeLocalSql(`SET ROLE ${role}; ${sql}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : '';
    if (detail.includes('permission denied')) return;
    throw new Error(`${role} execution failed for an unexpected reason.`);
  }
  throw new Error(`${role} unexpectedly executed update_project_metadata.`);
}

function directFunctionSql(parameters: MetadataRpcParameters): string {
  return `SELECT public.update_project_metadata(
    ${sqlText(parameters.p_public_id)}, ${sqlText(parameters.p_title)}, ${sqlText(parameters.p_summary)},
    ${sqlText(parameters.p_background)}, ${sqlText(parameters.p_solution)}, ${parameters.p_year},
    '${parameters.p_program_id}'::uuid, ARRAY[${parameters.p_discipline_ids.map((id) => `'${id}'::uuid`).join(',')}],
    ARRAY[${parameters.p_industry_category_ids.map((id) => `'${id}'::uuid`).join(',')}],
    '${parameters.p_expected_updated_at}'::timestamptz, '${parameters.p_admin_id}'::uuid
  );`;
}

export async function verifyProjectMetadataAuditRuntime(): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const prefix = `audit-${suffix}`;
  const mappingTrigger = `verify_metadata_mapping_${suffix}`;
  const mappingFunction = `verify_metadata_mapping_${suffix}_fn`;
  const auditTrigger = `verify_metadata_audit_${suffix}`;
  const auditFunction = `verify_metadata_audit_${suffix}_fn`;
  const serviceClient = createServiceClient();
  let fixture: RuntimeFixture | null = null;
  let verifierError: unknown;
  let scenarioCount = 0;

  const scenario = async (number: number, name: string, verification: () => void | Promise<void>) => {
    assert(number === scenarioCount + 1, `Scenario numbering skipped before ${number}.`);
    await verification();
    scenarioCount = number;
    console.log(`PASS ${number}: ${name}`);
  };

  try {
    fixture = createFixture(prefix);

    const adminProject = seedProject(prefix, 'admin-title', fixture);
    const adminBefore = projectState(adminProject);
    const adminResult = await serviceClient.rpc('update_project_metadata', makeParameters(
      adminProject,
      fixture,
      fixture.admin.id,
      { p_title: 'Admin revised title' },
    )) as RpcResult;
    const adminResponse = expectCode(adminResult, 'SUCCESS', 'Admin title change');
    const adminAudits = auditRows(adminProject);
    const adminAudit = adminAudits[0];
    await scenario(1, 'Admin title change succeeds', () => {
      assert(projectState(adminProject).title === 'Admin revised title' && Boolean(adminResponse.auditRecordId), 'Admin title was not committed.');
    });
    await scenario(2, 'Exactly one update_metadata audit row is created', () => {
      assert(adminAudits.length === 1 && adminAudit.action === 'update_metadata', 'Admin save did not create exactly one metadata audit.');
    });
    await scenario(3, 'admin_id matches authoritative Admin', () => {
      assert(adminAudit.adminId === fixture!.admin.id, 'Audit admin_id does not match the server-supplied authoritative actor.');
    });
    await scenario(4, 'actor_full_name_snapshot is correct', () => {
      assert(adminAudit.actorFullName === fixture!.admin.fullName, 'Actor full-name snapshot is incorrect.');
    });
    await scenario(5, 'actor_email_snapshot is correct', () => {
      assert(adminAudit.actorEmail === fixture!.admin.email, 'Actor email snapshot is incorrect.');
    });
    await scenario(6, 'from_status equals current status', () => {
      assert(adminAudit.fromStatus === adminBefore.status, 'Metadata audit from_status is incorrect.');
    });
    await scenario(7, 'to_status equals current status', () => {
      assert(adminAudit.toStatus === adminBefore.status, 'Metadata audit to_status is incorrect.');
    });
    await scenario(8, 'changedFields is exactly title for title-only mutation', () => {
      assert(JSON.stringify(adminAudit.eventDetails?.changedFields) === JSON.stringify(['title']), 'Title-only changedFields is not exact.');
    });
    await scenario(9, 'before.title is correct', () => {
      assert(adminAudit.eventDetails?.before.title === adminBefore.title, 'before.title is incorrect.');
    });
    await scenario(10, 'after.title is correct', () => {
      assert(adminAudit.eventDetails?.after.title === 'Admin revised title', 'after.title is incorrect.');
    });

    const editorProject = seedProject(prefix, 'editor', fixture);
    const editorResult = await serviceClient.rpc('update_project_metadata', makeParameters(editorProject, fixture, fixture.editor.id, { p_title: 'Editor revised title' })) as RpcResult;
    await scenario(11, 'Editor-only actor may edit and is audited', () => {
      expectCode(editorResult, 'SUCCESS', 'Editor save');
      const rows = auditRows(editorProject);
      assert(rows.length === 1 && rows[0].adminId === fixture!.editor.id, 'Editor save was not attributed exactly once.');
    });

    const reviewerProject = seedProject(prefix, 'reviewer', fixture);
    const reviewerBefore = projectState(reviewerProject);
    const reviewerResult = await serviceClient.rpc('update_project_metadata', makeParameters(reviewerProject, fixture, fixture.reviewer.id, { p_title: 'Reviewer blocked title' })) as RpcResult;
    await scenario(12, 'Reviewer-only actor receives PERMISSION_DENIED and zero audit', () => {
      expectCode(reviewerResult, 'PERMISSION_DENIED', 'Reviewer save');
      assertUnchanged(reviewerBefore, projectState(reviewerProject), 'Reviewer denial');
    });

    const dualProject = seedProject(prefix, 'dual', fixture);
    const dualResult = await serviceClient.rpc('update_project_metadata', makeParameters(dualProject, fixture, fixture.dual.id, { p_title: 'Dual revised title' })) as RpcResult;
    await scenario(13, 'Editor and Reviewer actor may edit and creates exactly one audit', () => {
      expectCode(dualResult, 'SUCCESS', 'Dual-role save');
      const rows = auditRows(dualProject);
      assert(rows.length === 1 && rows[0].adminId === fixture!.dual.id, 'Dual-role save audit is incorrect.');
    });

    const multiProject = seedProject(prefix, 'multi', fixture);
    const multiResult = await serviceClient.rpc('update_project_metadata', makeParameters(multiProject, fixture, fixture.admin.id, {
      p_title: 'Multi title',
      p_summary: 'Multi summary',
      p_background: 'Multi background',
      p_solution: 'Multi solution',
      p_year: 2027,
      p_program_id: fixture.programs[1].id,
      p_discipline_ids: [fixture.disciplines[1].id],
      p_industry_category_ids: [fixture.industries[1].id],
    })) as RpcResult;
    const multiAudits = auditRows(multiProject);
    const multiDetails = multiAudits[0].eventDetails!;
    await scenario(14, 'Multi-field mutation creates one audit containing every real changed field', () => {
      expectCode(multiResult, 'SUCCESS', 'Multi-field save');
      assert(multiAudits.length === 1, 'Multi-field save created an incorrect audit count.');
      assert(JSON.stringify(multiDetails.changedFields) === JSON.stringify([
        'title', 'summary', 'background', 'solution', 'year', 'program', 'disciplines', 'industryCategories',
      ]), 'Multi-field changedFields is incomplete or non-deterministic.');
    });
    await scenario(15, 'Program change captures old and new ID and human-readable name', () => {
      assert(JSON.stringify(multiDetails.before.program) === JSON.stringify(fixture!.programs[0]), 'Old program snapshot is incorrect.');
      assert(JSON.stringify(multiDetails.after.program) === JSON.stringify(fixture!.programs[1]), 'New program snapshot is incorrect.');
    });
    await scenario(16, 'Discipline change captures deterministic human-readable snapshots', () => {
      assert(JSON.stringify(multiDetails.before.disciplines) === JSON.stringify([fixture!.disciplines[0]]), 'Old discipline snapshot is incorrect.');
      assert(JSON.stringify(multiDetails.after.disciplines) === JSON.stringify([fixture!.disciplines[1]]), 'New discipline snapshot is incorrect.');
    });
    await scenario(17, 'Industry change captures deterministic human-readable snapshots', () => {
      assert(JSON.stringify(multiDetails.before.industryCategories) === JSON.stringify([fixture!.industries[0]]), 'Old industry snapshot is incorrect.');
      assert(JSON.stringify(multiDetails.after.industryCategories) === JSON.stringify([fixture!.industries[1]]), 'New industry snapshot is incorrect.');
    });

    const disciplineReorder = seedProject(prefix, 'discipline-reorder', fixture, {
      disciplineIds: fixture.disciplines.map((item) => item.id),
    });
    const disciplineReorderBefore = projectState(disciplineReorder);
    const disciplineReorderResult = await serviceClient.rpc('update_project_metadata', makeParameters(disciplineReorder, fixture, fixture.admin.id, {
      p_discipline_ids: [...disciplineReorderBefore.disciplines].reverse(),
    })) as RpcResult;
    await scenario(18, 'Discipline input order-only save is a mutation-free NO_CHANGES', () => {
      const response = expectCode(disciplineReorderResult, 'NO_CHANGES', 'Discipline reorder');
      assert(metadataResponseSchema.safeParse(response.metadata).success, 'Discipline reorder returned an invalid production metadata payload.');
      assertUnchanged(disciplineReorderBefore, projectState(disciplineReorder), 'Discipline reorder');
    });

    const industryReorder = seedProject(prefix, 'industry-reorder', fixture, {
      industryIds: fixture.industries.map((item) => item.id),
    });
    const industryReorderBefore = projectState(industryReorder);
    const industryReorderResult = await serviceClient.rpc('update_project_metadata', makeParameters(industryReorder, fixture, fixture.admin.id, {
      p_industry_category_ids: [...industryReorderBefore.industries].reverse(),
    })) as RpcResult;
    await scenario(19, 'Industry input order-only save is a mutation-free NO_CHANGES', () => {
      expectCode(industryReorderResult, 'NO_CHANGES', 'Industry reorder');
      assertUnchanged(industryReorderBefore, projectState(industryReorder), 'Industry reorder');
    });

    const reorderTitle = seedProject(prefix, 'reorder-title', fixture, {
      disciplineIds: fixture.disciplines.map((item) => item.id),
      industryIds: fixture.industries.map((item) => item.id),
    });
    const reorderTitleBefore = projectState(reorderTitle);
    const reorderTitleResult = await serviceClient.rpc('update_project_metadata', makeParameters(reorderTitle, fixture, fixture.admin.id, {
      p_title: 'Only title changed',
      p_discipline_ids: [...reorderTitleBefore.disciplines].reverse(),
      p_industry_category_ids: [...reorderTitleBefore.industries].reverse(),
    })) as RpcResult;
    await scenario(20, 'Reorder plus title mutation audits only title and preserves legacy scalars', () => {
      expectCode(reorderTitleResult, 'SUCCESS', 'Reorder plus title');
      const after = projectState(reorderTitle);
      assert(JSON.stringify(auditRows(reorderTitle)[0].eventDetails?.changedFields) === JSON.stringify(['title']), 'Reorder plus title produced false changed fields.');
      assert(after.discipline === reorderTitleBefore.discipline && after.industry === reorderTitleBefore.industry, 'Reorder plus title changed legacy lookup scalars.');
    });

    const noOpProject = seedProject(prefix, 'exact-noop', fixture, { background: null, solution: null });
    const noOpBefore = projectState(noOpProject);
    const noOpResult = await serviceClient.rpc('update_project_metadata', makeParameters(noOpProject, fixture, fixture.admin.id)) as RpcResult;
    await scenario(21, 'Exact no-op returns valid normalized metadata with unchanged version and zero audit', () => {
      const response = expectCode(noOpResult, 'NO_CHANGES', 'Exact no-op');
      const parsed = metadataResponseSchema.safeParse(response.metadata);
      assert(parsed.success, 'NO_CHANGES metadata failed the exact production response schema.');
      assert(parsed.data.background === '' && parsed.data.solution === '', 'NO_CHANGES did not normalize nullable long text.');
      assertUnchanged(noOpBefore, projectState(noOpProject), 'Exact no-op');
    });

    const staleProject = seedProject(prefix, 'stale', fixture);
    const staleBefore = projectState(staleProject);
    const winner = await serviceClient.rpc('update_project_metadata', makeParameters(staleProject, fixture, fixture.admin.id, { p_title: 'Winner title' })) as RpcResult;
    expectCode(winner, 'SUCCESS', 'Stale winner');
    const staleResult = await serviceClient.rpc('update_project_metadata', makeParameters(staleProject, fixture, fixture.admin.id, {
      p_title: 'Loser title',
      p_expected_updated_at: staleBefore.updatedAt,
    })) as RpcResult;
    await scenario(22, 'Stale version creates zero new audit and preserves winner values', () => {
      expectCode(staleResult, 'STALE_VERSION', 'Stale loser');
      const after = projectState(staleProject);
      assert(after.title === 'Winner title' && after.audits === 1, 'Stale loser changed winner state or created an audit.');
    });

    const validationProject = seedProject(prefix, 'validation', fixture);
    const validationBefore = projectState(validationProject);
    const validationResult = await serviceClient.rpc('update_project_metadata', makeParameters(validationProject, fixture, fixture.admin.id, {
      p_program_id: '00000000-0000-0000-0000-000000000000',
    })) as RpcResult;
    await scenario(23, 'Validation failure creates zero audit', () => {
      expectCode(validationResult, 'VALIDATION_FAILED', 'Invalid program');
      assertUnchanged(validationBefore, projectState(validationProject), 'Validation failure');
    });

    const approvedProject = seedProject(prefix, 'approved', fixture, { status: 'approved' });
    const approvedBefore = projectState(approvedProject);
    const approvedResult = await serviceClient.rpc('update_project_metadata', makeParameters(approvedProject, fixture, fixture.admin.id, { p_title: 'Blocked approved title' })) as RpcResult;
    await scenario(24, 'Approved project requires reopening and creates zero audit', () => {
      expectCode(approvedResult, 'APPROVAL_REOPEN_REQUIRED', 'Approved save');
      assertUnchanged(approvedBefore, projectState(approvedProject), 'Approved rejection');
    });

    const publishedProject = seedProject(prefix, 'published', fixture, { status: 'published' });
    const publishedBefore = projectState(publishedProject);
    const publishedResult = await serviceClient.rpc('update_project_metadata', makeParameters(publishedProject, fixture, fixture.admin.id, { p_title: 'Blocked published title' })) as RpcResult;
    await scenario(25, 'Published project is locked and creates zero audit', () => {
      expectCode(publishedResult, 'PUBLISHED_PROJECT_LOCKED', 'Published save');
      assertUnchanged(publishedBefore, projectState(publishedProject), 'Published rejection');
    });

    const invalidActorProject = seedProject(prefix, 'invalid-actor', fixture);
    const invalidActorBefore = projectState(invalidActorProject);
    const invalidActorResult = await serviceClient.rpc('update_project_metadata', makeParameters(invalidActorProject, fixture, randomUUID(), { p_title: 'Blocked actor title' })) as RpcResult;
    await scenario(26, 'Nonexistent actor receives PERMISSION_DENIED and creates zero audit', () => {
      expectCode(invalidActorResult, 'PERMISSION_DENIED', 'Nonexistent actor');
      assertUnchanged(invalidActorBefore, projectState(invalidActorProject), 'Nonexistent actor');
    });

    const privilegeProject = seedProject(prefix, 'privileges', fixture);
    const privilegeBefore = projectState(privilegeProject);
    const privilegeParameters = makeParameters(privilegeProject, fixture, fixture.admin.id, { p_title: 'Forbidden direct title' });
    await scenario(27, 'anon direct new RPC execution is denied', () => {
      executeAsRoleExpectingPermissionDenial('anon', directFunctionSql(privilegeParameters));
      assertUnchanged(privilegeBefore, projectState(privilegeProject), 'anon denial');
    });
    await scenario(28, 'authenticated direct new RPC execution is denied', () => {
      executeAsRoleExpectingPermissionDenial('authenticated', directFunctionSql(privilegeParameters));
      assertUnchanged(privilegeBefore, projectState(privilegeProject), 'authenticated denial');
    });

    const serviceProject = seedProject(prefix, 'service-role', fixture);
    const serviceResult = await serviceClient.rpc('update_project_metadata', makeParameters(serviceProject, fixture, fixture.admin.id, { p_title: 'Service role title' })) as RpcResult;
    await scenario(29, 'service_role new RPC execution succeeds', () => {
      expectCode(serviceResult, 'SUCCESS', 'service_role execution');
      assert(projectState(serviceProject).title === 'Service role title', 'service_role change did not commit.');
    });

    await scenario(30, 'Obsolete ten-argument update_project_metadata signature does not exist', () => {
      const result = queryLocalJson<{ missing: boolean }>(`
        SELECT pg_catalog.jsonb_build_object(
          'missing', pg_catalog.to_regprocedure('public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz)') IS NULL
        )
      `);
      assert(result.missing, 'Obsolete ten-argument metadata RPC still exists.');
    });

    const mappingProject = seedProject(prefix, 'mapping-rollback', fixture);
    const mappingBefore = projectState(mappingProject);
    executeLocalSql(`
      CREATE FUNCTION public.${mappingFunction}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'FORCED_METADATA_MAPPING_FAILURE'; END; $fn$;
      CREATE TRIGGER ${mappingTrigger} BEFORE INSERT ON public.project_disciplines
      FOR EACH ROW EXECUTE FUNCTION public.${mappingFunction}();
    `);
    let mappingFailure: RpcResult;
    try {
      mappingFailure = await serviceClient.rpc('update_project_metadata', makeParameters(mappingProject, fixture, fixture.admin.id, {
        p_title: 'Mapping rollback title',
        p_summary: 'Mapping rollback summary',
        p_background: 'Mapping rollback background',
        p_solution: 'Mapping rollback solution',
        p_program_id: fixture.programs[1].id,
        p_discipline_ids: [fixture.disciplines[1].id],
        p_industry_category_ids: [fixture.industries[1].id],
      })) as RpcResult;
    } finally {
      executeLocalSql(`DROP TRIGGER IF EXISTS ${mappingTrigger} ON public.project_disciplines; DROP FUNCTION IF EXISTS public.${mappingFunction}();`);
    }
    await scenario(31, 'Forced relationship-mapping failure rolls back the entire mutation', () => {
      assert(Boolean(mappingFailure.error?.message.includes('FORCED_METADATA_MAPPING_FAILURE')), 'Forced mapping failure did not reach the relationship write.');
      assertUnchanged(mappingBefore, projectState(mappingProject), 'Mapping failure');
    });

    const auditFailureProject = seedProject(prefix, 'audit-rollback', fixture);
    const auditFailureBefore = projectState(auditFailureProject);
    executeLocalSql(`
      CREATE FUNCTION public.${auditFunction}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'FORCED_METADATA_AUDIT_FAILURE'; END; $fn$;
      CREATE TRIGGER ${auditTrigger} BEFORE INSERT ON public.approval_records
      FOR EACH ROW EXECUTE FUNCTION public.${auditFunction}();
    `);
    let auditFailure: RpcResult;
    try {
      auditFailure = await serviceClient.rpc('update_project_metadata', makeParameters(auditFailureProject, fixture, fixture.admin.id, {
        p_title: 'Audit rollback title',
        p_summary: 'Audit rollback summary',
        p_background: 'Audit rollback background',
        p_solution: 'Audit rollback solution',
        p_year: 2028,
        p_program_id: fixture.programs[1].id,
        p_discipline_ids: [fixture.disciplines[1].id],
        p_industry_category_ids: [fixture.industries[1].id],
      })) as RpcResult;
    } finally {
      executeLocalSql(`DROP TRIGGER IF EXISTS ${auditTrigger} ON public.approval_records; DROP FUNCTION IF EXISTS public.${auditFunction}();`);
    }
    await scenario(32, 'Forced approval_records INSERT failure rolls back every scalar, relationship, version, and audit write', () => {
      assert(Boolean(auditFailure.error?.message.includes('FORCED_METADATA_AUDIT_FAILURE')), 'Forced audit failure did not reach the audit insert.');
      assertUnchanged(auditFailureBefore, projectState(auditFailureProject), 'Audit insert failure');
    });

    const sequentialProject = seedProject(prefix, 'sequential', fixture);
    const sequentialOne = await serviceClient.rpc('update_project_metadata', makeParameters(sequentialProject, fixture, fixture.admin.id, { p_title: 'Sequential one' })) as RpcResult;
    const sequentialOneResponse = expectCode(sequentialOne, 'SUCCESS', 'Sequential save one');
    const sequentialTwo = await serviceClient.rpc('update_project_metadata', makeParameters(sequentialProject, fixture, fixture.admin.id, { p_summary: 'Sequential two' })) as RpcResult;
    const sequentialTwoResponse = expectCode(sequentialTwo, 'SUCCESS', 'Sequential save two');
    await scenario(33, 'Sequential genuine saves create distinct audit rows', () => {
      assert(sequentialOneResponse.auditRecordId !== sequentialTwoResponse.auditRecordId, 'Sequential saves reused an audit ID.');
      assert(auditRows(sequentialProject).length === 2, 'Sequential saves did not create two audit rows.');
    });

    executeLocalSql(`
      UPDATE public.approval_records SET created_at = '2026-08-13T12:00:00Z'::timestamptz
      WHERE id IN ('${sequentialOneResponse.auditRecordId}'::uuid, '${sequentialTwoResponse.auditRecordId}'::uuid);
    `);
    await scenario(34, 'History query orders created_at DESC with deterministic id DESC tie-break', () => {
      const actual = auditRows(sequentialProject).map((row) => row.id);
      const expected = [sequentialOneResponse.auditRecordId!, sequentialTwoResponse.auditRecordId!].sort().reverse();
      assert(JSON.stringify(actual) === JSON.stringify(expected), 'Audit history tie-break ordering is not deterministic.');
    });

    const retentionProject = seedProject(prefix, 'retention', fixture);
    const retentionResult = await serviceClient.rpc('update_project_metadata', makeParameters(retentionProject, fixture, fixture.retention.id, { p_title: 'Retained snapshot title' })) as RpcResult;
    expectCode(retentionResult, 'SUCCESS', 'Retention save');
    executeLocalSql(`DELETE FROM public.admin_users WHERE id = '${fixture.retention.id}'::uuid;`);
    await scenario(35, 'Actor snapshots remain after verifier-owned staff profile removal', () => {
      const retained = auditRows(retentionProject)[0];
      assert(retained.adminId === null, 'Removed actor was not detached by the FK.');
      assert(retained.actorFullName === fixture!.retention.fullName && retained.actorEmail === fixture!.retention.email, 'Actor snapshots did not survive profile removal.');
    });

    await scenario(36, 'Browser actor-spoof fields are rejected by the strict production input schema', () => {
      const rawInput = {
        publicId: adminProject,
        title: 'Browser title',
        summary: 'Browser summary',
        background: '',
        solution: '',
        year: '2026',
        programId: fixture!.programs[0].id,
        disciplineIds: [fixture!.disciplines[0].id],
        industryCategoryIds: [fixture!.industries[0].id],
        expectedUpdatedAt: projectState(adminProject).updatedAt,
      };
      for (const field of ['adminId', 'actorId', 'email', 'fullName', 'roles', 'permissions']) {
        assert(!projectMetadataInputSchema.safeParse({ ...rawInput, [field]: 'spoofed' }).success, `Strict input accepted browser actor field ${field}.`);
      }
      assert(auditRows(adminProject)[0].adminId === fixture!.admin.id, 'Browser spoof verification displaced the authoritative actor.');
    });

    const titleNormalizationProject = seedProject(prefix, 'title-normalization', fixture);
    const titleNormalization = await serviceClient.rpc('update_project_metadata', makeParameters(titleNormalizationProject, fixture, fixture.admin.id, { p_title: '  Revised title  ' })) as RpcResult;
    await scenario(37, 'Title outer whitespace is normalized in storage, response, and audit', () => {
      const response = expectCode(titleNormalization, 'SUCCESS', 'Title normalization');
      const audit = auditRows(titleNormalizationProject)[0];
      assert(projectState(titleNormalizationProject).title === 'Revised title' && response.metadata?.title === 'Revised title' && audit.eventDetails?.after.title === 'Revised title', 'Title normalization diverged.');
    });

    const summaryNormalizationProject = seedProject(prefix, 'summary-normalization', fixture);
    const summaryNormalization = await serviceClient.rpc('update_project_metadata', makeParameters(summaryNormalizationProject, fixture, fixture.admin.id, { p_summary: '  Revised summary  ' })) as RpcResult;
    await scenario(38, 'Summary outer whitespace is normalized in storage, response, and audit', () => {
      const response = expectCode(summaryNormalization, 'SUCCESS', 'Summary normalization');
      const audit = auditRows(summaryNormalizationProject)[0];
      assert(projectState(summaryNormalizationProject).summary === 'Revised summary' && response.metadata?.summary === 'Revised summary' && audit.eventDetails?.after.summary === 'Revised summary', 'Summary normalization diverged.');
    });

    const nullBackgroundProject = seedProject(prefix, 'null-background', fixture, { background: null });
    const nullBackground = await serviceClient.rpc('update_project_metadata', makeParameters(nullBackgroundProject, fixture, fixture.admin.id, { p_title: 'Null background title', p_background: null })) as RpcResult;
    await scenario(39, 'NULL background at the trusted RPC boundary normalizes consistently', () => {
      const response = expectCode(nullBackground, 'SUCCESS', 'NULL background');
      assert(projectState(nullBackgroundProject).background === '' && response.metadata?.background === '', 'NULL background did not normalize to an empty string.');
      assert(!auditRows(nullBackgroundProject)[0].eventDetails?.changedFields.includes('background'), 'Equivalent NULL background produced a false diff.');
    });

    const nullSolutionProject = seedProject(prefix, 'null-solution', fixture, { solution: null });
    const nullSolution = await serviceClient.rpc('update_project_metadata', makeParameters(nullSolutionProject, fixture, fixture.admin.id, { p_title: 'Null solution title', p_solution: null })) as RpcResult;
    await scenario(40, 'NULL solution at the trusted RPC boundary normalizes consistently', () => {
      const response = expectCode(nullSolution, 'SUCCESS', 'NULL solution');
      assert(projectState(nullSolutionProject).solution === '' && response.metadata?.solution === '', 'NULL solution did not normalize to an empty string.');
      assert(!auditRows(nullSolutionProject)[0].eventDetails?.changedFields.includes('solution'), 'Equivalent NULL solution produced a false diff.');
    });

    const whitespaceTitleProject = seedProject(prefix, 'whitespace-title', fixture);
    const whitespaceTitleBefore = projectState(whitespaceTitleProject);
    const whitespaceTitle = await serviceClient.rpc('update_project_metadata', makeParameters(whitespaceTitleProject, fixture, fixture.admin.id, { p_title: '   ' })) as RpcResult;
    await scenario(41, 'Whitespace-only title returns VALIDATION_FAILED with zero audit', () => {
      expectCode(whitespaceTitle, 'VALIDATION_FAILED', 'Whitespace title');
      assertUnchanged(whitespaceTitleBefore, projectState(whitespaceTitleProject), 'Whitespace title');
    });

    const whitespaceSummaryProject = seedProject(prefix, 'whitespace-summary', fixture);
    const whitespaceSummaryBefore = projectState(whitespaceSummaryProject);
    const whitespaceSummary = await serviceClient.rpc('update_project_metadata', makeParameters(whitespaceSummaryProject, fixture, fixture.admin.id, { p_summary: '   ' })) as RpcResult;
    await scenario(42, 'Whitespace-only summary returns VALIDATION_FAILED with zero audit', () => {
      expectCode(whitespaceSummary, 'VALIDATION_FAILED', 'Whitespace summary');
      assertUnchanged(whitespaceSummaryBefore, projectState(whitespaceSummaryProject), 'Whitespace summary');
    });

    const publicIdProject = seedProject(prefix, 'public-id', fixture);
    const publicIdNormalization = await serviceClient.rpc('update_project_metadata', makeParameters(publicIdProject, fixture, fixture.admin.id, {
      p_public_id: `  ${publicIdProject}  `,
      p_title: 'Public ID normalized title',
    })) as RpcResult;
    await scenario(43, 'Public ID outer whitespace preserves Migration 0018 lookup and response behavior', () => {
      const response = expectCode(publicIdNormalization, 'SUCCESS', 'Public ID normalization');
      assert(response.metadata?.publicId === publicIdProject, 'Public ID response was not normalized.');
      assert(projectState(publicIdProject).title === 'Public ID normalized title' && auditRows(publicIdProject).length === 1, 'Normalized public ID did not target the intended project atomically.');
    });

    assert(scenarioCount === 43, `Expected 43 independently asserted scenarios, completed ${scenarioCount}.`);
  } catch (error) {
    verifierError = error;
  } finally {
    try {
      executeLocalSql(`
        DROP TRIGGER IF EXISTS ${mappingTrigger} ON public.project_disciplines;
        DROP FUNCTION IF EXISTS public.${mappingFunction}();
        DROP TRIGGER IF EXISTS ${auditTrigger} ON public.approval_records;
        DROP FUNCTION IF EXISTS public.${auditFunction}();
        DELETE FROM public.projects WHERE public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.admin_users WHERE email LIKE ${sqlText(`${prefix}-%@example.test`)};
        ${fixture ? `DELETE FROM public.programs WHERE id IN (${fixture.programs.map((item) => `'${item.id}'::uuid`).join(',')});` : ''}
        ${fixture ? `DELETE FROM public.disciplines WHERE id IN (${fixture.disciplines.map((item) => `'${item.id}'::uuid`).join(',')});` : ''}
        ${fixture ? `DELETE FROM public.industry_categories WHERE id IN (${fixture.industries.map((item) => `'${item.id}'::uuid`).join(',')});` : ''}
      `);
    } catch (cleanupError) {
      if (!verifierError) verifierError = cleanupError;
    }
  }

  if (verifierError) throw verifierError;
  console.log(`Project metadata audit runtime verification passed (${scenarioCount} independently asserted scenarios).`);
}

if (require.main === module) {
  verifyProjectMetadataAuditRuntime().catch((error) => {
    console.error('Project metadata audit runtime verification failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
