import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import { parseProjectDetailsWorkbook } from '../import/parseProjectDetailsWorkbook';
import { ProjectDetailsWorkbookError } from '../import/projectDetailsWorkbookContract';
import { parseProjectDetailsJson } from '../import/parseProjectDetailsJson';
import { computeProjectReviewReadiness } from '../import/importBatchReviewReadiness';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { renderParticipantPreviewPage } from '../previews/participantPreviewHtml';
import { validateProjectForApproval } from '../validation/projectValidation';
import { createMockProject } from '../test/projectFixtures';
import { compilePublicFeed } from '../feed/compilePublicFeed';

/**
 * Local runtime verification for the accessible poster full-text workflow gate (Migration 0025).
 *
 * Proves, against a real local Supabase stack, that poster full text and accessibility text are
 * required at every boundary a project must cross to become public: workbook import, project
 * metadata editing, review submission, approval, participant preview, publication readiness, and
 * public-feed validation.
 *
 * Synthetic data only. Performs no OCR, no AI, no external network call, no email send, and no
 * public-feed or Duda write. Every row it creates is owned by a per-run prefix and removed in the
 * finally block.
 */

type RpcResult<T = Record<string, unknown>> = { data: T | null; error: { message: string } | null };

type NamedLookup = { id: string; name: string };
type ActorFixture = { id: string; fullName: string; email: string };

type RuntimeFixture = {
  program: NamedLookup;
  discipline: NamedLookup;
  industry: NamedLookup;
  admin: ActorFixture;
  editor: ActorFixture;
  reviewer: ActorFixture;
  batchId: string;
};

type ProjectState = {
  id: string;
  status: string;
  title: string;
  summary: string;
  background: string | null;
  solution: string | null;
  posterText: string | null;
  accessibilityText: string | null;
  year: number;
  programId: string;
  updatedAt: string;
  disciplines: string[];
  industries: string[];
  audits: number;
};

type AuditRow = {
  id: string;
  action: string;
  changedFields: string[] | null;
  beforePosterText: string | null;
  afterPosterText: string | null;
  beforeAccessibilityText: string | null;
  afterAccessibilityText: string | null;
};

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LOCAL_DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PRIVATE_BUCKET = 'project-drafts-private';

const POSTER_TEXT = 'Aim: reduce distributed solar loss.\nMethod: dynamic micro-inverter control.\nResult: 12% yield improvement across six sites.';
const ACCESSIBILITY_TEXT = 'Research poster showing an inverter architecture diagram beside a results table.';

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
    throw new Error(`Accessibility full-text runtime query failed: ${detail}`);
  }
}

function queryLocalJson<T>(sql: string): T {
  const output = executeLocalSql(sql).trim();
  if (!output) throw new Error('Accessibility full-text runtime query returned no result.');
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error('Accessibility full-text runtime query returned malformed JSON.');
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
    throw new Error('Accessibility full-text verifier requires a loopback-only local Supabase service-role client.');
  }
  return createClient(localEnv.API_URL, localEnv.SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const WORKBOOK_HEADERS = [
  'Project title', 'Short public summary', 'Project background', 'Solution / impact',
  'Team members', 'Group name', 'Academic supervisor', 'Industry partner', 'Industry sector',
  'Study program', 'Primary discipline', 'Project year', 'Showcase layout',
  'Main media to feature', 'Poster full text', 'Accessibility text',
];

async function buildWorkbook(options: { omitColumn?: string; blankColumn?: string } = {}): Promise<Buffer> {
  const values: Record<string, string> = {
    'Project title': 'Solar Power Optimizer',
    'Short public summary': 'AI-powered solar optimizer.',
    'Project background': 'High energy loss in solar grids.',
    'Solution / impact': 'Smart dynamic micro-inverter controller.',
    'Team members': 'Alice Smith, Bob Jones',
    'Group name': 'Solar Team',
    'Academic supervisor': 'Dr. Carol Vance',
    'Industry partner': 'CleanEnergy Corp',
    'Industry sector': 'Renewable Energy',
    'Study program': 'Bachelor of Software Engineering',
    'Primary discipline': 'Software Engineering',
    'Project year': '2026',
    'Showcase layout': 'Poster showcase',
    'Main media to feature': 'Poster',
    'Poster full text': POSTER_TEXT,
    'Accessibility text': ACCESSIBILITY_TEXT,
  };

  const headers = WORKBOOK_HEADERS.filter((header) => header !== options.omitColumn);
  const row = headers.map((header) => (header === options.blankColumn ? '   ' : values[header]));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Project details');
  sheet.addRow(headers);
  sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function createFixture(prefix: string): RuntimeFixture {
  const named = (kind: string): NamedLookup => ({ id: randomUUID(), name: `${prefix} ${kind}` });
  const actor = (kind: string): ActorFixture => ({
    id: randomUUID(),
    fullName: `${prefix} ${kind}`,
    email: `${prefix}-${kind.toLowerCase()}@example.test`,
  });
  const fixture: RuntimeFixture = {
    program: named('Program'),
    discipline: named('Discipline'),
    industry: named('Industry'),
    admin: actor('Admin'),
    editor: actor('Editor'),
    reviewer: actor('Reviewer'),
    batchId: randomUUID(),
  };

  executeLocalSql(`
    INSERT INTO public.programs(id, name) VALUES ('${fixture.program.id}'::uuid, ${sqlText(fixture.program.name)});
    INSERT INTO public.disciplines(id, name) VALUES ('${fixture.discipline.id}'::uuid, ${sqlText(fixture.discipline.name)});
    INSERT INTO public.industry_categories(id, name) VALUES ('${fixture.industry.id}'::uuid, ${sqlText(fixture.industry.name)});
    INSERT INTO public.admin_users(id, email, full_name) VALUES
      ('${fixture.admin.id}'::uuid, ${sqlText(fixture.admin.email)}, ${sqlText(fixture.admin.fullName)}),
      ('${fixture.editor.id}'::uuid, ${sqlText(fixture.editor.email)}, ${sqlText(fixture.editor.fullName)}),
      ('${fixture.reviewer.id}'::uuid, ${sqlText(fixture.reviewer.email)}, ${sqlText(fixture.reviewer.fullName)});
    INSERT INTO public.user_roles(user_id, role) VALUES
      ('${fixture.admin.id}'::uuid, 'admin'),
      ('${fixture.editor.id}'::uuid, 'editor'),
      ('${fixture.reviewer.id}'::uuid, 'reviewer');
    INSERT INTO public.import_batches(id, status) VALUES ('${fixture.batchId}'::uuid, 'completed');
  `);
  return fixture;
}

function seedProject(
  prefix: string,
  label: string,
  fixture: RuntimeFixture,
  options: {
    status?: string;
    posterText?: string | null;
    accessibilityText?: string | null;
    inBatch?: boolean;
    withMedia?: boolean;
  } = {},
): string {
  const publicId = `${prefix}-${label}`;
  const posterText = options.posterText === undefined ? POSTER_TEXT : options.posterText;
  const accessibilityText = options.accessibilityText === undefined ? ACCESSIBILITY_TEXT : options.accessibilityText;

  executeLocalSql(`
    INSERT INTO public.projects(
      public_id, title, summary, background, solution, poster_text_public, accessibility_text_public,
      year, program_id, program_name, study_program, discipline, industry, group_name, team_members,
      status${options.inBatch ? ', import_batch_id' : ''}
    ) VALUES (
      ${sqlText(publicId)}, 'Runtime Title', 'Runtime summary', 'Runtime background', 'Runtime solution',
      ${sqlText(posterText)}, ${sqlText(accessibilityText)}, 2026, '${fixture.program.id}'::uuid,
      ${sqlText(fixture.program.name)}, 'Runtime study program', ${sqlText(fixture.discipline.name)},
      ${sqlText(fixture.industry.name)}, 'Runtime Group', ARRAY['Alice Smith'],
      ${sqlText(options.status ?? 'draft')}${options.inBatch ? `, '${fixture.batchId}'::uuid` : ''}
    );
    INSERT INTO public.project_disciplines(project_id, discipline_id)
      SELECT id, '${fixture.discipline.id}'::uuid FROM public.projects WHERE public_id = ${sqlText(publicId)};
    INSERT INTO public.project_industry_categories(project_id, industry_category_id)
      SELECT id, '${fixture.industry.id}'::uuid FROM public.projects WHERE public_id = ${sqlText(publicId)};
    ${options.withMedia ? `
    INSERT INTO public.media_assets(project_id, asset_type, file_name, storage_bucket, storage_path, is_public_approved, public_url)
      SELECT id, 'poster_image', 'poster.png', ${sqlText(PRIVATE_BUCKET)}, ${sqlText(`${publicId}/poster.png`)}, false, NULL
      FROM public.projects WHERE public_id = ${sqlText(publicId)};
    INSERT INTO public.media_assets(project_id, asset_type, file_name, storage_bucket, storage_path, is_public_approved, public_url)
      SELECT id, 'poster_pdf', 'poster.pdf', ${sqlText(PRIVATE_BUCKET)}, ${sqlText(`${publicId}/poster.pdf`)}, false, NULL
      FROM public.projects WHERE public_id = ${sqlText(publicId)};` : ''}
  `);
  return publicId;
}

function projectState(publicId: string): ProjectState {
  return queryLocalJson<ProjectState>(`
    SELECT pg_catalog.jsonb_build_object(
      'id', p.id::text, 'status', p.status, 'title', p.title, 'summary', p.summary,
      'background', p.background, 'solution', p.solution,
      'posterText', p.poster_text_public, 'accessibilityText', p.accessibility_text_public,
      'year', p.year, 'programId', p.program_id::text, 'updatedAt', p.updated_at,
      'disciplines', (SELECT coalesce(pg_catalog.jsonb_agg(pd.discipline_id::text ORDER BY pd.discipline_id), '[]'::jsonb) FROM public.project_disciplines pd WHERE pd.project_id = p.id),
      'industries', (SELECT coalesce(pg_catalog.jsonb_agg(pic.industry_category_id::text ORDER BY pic.industry_category_id), '[]'::jsonb) FROM public.project_industry_categories pic WHERE pic.project_id = p.id),
      'audits', (SELECT pg_catalog.count(*) FROM public.approval_records ar WHERE ar.project_id = p.id)
    ) FROM public.projects p WHERE p.public_id = ${sqlText(publicId)}
  `);
}

function auditRows(publicId: string): AuditRow[] {
  return queryLocalJson<AuditRow[]>(`
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ar.id::text,
      'action', ar.action_taken,
      'changedFields', ar.event_details->'changedFields',
      'beforePosterText', ar.event_details->'before'->>'posterText',
      'afterPosterText', ar.event_details->'after'->>'posterText',
      'beforeAccessibilityText', ar.event_details->'before'->>'accessibilityText',
      'afterAccessibilityText', ar.event_details->'after'->>'accessibilityText'
    ) ORDER BY ar.id), '[]'::jsonb)
    FROM public.approval_records ar JOIN public.projects p ON p.id = ar.project_id
    WHERE p.public_id = ${sqlText(publicId)}
  `);
}

function metadataAudits(publicId: string): AuditRow[] {
  return auditRows(publicId).filter((row) => row.action === 'update_metadata');
}

function metadataArgs(publicId: string, fixture: RuntimeFixture, actorId: string, patch: Record<string, unknown> = {}) {
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
    p_admin_id: actorId,
    p_poster_text: current.posterText ?? '',
    p_accessibility_text: current.accessibilityText ?? '',
    ...patch,
  };
}

export async function verifyAccessibilityFullTextRuntime(): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const prefix = `a11y-${suffix}`;
  const serviceClient = createServiceClient();
  let fixture: RuntimeFixture | null = null;
  let verifierError: unknown;
  let scenarioCount = 0;

  const scenario = async (number: number, name: string, verification: () => void | Promise<void>) => {
    assert(number === scenarioCount + 1, `Scenario numbering skipped before ${number} (${name}).`);
    await verification();
    scenarioCount = number;
  };

  try {
    fixture = createFixture(prefix);

    // ---------------------------------------------------------------- Migration presence
    await scenario(1, 'Migration 0025 is loaded and update_project_metadata has exactly one signature', () => {
      const signatures = executeLocalSql(`
        SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p
        WHERE p.proname = 'update_project_metadata' AND p.pronamespace = 'public'::regnamespace
      `).trim().split('\n').filter(Boolean);
      assert(signatures.length === 1, `Expected exactly one update_project_metadata signature, found ${signatures.length}.`);
      assert(
        signatures[0].includes('p_poster_text text') && signatures[0].includes('p_accessibility_text text'),
        'Authoritative update_project_metadata does not accept accessible content parameters.',
      );
      for (const fn of ['submit_import_projects_for_review', 'perform_project_review_action', 'get_project_publication_readiness']) {
        const loaded = executeLocalSql(`
          SELECT pg_catalog.count(*) FROM pg_proc p
          WHERE p.proname = ${sqlText(fn)} AND p.pronamespace = 'public'::regnamespace AND p.prosecdef
        `).trim();
        assert(loaded === '1', `${fn} is missing or is not SECURITY DEFINER.`);
      }
    });

    // ---------------------------------------------------------------- Workbook contract
    await scenario(2, 'XLSX carrying both required accessible content values parses', async () => {
      const parsed = await parseProjectDetailsWorkbook(await buildWorkbook());
      assert(parsed.metadata.posterText === POSTER_TEXT, 'Poster full text did not survive workbook parsing.');
      assert(parsed.metadata.accessibilityText === ACCESSIBILITY_TEXT, 'Accessibility text did not survive workbook parsing.');
      assert(parsed.warnings.length === 0, 'A compliant workbook produced unexpected warnings.');
    });

    const expectWorkbookRejection = async (buffer: Buffer, field: string, expectedCode: string) => {
      try {
        await parseProjectDetailsWorkbook(buffer);
        throw new Error(`Workbook was accepted despite an invalid ${field}.`);
      } catch (error) {
        assert(error instanceof ProjectDetailsWorkbookError, `Workbook rejection for ${field} was not a contract error.`);
        const issues = (error as ProjectDetailsWorkbookError).errors.filter((issue) => issue.fieldName === field);
        assert(issues.length === 1 && issues[0].code === expectedCode, `Workbook ${field} rejection code was ${issues[0]?.code ?? 'absent'}.`);
      }
    };

    await scenario(3, 'XLSX missing the Poster full text column is rejected', async () => {
      await expectWorkbookRejection(await buildWorkbook({ omitColumn: 'Poster full text' }), 'posterText', 'WORKBOOK_MISSING_REQUIRED_COLUMN');
    });

    await scenario(4, 'XLSX missing the Accessibility text column is rejected', async () => {
      await expectWorkbookRejection(await buildWorkbook({ omitColumn: 'Accessibility text' }), 'accessibilityText', 'WORKBOOK_MISSING_REQUIRED_COLUMN');
    });

    await scenario(5, 'XLSX with a blank Poster full text value is rejected', async () => {
      await expectWorkbookRejection(await buildWorkbook({ blankColumn: 'Poster full text' }), 'posterText', 'WORKBOOK_MISSING_REQUIRED_VALUE');
    });

    await scenario(6, 'XLSX with a blank Accessibility text value is rejected', async () => {
      await expectWorkbookRejection(await buildWorkbook({ blankColumn: 'Accessibility text' }), 'accessibilityText', 'WORKBOOK_MISSING_REQUIRED_VALUE');
    });

    await scenario(7, 'Multiline poster full text survives workbook parsing intact', async () => {
      const parsed = await parseProjectDetailsWorkbook(await buildWorkbook());
      assert(parsed.metadata.posterText.includes('\n'), 'Multiline poster full text was collapsed.');
    });

    // ---------------------------------------------------------------- Legacy project.json
    await scenario(8, 'Legacy project.json without accessible content still parses (no silent synthesis)', () => {
      const legacy = parseProjectDetailsJson(Buffer.from(JSON.stringify({
        title: 'Legacy Project', summary: 'Legacy summary', year: '2026',
        program: 'Legacy program', discipline: 'Legacy discipline', groupName: 'Legacy group',
        teamMembers: ['Alice Smith'],
      })), `${prefix}-legacy`);
      assert(!legacy.manifest.posterText, 'Legacy JSON fabricated a poster full text value.');
      assert(!legacy.manifest.accessibilityText, 'Legacy JSON fabricated an accessibility text value.');
    });

    // ---------------------------------------------------------------- Metadata editing
    const blankProject = seedProject(prefix, 'blank', fixture, { posterText: null, accessibilityText: null });

    await scenario(9, 'Metadata save is rejected while poster full text is blank', async () => {
      const before = projectState(blankProject);
      const result = await serviceClient.rpc('update_project_metadata', metadataArgs(blankProject, fixture!, fixture!.admin.id, {
        p_poster_text: '   ', p_accessibility_text: ACCESSIBILITY_TEXT,
      })) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'VALIDATION_FAILED', `Blank poster text returned ${result.data?.resultCode}.`);
      assert(projectState(blankProject).audits === before.audits, 'Rejected metadata save created an audit row.');
    });

    await scenario(10, 'Admin can save poster full text and accessibility text', async () => {
      const result = await serviceClient.rpc('update_project_metadata', metadataArgs(blankProject, fixture!, fixture!.admin.id, {
        p_poster_text: POSTER_TEXT, p_accessibility_text: ACCESSIBILITY_TEXT,
      })) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'SUCCESS', `Admin metadata save returned ${result.data?.resultCode}.`);
    });

    await scenario(11, 'Saved accessible content survives a fresh authoritative reload', () => {
      const reloaded = projectState(blankProject);
      assert(reloaded.posterText === POSTER_TEXT, 'Poster full text did not persist.');
      assert(reloaded.accessibilityText === ACCESSIBILITY_TEXT, 'Accessibility text did not persist.');
    });

    await scenario(12, 'Metadata audit records a posterText-only change exactly', async () => {
      const isolated = seedProject(prefix, 'iso-poster', fixture!);
      const result = await serviceClient.rpc('update_project_metadata', metadataArgs(isolated, fixture!, fixture!.admin.id, {
        p_poster_text: 'Revised poster full text only',
      })) as RpcResult<{ resultCode?: string; auditRecordId?: string }>;
      assert(result.data?.resultCode === 'SUCCESS', 'Isolated poster text save failed.');
      const audits = metadataAudits(isolated);
      assert(audits.length === 1, `Isolated poster text save created ${audits.length} audit rows.`);
      assert(JSON.stringify(audits[0].changedFields) === JSON.stringify(['posterText']), `changedFields was ${JSON.stringify(audits[0].changedFields)}.`);
      assert(audits[0].beforePosterText === POSTER_TEXT && audits[0].afterPosterText === 'Revised poster full text only', 'Poster text audit values are wrong.');
    });

    await scenario(13, 'Metadata audit records an accessibilityText-only change exactly', async () => {
      const isolated = seedProject(prefix, 'iso-a11y', fixture!);
      const result = await serviceClient.rpc('update_project_metadata', metadataArgs(isolated, fixture!, fixture!.admin.id, {
        p_accessibility_text: 'Revised accessibility text only',
      })) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'SUCCESS', 'Isolated accessibility text save failed.');
      const audits = metadataAudits(isolated);
      assert(audits.length === 1, `Isolated accessibility text save created ${audits.length} audit rows.`);
      assert(JSON.stringify(audits[0].changedFields) === JSON.stringify(['accessibilityText']), `changedFields was ${JSON.stringify(audits[0].changedFields)}.`);
      assert(audits[0].beforeAccessibilityText === ACCESSIBILITY_TEXT && audits[0].afterAccessibilityText === 'Revised accessibility text only', 'Accessibility text audit values are wrong.');
    });

    await scenario(14, 'A no-op accessible content save creates zero audit rows', async () => {
      const noop = seedProject(prefix, 'noop', fixture!);
      const before = projectState(noop);
      const result = await serviceClient.rpc('update_project_metadata', metadataArgs(noop, fixture!, fixture!.admin.id)) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'NO_CHANGES', `No-op save returned ${result.data?.resultCode}.`);
      assert(projectState(noop).audits === before.audits, 'A no-op save created an audit row.');
    });

    await scenario(15, 'Editor may save accessible content; reviewer-only may not', async () => {
      const editorProject = seedProject(prefix, 'editor', fixture!);
      const editorResult = await serviceClient.rpc('update_project_metadata', metadataArgs(editorProject, fixture!, fixture!.editor.id, {
        p_accessibility_text: 'Editor supplied accessibility text',
      })) as RpcResult<{ resultCode?: string }>;
      assert(editorResult.data?.resultCode === 'SUCCESS', `Editor save returned ${editorResult.data?.resultCode}.`);

      const reviewerProject = seedProject(prefix, 'reviewer-denied', fixture!);
      const before = projectState(reviewerProject);
      const reviewerResult = await serviceClient.rpc('update_project_metadata', metadataArgs(reviewerProject, fixture!, fixture!.reviewer.id, {
        p_poster_text: 'Reviewer blocked poster text',
      })) as RpcResult<{ resultCode?: string }>;
      assert(reviewerResult.data?.resultCode === 'PERMISSION_DENIED', `Reviewer save returned ${reviewerResult.data?.resultCode}.`);
      const after = projectState(reviewerProject);
      assert(after.posterText === before.posterText && after.audits === before.audits, 'Reviewer-only identity mutated accessible content.');
    });

    await scenario(16, 'Oversized accessible content is rejected at the bounded ceiling', async () => {
      const oversized = seedProject(prefix, 'oversized', fixture!);
      const before = projectState(oversized);
      const result = await serviceClient.rpc('update_project_metadata', metadataArgs(oversized, fixture!, fixture!.admin.id, {
        p_poster_text: 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText + 1),
      })) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'VALIDATION_FAILED', `Oversized poster text returned ${result.data?.resultCode}.`);
      assert(projectState(oversized).audits === before.audits, 'Oversized poster text created an audit row.');
    });

    await scenario(17, 'Stale expected version still wins over an accessible content edit', async () => {
      const stale = seedProject(prefix, 'stale', fixture!);
      const staleArgs = metadataArgs(stale, fixture!, fixture!.admin.id, { p_poster_text: 'Loser poster text' });
      await serviceClient.rpc('update_project_metadata', metadataArgs(stale, fixture!, fixture!.admin.id, { p_poster_text: 'Winner poster text' }));
      const result = await serviceClient.rpc('update_project_metadata', staleArgs) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'STALE_VERSION', `Stale save returned ${result.data?.resultCode}.`);
      assert(projectState(stale).posterText === 'Winner poster text', 'Stale save overwrote the winning poster text.');
    });

    await scenario(18, 'Approved and published projects keep their existing edit gates', async () => {
      const approved = seedProject(prefix, 'approved-gate', fixture!, { status: 'approved' });
      const approvedResult = await serviceClient.rpc('update_project_metadata', metadataArgs(approved, fixture!, fixture!.admin.id, {
        p_poster_text: 'Blocked by reopen gate',
      })) as RpcResult<{ resultCode?: string }>;
      assert(approvedResult.data?.resultCode === 'APPROVAL_REOPEN_REQUIRED', `Approved edit returned ${approvedResult.data?.resultCode}.`);

      const published = seedProject(prefix, 'published-gate', fixture!, { status: 'published' });
      const publishedResult = await serviceClient.rpc('update_project_metadata', metadataArgs(published, fixture!, fixture!.admin.id, {
        p_poster_text: 'Blocked by published lock',
      })) as RpcResult<{ resultCode?: string }>;
      assert(publishedResult.data?.resultCode === 'PUBLISHED_PROJECT_LOCKED', `Published edit returned ${publishedResult.data?.resultCode}.`);
    });

    // ---------------------------------------------------------------- Review submission
    const submitBlocked = seedProject(prefix, 'submit-no-poster', fixture!, { posterText: null, inBatch: true, withMedia: true });
    const submitBlockedA11y = seedProject(prefix, 'submit-no-a11y', fixture!, { accessibilityText: null, inBatch: true, withMedia: true });
    const submitReady = seedProject(prefix, 'submit-ready', fixture!, { inBatch: true, withMedia: true });

    await scenario(19, 'Application readiness treats both values as blockers, not warnings', () => {
      const readiness = computeProjectReviewReadiness({
        publicId: 'synthetic', title: 'T', summary: 'S', programId: fixture!.program.id, programName: 'P',
        studyProgram: 'SP', discipline: 'D', groupName: 'G', teamMembers: ['A'],
        posterText: null, accessibilityText: null, snapshots: [], validationErrors: [], validationWarnings: [],
        validationFlags: [], status: 'draft', disciplineMappingCount: 1, industryMappingCount: 1,
        mediaAssets: [
          { assetType: 'poster_image', isPublicApproved: false, publicUrl: null },
          { assetType: 'poster_pdf', isPublicApproved: false, publicUrl: null },
        ],
      });
      assert(!readiness.ready, 'Application readiness accepted a project with no accessible content.');
      assert(readiness.blockingReasons.includes('Poster full text is missing.'), 'Poster full text was not a blocker.');
      assert(readiness.blockingReasons.includes('Accessibility text is missing.'), 'Accessibility text was not a blocker.');
      assert(!readiness.warnings.includes('Accessibility text is missing.'), 'Accessibility text is still an acknowledgeable warning.');
    });

    await scenario(20, 'Database blocks review submission when poster full text is missing', async () => {
      const result = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [submitBlocked], p_admin_id: fixture!.editor.id, p_comments: null,
      }) as RpcResult<{ resultCode?: string; blockingReasons?: string[] }>;
      assert(result.data?.resultCode === 'READINESS_BLOCKED', `Submission returned ${result.data?.resultCode}.`);
      assert(result.data?.blockingReasons?.includes('MISSING_POSTER_TEXT'), 'MISSING_POSTER_TEXT was not reported.');
      const state = projectState(submitBlocked);
      assert(state.status === 'draft' && state.audits === 0, 'Blocked submission mutated project status or audit history.');
    });

    await scenario(21, 'Database blocks review submission when accessibility text is missing', async () => {
      const result = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [submitBlockedA11y], p_admin_id: fixture!.editor.id, p_comments: null,
      }) as RpcResult<{ resultCode?: string; blockingReasons?: string[] }>;
      assert(result.data?.resultCode === 'READINESS_BLOCKED', `Submission returned ${result.data?.resultCode}.`);
      assert(result.data?.blockingReasons?.includes('MISSING_ACCESSIBILITY_TEXT'), 'MISSING_ACCESSIBILITY_TEXT was not reported.');
      const state = projectState(submitBlockedA11y);
      assert(state.status === 'draft' && state.audits === 0, 'Blocked submission mutated project status or audit history.');
    });

    await scenario(22, 'A mixed selection fails atomically, leaving every project untouched', async () => {
      const result = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId,
        p_project_public_ids: [submitReady, submitBlocked],
        p_admin_id: fixture!.editor.id,
        p_comments: null,
      }) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'READINESS_BLOCKED', `Mixed submission returned ${result.data?.resultCode}.`);
      for (const publicId of [submitReady, submitBlocked]) {
        const state = projectState(publicId);
        assert(state.status === 'draft' && state.audits === 0, `Mixed submission mutated ${publicId}.`);
      }
    });

    await scenario(23, 'A compliant project submits for review normally', async () => {
      const result = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [submitReady], p_admin_id: fixture!.editor.id, p_comments: null,
      }) as RpcResult<{ resultCode?: string; submittedCount?: number }>;
      assert(result.data?.resultCode === 'SUCCESS', `Compliant submission returned ${result.data?.resultCode}.`);
      assert(projectState(submitReady).status === 'submitted', 'Compliant project did not reach submitted.');
    });

    await scenario(24, 'Correcting a blocked project through the metadata editor unblocks submission', async () => {
      const fixed = await serviceClient.rpc('update_project_metadata', metadataArgs(submitBlocked, fixture!, fixture!.editor.id, {
        p_poster_text: POSTER_TEXT,
      })) as RpcResult<{ resultCode?: string }>;
      assert(fixed.data?.resultCode === 'SUCCESS', 'Metadata correction failed.');
      const result = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [submitBlocked], p_admin_id: fixture!.editor.id, p_comments: null,
      }) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'SUCCESS', `Corrected submission returned ${result.data?.resultCode}.`);
    });

    // ---------------------------------------------------------------- Approval
    await scenario(25, 'Application approval validation reports both values as blocking errors', () => {
      const result = validateProjectForApproval(createMockProject({ posterText: '', accessibilityText: '' }));
      assert(!result.valid, 'Approval validation accepted a project with no accessible content.');
      assert(result.errors.some((error) => error.includes('Poster full text is missing')), 'Poster full text was not an approval error.');
      assert(result.errors.some((error) => error.includes('Accessibility text is missing')), 'Accessibility text was not an approval error.');
    });

    await scenario(26, 'Direct approval cannot bypass missing poster full text', async () => {
      const project = seedProject(prefix, 'approve-no-poster', fixture!, { status: 'submitted', posterText: null });
      const result = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: project, p_action: 'approve', p_comments: null, p_admin_id: fixture!.reviewer.id,
      }) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED', `Approval returned ${result.data?.resultCode}.`);
      const state = projectState(project);
      assert(state.status === 'submitted' && state.audits === 0, 'Blocked approval mutated status or created an approval audit.');
    });

    await scenario(27, 'Direct approval cannot bypass missing accessibility text', async () => {
      const project = seedProject(prefix, 'approve-no-a11y', fixture!, { status: 'submitted', accessibilityText: null });
      const result = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: project, p_action: 'approve', p_comments: null, p_admin_id: fixture!.reviewer.id,
      }) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED', `Approval returned ${result.data?.resultCode}.`);
      const state = projectState(project);
      assert(state.status === 'submitted' && state.audits === 0, 'Blocked approval mutated status or created an approval audit.');
    });

    await scenario(28, 'A compliant project approves normally', async () => {
      const project = seedProject(prefix, 'approve-ready', fixture!, { status: 'submitted' });
      const result = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: project, p_action: 'approve', p_comments: null, p_admin_id: fixture!.reviewer.id,
      }) as RpcResult<{ status?: string }>;
      assert(result.data?.status === 'approved', `Compliant approval returned ${JSON.stringify(result.data)}.`);
      assert(projectState(project).status === 'approved', 'Compliant project did not reach approved.');
    });

    await scenario(29, 'request_changes and archive remain available for non-compliant projects', async () => {
      const changes = seedProject(prefix, 'changes', fixture!, { status: 'submitted', posterText: null, accessibilityText: null });
      const changesResult = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: changes, p_action: 'request_changes', p_comments: 'Add poster full text.', p_admin_id: fixture!.reviewer.id,
      }) as RpcResult<{ status?: string }>;
      assert(changesResult.data?.status === 'changes_requested', 'request_changes was incorrectly gated on accessible content.');

      const archived = seedProject(prefix, 'archive', fixture!, { status: 'submitted', posterText: null, accessibilityText: null });
      const archiveResult = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: archived, p_action: 'archive', p_comments: 'Withdrawn.', p_admin_id: fixture!.admin.id,
      }) as RpcResult<{ status?: string }>;
      assert(archiveResult.data?.status === 'archived', 'archive was incorrectly gated on accessible content.');
    });

    await scenario(30, 'Controlled public removal still guards a published project', async () => {
      const published = seedProject(prefix, 'published-archive', fixture!, { status: 'published' });
      const result = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: published, p_action: 'archive', p_comments: 'Attempted generic archive.', p_admin_id: fixture!.admin.id,
      }) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED', `Published archive returned ${result.data?.resultCode}.`);
      assert(projectState(published).status === 'published', 'Published project status changed under generic archive.');
    });

    // ---------------------------------------------------------------- Participant preview
    await scenario(31, 'Participant preview renders both values before the confirmation controls', () => {
      const html = renderParticipantPreviewPage({
        snapshot: {
          title: 'Runtime Title', summary: 'Runtime summary', background: null, solution: null, year: 2026,
          program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
          industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
          posterText: POSTER_TEXT, accessibilityText: ACCESSIBILITY_TEXT,
          citations: [], externalLinks: [], industryCategories: [],
        },
        media: [],
        responseState: { type: 'unresponded' },
      });
      assert(html.includes('Poster Full Text'), 'Participant preview omits the poster full text section.');
      assert(html.includes('Accessibility Description'), 'Participant preview omits the accessibility description section.');
      const responseSection = html.indexOf('<h3>Your Response</h3>');
      assert(responseSection > -1, 'Participant preview lost its response section.');
      assert(html.indexOf('Poster Full Text') < responseSection, 'Poster full text renders after the confirmation controls.');
      assert(html.indexOf('Accessibility Description') < responseSection, 'Accessibility description renders after the confirmation controls.');
    });

    await scenario(32, 'Participant preview escapes hostile accessible content and leaks no internal state', () => {
      const html = renderParticipantPreviewPage({
        snapshot: {
          title: 'Runtime Title', summary: 'Runtime summary', background: null, solution: null, year: 2026,
          program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
          industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
          posterText: '<script>evil()</script>\nsecond line',
          accessibilityText: '<img src=x onerror=alert(1)>',
          citations: [], externalLinks: [], industryCategories: [],
        },
        media: [],
        responseState: { type: 'unresponded' },
      });
      assert(!html.includes('<script>evil()</script>'), 'Poster full text emitted raw script markup.');
      assert(!html.includes('<img src=x onerror=alert(1)>'), 'Accessibility text emitted raw image markup.');
      assert(html.includes('&lt;script&gt;evil()&lt;/script&gt;'), 'Poster full text was not HTML-escaped.');
      assert(html.includes('<br/>second line'), 'Newlines in poster full text did not render safely.');
      assert(!/poster_text_public|accessibility_text_public|import_batch/i.test(html), 'Participant preview leaked internal column or batch state.');
    });

    await scenario(33, 'Accessible content stays inside the canonical participant snapshot', () => {
      const snapshotKeys = queryLocalJson<string[]>(`
        SELECT pg_catalog.to_jsonb(ARRAY(
          SELECT pg_catalog.jsonb_object_keys(
            public.get_project_publication_readiness('${prefix}-nonexistent', '${fixture!.admin.id}'::uuid, ${sqlText(PRIVATE_BUCKET)})
          )
        ))
      `);
      assert(Array.isArray(snapshotKeys), 'Readiness response was not inspectable.');
      const definition = executeLocalSql(`
        SELECT pg_get_functiondef(p.oid) FROM pg_proc p
        WHERE p.proname = 'get_project_publication_readiness' AND p.pronamespace = 'public'::regnamespace
      `);
      assert(definition.includes("'posterText', p.poster_text_public"), 'posterText left the canonical participant snapshot.');
      assert(definition.includes("'accessibilityText', p.accessibility_text_public"), 'accessibilityText left the canonical participant snapshot.');
    });

    // ---------------------------------------------------------------- Publication readiness
    await scenario(34, 'Publication readiness rejects an approved project with blank poster full text', async () => {
      const project = seedProject(prefix, 'ready-no-poster', fixture!, { status: 'approved', posterText: null });
      const result = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ ready?: boolean; resultCode?: string; blockers?: string[] }>;
      assert(result.data?.ready === false, 'Readiness accepted a project with no poster full text.');
      assert(result.data?.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED', `Readiness returned ${result.data?.resultCode}.`);
      assert(result.data?.blockers?.includes('Poster full text is missing'), 'Poster full text blocker was not reported.');
    });

    await scenario(35, 'Publication readiness rejects an approved project with blank accessibility text', async () => {
      const project = seedProject(prefix, 'ready-no-a11y', fixture!, { status: 'approved', accessibilityText: null });
      const result = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ ready?: boolean; resultCode?: string; blockers?: string[] }>;
      assert(result.data?.ready === false, 'Readiness accepted a project with no accessibility text.');
      assert(result.data?.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED', `Readiness returned ${result.data?.resultCode}.`);
      assert(result.data?.blockers?.includes('Accessibility text is missing'), 'Accessibility text blocker was not reported.');
    });

    await scenario(36, 'An older participant preview cannot carry a non-compliant project to ready', async () => {
      const project = seedProject(prefix, 'ready-stale-preview', fixture!, { status: 'approved' });
      const tokenHash = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      const preview = await serviceClient.rpc('generate_participant_preview', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_token_hash: tokenHash,
        p_expires_in_seconds: 3600, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ resultCode?: string }>;
      assert(preview.data?.resultCode === 'SUCCESS', `Preview generation returned ${preview.data?.resultCode}.`);
      const confirmed = await serviceClient.rpc('confirm_participant_preview', { p_token_hash: tokenHash }) as RpcResult<{ resultCode?: string }>;
      assert(confirmed.data?.resultCode === 'SUCCESS', `Preview confirmation returned ${confirmed.data?.resultCode}.`);

      // Blank the accessible content directly, simulating any path that could empty it after
      // confirmation. Readiness must fail closed rather than trust the older confirmation.
      executeLocalSql(`UPDATE public.projects SET poster_text_public = NULL WHERE public_id = ${sqlText(project)}`);
      const result = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ ready?: boolean; resultCode?: string }>;
      assert(result.data?.ready === false, 'A confirmed preview carried a non-compliant project to ready.');
      assert(result.data?.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED', `Readiness returned ${result.data?.resultCode}.`);
    });

    await scenario(37, 'Changing accessible content after confirmation invalidates that confirmation', async () => {
      const project = seedProject(prefix, 'ready-snapshot', fixture!, { status: 'approved' });
      const tokenHash = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      await serviceClient.rpc('generate_participant_preview', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_token_hash: tokenHash,
        p_expires_in_seconds: 3600, p_private_bucket: PRIVATE_BUCKET,
      });
      await serviceClient.rpc('confirm_participant_preview', { p_token_hash: tokenHash });

      executeLocalSql(`UPDATE public.projects SET poster_text_public = 'Materially different poster text' WHERE public_id = ${sqlText(project)}`);
      const result = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ ready?: boolean; resultCode?: string }>;
      assert(result.data?.ready === false, 'Stale confirmation authorized changed accessible content.');
      assert(result.data?.resultCode === 'PROJECT_SNAPSHOT_STALE', `Readiness returned ${result.data?.resultCode}.`);
    });

    await scenario(38, 'Compliant accessible content passes the accessibility portion of readiness', async () => {
      const project = seedProject(prefix, 'ready-passes', fixture!, { status: 'approved' });
      const result = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'NO_ACTIVE_PREVIEW',
        `Readiness stopped at ${result.data?.resultCode} rather than falling through to the ordinary preview gate.`);
    });

    // ---------------------------------------------------------------- Public feed
    await scenario(39, 'Public-feed validation rejects a blank poster full text', () => {
      const result = validatePublicFeed(compilePublicFeed([createMockProject({ status: 'published', posterText: '' })]));
      assert(!result.valid, 'Public feed accepted a record with no poster full text.');
      assert(result.errors.some((error) => error.includes('"posterText" is empty')), 'Poster full text error was not reported.');
    });

    await scenario(40, 'Public-feed validation rejects a blank accessibility text', () => {
      const result = validatePublicFeed(compilePublicFeed([createMockProject({ status: 'published', accessibilityText: '' })]));
      assert(!result.valid, 'Public feed accepted a record with no accessibility text.');
      assert(result.errors.some((error) => error.includes('"accessibilityText" is empty')), 'Accessibility text error was not reported.');
    });

    await scenario(41, 'A compliant public record carries both values and no internal state', () => {
      const compiled = compilePublicFeed([createMockProject({ status: 'published', posterText: POSTER_TEXT, accessibilityText: ACCESSIBILITY_TEXT })]);
      const result = validatePublicFeed(compiled);
      assert(result.valid && result.errors.length === 0, `Compliant public record was invalid: ${result.errors.join('; ')}`);
      assert(compiled[0].posterText === POSTER_TEXT && compiled[0].accessibilityText === ACCESSIBILITY_TEXT, 'Compiled feed dropped accessible content.');
      const serialized = JSON.stringify(compiled[0]);
      assert(!/importBatchId|internalStaffNotes|validationFlags|sourceFolder/i.test(serialized), 'Compiled public record leaked internal state.');
    });

    // ---------------------------------------------------------------- Bounded-content authority
    // The declared ceilings are only real if a value that reached the table by any path — notably
    // the deliberately permissive legacy project.json route — still cannot progress.
    const oversizedPoster = 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText + 1);
    const oversizedAccessibility = 'y'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText + 1);

    await scenario(42, 'Review submission rejects oversized poster full text with zero mutation', async () => {
      const project = seedProject(prefix, 'submit-big-poster', fixture!, {
        posterText: oversizedPoster, inBatch: true, withMedia: true,
      });
      const result = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [project], p_admin_id: fixture!.editor.id, p_comments: null,
      }) as RpcResult<{ resultCode?: string; blockingReasons?: string[] }>;
      assert(result.data?.resultCode === 'READINESS_BLOCKED', `Oversized submission returned ${result.data?.resultCode}.`);
      assert(result.data?.blockingReasons?.includes('POSTER_TEXT_TOO_LONG'), 'POSTER_TEXT_TOO_LONG was not reported.');
      const state = projectState(project);
      assert(state.status === 'draft' && state.audits === 0, 'Oversized submission mutated status or audit history.');
    });

    await scenario(43, 'Review submission rejects oversized accessibility text with zero mutation', async () => {
      const project = seedProject(prefix, 'submit-big-a11y', fixture!, {
        accessibilityText: oversizedAccessibility, inBatch: true, withMedia: true,
      });
      const result = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [project], p_admin_id: fixture!.editor.id, p_comments: null,
      }) as RpcResult<{ resultCode?: string; blockingReasons?: string[] }>;
      assert(result.data?.resultCode === 'READINESS_BLOCKED', `Oversized submission returned ${result.data?.resultCode}.`);
      assert(result.data?.blockingReasons?.includes('ACCESSIBILITY_TEXT_TOO_LONG'), 'ACCESSIBILITY_TEXT_TOO_LONG was not reported.');
      const state = projectState(project);
      assert(state.status === 'draft' && state.audits === 0, 'Oversized submission mutated status or audit history.');
    });

    await scenario(44, 'Approval rejects oversized accessible content with zero mutation and zero audit', async () => {
      const project = seedProject(prefix, 'approve-big-a11y', fixture!, {
        status: 'submitted', accessibilityText: oversizedAccessibility,
      });
      const result = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: project, p_action: 'approve', p_comments: null, p_admin_id: fixture!.reviewer.id,
      }) as RpcResult<{ resultCode?: string }>;
      assert(result.data?.resultCode === 'ACCESSIBILITY_CONTENT_INVALID', `Oversized approval returned ${result.data?.resultCode}.`);
      const state = projectState(project);
      assert(state.status === 'submitted' && state.audits === 0, 'Oversized approval mutated status or created an approval audit.');
      // The value is rejected, never silently shortened to fit.
      assert(state.accessibilityText === oversizedAccessibility, 'Oversized accessibility text was mutated by the rejected approval.');
    });

    await scenario(45, 'Publication readiness rejects oversized accessible content', async () => {
      const project = seedProject(prefix, 'ready-big-poster', fixture!, { status: 'approved', posterText: oversizedPoster });
      const result = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ ready?: boolean; resultCode?: string; blockers?: string[] }>;
      assert(result.data?.ready === false, 'Readiness accepted oversized poster full text.');
      assert(result.data?.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED', `Readiness returned ${result.data?.resultCode}.`);
      assert(
        result.data?.blockers?.some((blocker) => blocker.includes('exceeds the 20,000 character safety limit')),
        'Oversize blocker was not reported truthfully as an oversize.',
      );
      assert(
        !result.data?.blockers?.some((blocker) => blocker.includes('Poster full text is missing')),
        'An oversized value was misreported as missing.',
      );
    });

    await scenario(46, 'Values exactly at each ceiling pass every database gate', async () => {
      const atLimitPoster = 'x'.repeat(ACCESSIBLE_CONTENT_LIMITS.posterText);
      const atLimitAccessibility = 'y'.repeat(ACCESSIBLE_CONTENT_LIMITS.accessibilityText);
      const project = seedProject(prefix, 'at-limit', fixture!, {
        status: 'submitted', posterText: atLimitPoster, accessibilityText: atLimitAccessibility,
      });
      const approval = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: project, p_action: 'approve', p_comments: null, p_admin_id: fixture!.reviewer.id,
      }) as RpcResult<{ status?: string }>;
      assert(approval.data?.status === 'approved', `At-limit approval returned ${JSON.stringify(approval.data)}.`);

      const readiness = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: project, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult<{ resultCode?: string }>;
      assert(readiness.data?.resultCode === 'NO_ACTIVE_PREVIEW',
        `At-limit readiness stopped at ${readiness.data?.resultCode} rather than the ordinary preview gate.`);

      const state = projectState(project);
      assert(state.posterText === atLimitPoster && state.accessibilityText === atLimitAccessibility,
        'At-limit accessible content was altered while passing the gates.');
    });

    await scenario(47, 'Public-feed validation rejects oversized accessible content', () => {
      const overPoster = validatePublicFeed(compilePublicFeed([createMockProject({ status: 'published', posterText: oversizedPoster })]));
      assert(!overPoster.valid, 'Public feed accepted oversized poster full text.');
      assert(overPoster.errors.some((error) => error.includes('"posterText" exceeds')), 'Oversized poster feed error was not reported.');

      const overAccessibility = validatePublicFeed(compilePublicFeed([createMockProject({ status: 'published', accessibilityText: oversizedAccessibility })]));
      assert(!overAccessibility.valid, 'Public feed accepted oversized accessibility text.');
      assert(overAccessibility.errors.some((error) => error.includes('"accessibilityText" exceeds')), 'Oversized accessibility feed error was not reported.');
    });

    // ---------------------------------------------------------------- Isolation guarantees
    await scenario(48, 'No email, notification, or reminder state was created by this verifier', () => {
      const counts = queryLocalJson<{ notifications: number; schedules: number }>(`
        SELECT pg_catalog.jsonb_build_object(
          'notifications', (SELECT pg_catalog.count(*) FROM public.participant_preview_notifications n
             JOIN public.participant_previews pp ON pp.id = n.participant_preview_id
             JOIN public.projects p ON p.id = pp.project_id WHERE p.public_id LIKE ${sqlText(`${prefix}-%`)}),
          'schedules', (SELECT pg_catalog.count(*) FROM public.participant_preview_reminder_schedules s
             JOIN public.participant_previews pp ON pp.id = s.participant_preview_id
             JOIN public.projects p ON p.id = pp.project_id WHERE p.public_id LIKE ${sqlText(`${prefix}-%`)})
        )
      `);
      assert(counts.notifications === 0, 'The verifier created participant notification state.');
      assert(counts.schedules === 0, 'The verifier created participant reminder state.');
    });

    await scenario(49, 'No publication or public-removal attempt was created by this verifier', () => {
      const counts = queryLocalJson<{ publications: number; removals: number }>(`
        SELECT pg_catalog.jsonb_build_object(
          'publications', (SELECT pg_catalog.count(*) FROM public.publication_attempts a
             JOIN public.projects p ON p.id = a.project_id WHERE p.public_id LIKE ${sqlText(`${prefix}-%`)}),
          'removals', (SELECT pg_catalog.count(*) FROM public.public_removal_attempts a
             JOIN public.projects p ON p.id = a.project_id WHERE p.public_id LIKE ${sqlText(`${prefix}-%`)})
        )
      `);
      assert(counts.publications === 0, 'The verifier reserved a publication attempt.');
      assert(counts.removals === 0, 'The verifier reserved a public-removal attempt.');
    });

    assert(scenarioCount === 49, `Expected 49 independently asserted scenarios, completed ${scenarioCount}.`);
  } catch (error) {
    verifierError = error;
  } finally {
    try {
      executeLocalSql(`
        DELETE FROM public.participant_preview_confirmations c USING public.participant_previews pp, public.projects p
          WHERE c.participant_preview_id = pp.id AND pp.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.participant_previews pp USING public.projects p
          WHERE pp.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.approval_records ar USING public.projects p
          WHERE ar.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.media_assets ma USING public.projects p
          WHERE ma.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.projects WHERE public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.import_batches WHERE id = '${fixture ? fixture.batchId : randomUUID()}'::uuid;
        DELETE FROM public.admin_users WHERE email LIKE ${sqlText(`${prefix}-%@example.test`)};
        ${fixture ? `DELETE FROM public.programs WHERE id = '${fixture.program.id}'::uuid;` : ''}
        ${fixture ? `DELETE FROM public.disciplines WHERE id = '${fixture.discipline.id}'::uuid;` : ''}
        ${fixture ? `DELETE FROM public.industry_categories WHERE id = '${fixture.industry.id}'::uuid;` : ''}
      `);

      const residue = queryLocalJson<{ projects: number; actors: number; batches: number }>(`
        SELECT pg_catalog.jsonb_build_object(
          'projects', (SELECT pg_catalog.count(*) FROM public.projects WHERE public_id LIKE ${sqlText(`${prefix}-%`)}),
          'actors', (SELECT pg_catalog.count(*) FROM public.admin_users WHERE email LIKE ${sqlText(`${prefix}-%@example.test`)}),
          'batches', (SELECT pg_catalog.count(*) FROM public.import_batches WHERE id = '${fixture ? fixture.batchId : randomUUID()}'::uuid)
        )
      `);
      if (residue.projects !== 0 || residue.actors !== 0 || residue.batches !== 0) {
        throw new Error(`Verifier-owned rows survived cleanup: ${JSON.stringify(residue)}`);
      }
    } catch (cleanupError) {
      if (!verifierError) verifierError = cleanupError;
    }
  }

  if (verifierError) throw verifierError;
  console.log(`Accessibility full-text runtime verification passed (${scenarioCount} independently asserted scenarios).`);
}

if (require.main === module) {
  verifyAccessibilityFullTextRuntime().catch((error) => {
    console.error('Accessibility full-text runtime verification failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
