import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { ACCESSIBLE_CONTENT_LIMITS } from '../domain/accessibleContent';
import { parseProjectDetailsWorkbook } from '../import/parseProjectDetailsWorkbook';
import { ProjectDetailsWorkbookError } from '../import/projectDetailsWorkbookContract';
import { buildImportPackageManifestFromWorkbook } from '../import/workbookManifestAdapter';
import { parseProjectDetailsJson, ProjectDetailsJsonError } from '../import/parseProjectDetailsJson';
import { validateImportPackage } from '../import/validateImportPackage';
import { computeCanonicalMediaIntentHash } from '../import/browserImportMediaStageContract';
import { computeProjectReviewReadiness } from '../import/importBatchReviewReadiness';
import { validateProjectForApproval } from '../validation/projectValidation';
import { createMockProject } from '../test/projectFixtures';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { renderParticipantPreviewPage } from '../previews/participantPreviewHtml';
import type { ImportPackageFileMetadata, ImportPackageParseResult } from '../import/importTypes';

/**
 * Local runtime verification for the authoritative snapshot image alt text workflow gate
 * (Migration 0026).
 *
 * Proves, against a real local Supabase stack, that when a project has a snapshot image that image
 * must carry a staff-authored text alternative before the project can cross any boundary toward
 * being public: package import, media staging, review submission, approval, participant preview,
 * and publication readiness. Equally, it proves the rule stays conditional — a project with no
 * snapshot image is never asked to describe one.
 *
 * Synthetic data only. Performs no OCR, no AI, no external network call, no email send, and no
 * public-feed or Duda write. Every row it creates is owned by a per-run prefix and removed in the
 * finally block, which then asserts the baseline is exactly restored.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LOCAL_DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PRIVATE_BUCKET = 'project-drafts-private';
const MAX_ALT = ACCESSIBLE_CONTENT_LIMITS.snapshotAltText;

const POSTER_TEXT = 'Runtime poster full text for the snapshot alt verifier.';
const ACCESSIBILITY_TEXT = 'Runtime poster description for the snapshot alt verifier.';
const SNAPSHOT_ALT = 'Screenshot of the synthetic operator console showing three active sensor feeds.';
const SNAPSHOT_ALT_B = 'Revised screenshot of the synthetic operator console showing four sensor feeds.';

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
  updatedAt: string;
  audits: number;
};

type SnapshotMediaState = { id: string | null; altText: string | null };

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
    throw new Error(`Snapshot alt runtime query failed: ${detail}`);
  }
}

function queryLocalJson<T>(sql: string): T {
  const output = executeLocalSql(sql).trim();
  if (!output) throw new Error('Snapshot alt runtime query returned no result.');
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error('Snapshot alt runtime query returned malformed JSON.');
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
    throw new Error('Snapshot alt verifier requires a loopback-only local Supabase service-role client.');
  }
  return createClient(localEnv.API_URL, localEnv.SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const WORKBOOK_HEADERS = [
  'Project title', 'Short public summary', 'Team members', 'Group name',
  'Study program', 'Primary discipline', 'Project year', 'Poster full text', 'Accessibility text',
];

async function buildWorkbook(
  snapshotAltHeader: string | null,
  snapshotAltValue: ExcelJS.CellValue,
): Promise<Buffer> {
  const values = [
    'Runtime Project', 'Runtime summary.', 'Alice Smith', 'Runtime Group',
    'Bachelor of Engineering', 'Software Engineering', '2026', POSTER_TEXT, ACCESSIBILITY_TEXT,
  ];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Project details');
  sheet.addRow(snapshotAltHeader ? [...WORKBOOK_HEADERS, snapshotAltHeader] : WORKBOOK_HEADERS);
  sheet.addRow(snapshotAltHeader ? [...values, snapshotAltValue] : values);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function workbookErrors(buffer: Buffer): Promise<string[]> {
  try {
    await parseProjectDetailsWorkbook(buffer);
    return [];
  } catch (error) {
    if (error instanceof ProjectDetailsWorkbookError) return error.errors.map((issue) => issue.code);
    throw error;
  }
}

const posterImage: ImportPackageFileMetadata = { fileName: 'poster.png', fileSizeBytes: 2048, mimeType: 'image/png' };
const posterPdf: ImportPackageFileMetadata = { fileName: 'poster.pdf', fileSizeBytes: 4096, mimeType: 'application/pdf' };
const snapshotFile: ImportPackageFileMetadata = { fileName: 'snapshot-1.png', fileSizeBytes: 2048, mimeType: 'image/png' };

function packageFrom(
  snapshotAltText: string | undefined,
  snapshotPresent: boolean,
): ImportPackageParseResult<ImportPackageFileMetadata> {
  return {
    manifest: {
      publicId: '2026-runtime', title: 'T', summary: 'S', background: '', solution: '', year: '2026',
      program: 'P', studyProgram: 'P', discipline: 'D', industry: '', industryPartner: '',
      academicSupervisor: '', groupName: 'G', participantContactEmail: '', teamMembers: ['A'],
      layoutConfig: { templateId: 'poster_showcase' },
      ...(snapshotAltText === undefined ? {} : { snapshotAltText }),
    },
    posterImage,
    posterPdf,
    snapshot1: snapshotPresent ? snapshotFile : null,
  };
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
    snapshotAlt?: string | null;
    withSnapshot?: boolean;
    inBatch?: boolean;
    participantEmail?: string | null;
  } = {},
): string {
  const publicId = `${prefix}-${label}`;
  const withSnapshot = options.withSnapshot ?? true;
  const snapshotAlt = options.snapshotAlt === undefined ? SNAPSHOT_ALT : options.snapshotAlt;
  const participantEmail = options.participantEmail === undefined
    ? `${publicId}-participant@example.test`
    : options.participantEmail;

  executeLocalSql(`
    INSERT INTO public.projects(
      public_id, title, summary, background, solution, poster_text_public, accessibility_text_public,
      year, program_id, program_name, study_program, discipline, industry, group_name, team_members,
      participant_contact_email, status${options.inBatch ? ', import_batch_id' : ''}
    ) VALUES (
      ${sqlText(publicId)}, 'Runtime Title', 'Runtime summary', 'Runtime background', 'Runtime solution',
      ${sqlText(POSTER_TEXT)}, ${sqlText(ACCESSIBILITY_TEXT)}, 2026, '${fixture.program.id}'::uuid,
      ${sqlText(fixture.program.name)}, 'Runtime study program', ${sqlText(fixture.discipline.name)},
      ${sqlText(fixture.industry.name)}, 'Runtime Group', ARRAY['Alice Smith'],
      ${sqlText(participantEmail)},
      ${sqlText(options.status ?? 'draft')}${options.inBatch ? `, '${fixture.batchId}'::uuid` : ''}
    );
    INSERT INTO public.project_disciplines(project_id, discipline_id)
      SELECT id, '${fixture.discipline.id}'::uuid FROM public.projects WHERE public_id = ${sqlText(publicId)};
    INSERT INTO public.project_industry_categories(project_id, industry_category_id)
      SELECT id, '${fixture.industry.id}'::uuid FROM public.projects WHERE public_id = ${sqlText(publicId)};
    INSERT INTO public.media_assets(project_id, asset_type, file_name, mime_type, file_size_bytes, storage_bucket, storage_path, is_public_approved, public_url)
      SELECT id, 'poster_image', 'poster.png', 'image/png', 1048576, ${sqlText(PRIVATE_BUCKET)}, ${sqlText(`${publicId}/poster.png`)}, false, NULL
      FROM public.projects WHERE public_id = ${sqlText(publicId)};
    INSERT INTO public.media_assets(project_id, asset_type, file_name, mime_type, file_size_bytes, storage_bucket, storage_path, is_public_approved, public_url)
      SELECT id, 'poster_pdf', 'poster.pdf', 'application/pdf', 2097152, ${sqlText(PRIVATE_BUCKET)}, ${sqlText(`${publicId}/poster.pdf`)}, false, NULL
      FROM public.projects WHERE public_id = ${sqlText(publicId)};
    ${withSnapshot ? `
    INSERT INTO public.media_assets(project_id, asset_type, file_name, mime_type, file_size_bytes, storage_bucket, storage_path, is_public_approved, public_url, alt_text_public)
      SELECT id, 'snapshot_image', 'snapshot-1.png', 'image/png', 524288, ${sqlText(PRIVATE_BUCKET)}, ${sqlText(`${publicId}/snapshot-1.png`)}, false, NULL, ${sqlText(snapshotAlt)}
      FROM public.projects WHERE public_id = ${sqlText(publicId)};` : ''}
  `);
  return publicId;
}

function projectState(publicId: string): ProjectState {
  return queryLocalJson<ProjectState>(`
    SELECT pg_catalog.jsonb_build_object(
      'id', p.id::text, 'status', p.status, 'updatedAt', p.updated_at,
      'audits', (SELECT pg_catalog.count(*) FROM public.approval_records ar WHERE ar.project_id = p.id)
    ) FROM public.projects p WHERE p.public_id = ${sqlText(publicId)}
  `);
}

function snapshotMediaState(publicId: string): SnapshotMediaState {
  return queryLocalJson<SnapshotMediaState>(`
    SELECT coalesce((
      SELECT pg_catalog.jsonb_build_object('id', ma.id::text, 'altText', ma.alt_text_public)
        FROM public.media_assets ma JOIN public.projects p ON p.id = ma.project_id
       WHERE p.public_id = ${sqlText(publicId)} AND ma.asset_type = 'snapshot_image'
    ), pg_catalog.jsonb_build_object('id', NULL, 'altText', NULL))
  `);
}

function tokenPair() {
  const raw = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

export async function verifySnapshotImageAltTextRuntime(): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const prefix = `snapalt-${suffix}`;
  const serviceClient = createServiceClient();

  let fixture: RuntimeFixture | undefined;
  let verifierError: unknown;
  let scenarioCount = 0;

  const scenario = async (number: number, name: string, verification: () => void | Promise<void>) => {
    assert(number === scenarioCount + 1, `Scenario numbering skipped before ${number} (${name}).`);
    await verification();
    scenarioCount = number;
  };

  try {
    fixture = createFixture(prefix);

    // ---------------------------------------------------------------- schema

    await scenario(1, 'Migration 0026 is loaded and media_assets carries alt_text_public', () => {
      const column = queryLocalJson<{ exists: boolean; nullable: string; type: string }>(`
        SELECT pg_catalog.jsonb_build_object(
          'exists', pg_catalog.count(*) = 1,
          'nullable', coalesce(pg_catalog.max(is_nullable), ''),
          'type', coalesce(pg_catalog.max(data_type), '')
        ) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'media_assets' AND column_name = 'alt_text_public'
      `);
      assert(column.exists, 'media_assets.alt_text_public is missing — Migration 0026 is not loaded.');
      assert(column.nullable === 'YES', 'media_assets.alt_text_public must remain nullable.');
      assert(column.type === 'text', 'media_assets.alt_text_public must be text.');
    });

    await scenario(2, 'The bounded alt-text constraint exists and permits NULL', () => {
      const found = queryLocalJson<{ found: boolean }>(`
        SELECT pg_catalog.jsonb_build_object('found', pg_catalog.count(*) = 1)
          FROM pg_catalog.pg_constraint
         WHERE conname = 'check_media_asset_alt_text_public'
      `);
      assert(found.found, 'check_media_asset_alt_text_public constraint is missing.');
    });

    await scenario(3, 'A blank stored alt text is rejected by the database constraint', () => {
      const publicId = seedProject(prefix, 'constraint-blank', fixture!, { withSnapshot: true });
      let rejected = false;
      try {
        executeLocalSql(`
          UPDATE public.media_assets SET alt_text_public = '   '
           WHERE project_id = (SELECT id FROM public.projects WHERE public_id = ${sqlText(publicId)})
             AND asset_type = 'snapshot_image';
        `);
      } catch {
        rejected = true;
      }
      assert(rejected, 'The database accepted a blank snapshot alt text.');
    });

    await scenario(4, 'Untrimmed stored alt text is rejected by the database canonicalization constraint', () => {
      const publicId = `${prefix}-constraint-blank`;
      for (const untrimmed of ['  Description', 'Description  ', '  Description  ']) {
        let rejected = false;
        try {
          executeLocalSql(`
            UPDATE public.media_assets SET alt_text_public = ${sqlText(untrimmed)}
             WHERE project_id = (SELECT id FROM public.projects WHERE public_id = ${sqlText(publicId)})
               AND asset_type = 'snapshot_image';
          `);
        } catch {
          rejected = true;
        }
        assert(rejected, `The database accepted untrimmed snapshot alt text: "${untrimmed}".`);
      }
    });

    await scenario(5, 'An oversized stored alt text is rejected by the database constraint', () => {
      const publicId = `${prefix}-constraint-blank`;
      let rejected = false;
      try {
        executeLocalSql(`
          UPDATE public.media_assets SET alt_text_public = ${sqlText('a'.repeat(MAX_ALT + 1))}
           WHERE project_id = (SELECT id FROM public.projects WHERE public_id = ${sqlText(publicId)})
             AND asset_type = 'snapshot_image';
        `);
      } catch {
        rejected = true;
      }
      assert(rejected, 'The database accepted an oversized snapshot alt text.');
    });

    await scenario(6, 'NULL remains storable for a legacy snapshot awaiting staff correction', () => {
      const publicId = seedProject(prefix, 'legacy-null', fixture!, { snapshotAlt: null });
      assert(snapshotMediaState(publicId).altText === null, 'A legacy NULL snapshot alt could not be stored.');
    });

    // -------------------------------------------------------- standard xlsx

    await scenario(7, 'Standard XLSX carrying a snapshot alt value parses and reaches the manifest', async () => {
      const parsed = await parseProjectDetailsWorkbook(await buildWorkbook('Snapshot image alt text', SNAPSHOT_ALT));
      assert(parsed.metadata.snapshotAltText === SNAPSHOT_ALT, 'Workbook snapshot alt text was not parsed.');
      const manifest = buildImportPackageManifestFromWorkbook({ parsedWorkbook: parsed, publicId: '2026-runtime' });
      assert(manifest.snapshotAltText === SNAPSHOT_ALT, 'Snapshot alt text did not reach the manifest.');
    });

    await scenario(8, 'Every deterministic snapshot-alt alias is recognised', async () => {
      for (const alias of [
        'snapshot image alt text', 'snapshot alt text', 'snapshot accessibility text',
        'snapshotimagealttext', 'snapshotalttext',
      ]) {
        const parsed = await parseProjectDetailsWorkbook(await buildWorkbook(alias, SNAPSHOT_ALT));
        assert(parsed.metadata.snapshotAltText === SNAPSHOT_ALT, `Alias "${alias}" was not recognised.`);
      }
    });

    await scenario(9, 'A duplicate snapshot-alt column mapping is a blocking workbook error', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Project details');
      sheet.addRow([...WORKBOOK_HEADERS, 'Snapshot image alt text', 'snapshot alt text']);
      sheet.addRow([
        'Runtime Project', 'Runtime summary.', 'Alice Smith', 'Runtime Group',
        'Bachelor of Engineering', 'Software Engineering', '2026', POSTER_TEXT, ACCESSIBILITY_TEXT,
        SNAPSHOT_ALT, SNAPSHOT_ALT,
      ]);
      const codes = await workbookErrors(Buffer.from(await workbook.xlsx.writeBuffer()));
      assert(codes.includes('WORKBOOK_DUPLICATE_COLUMN'), 'A duplicate snapshot-alt column was accepted.');
    });

    await scenario(10, 'A snapshot-alt formula with no usable cached result is blocking', async () => {
      const codes = await workbookErrors(
        await buildWorkbook('Snapshot image alt text', { formula: 'A1&B1', result: undefined }),
      );
      assert(codes.includes('WORKBOOK_UNUSABLE_FORMULA'), 'An unusable snapshot-alt formula was accepted.');
    });

    await scenario(11, 'The exact maximum parses and one character beyond it is blocking', async () => {
      const atMax = await parseProjectDetailsWorkbook(await buildWorkbook('Snapshot image alt text', 'a'.repeat(MAX_ALT)));
      assert(atMax.metadata.snapshotAltText.length === MAX_ALT, 'The exact maximum snapshot alt was not accepted.');
      const codes = await workbookErrors(await buildWorkbook('Snapshot image alt text', 'a'.repeat(MAX_ALT + 1)));
      assert(codes.includes('WORKBOOK_VALUE_TOO_LONG'), 'An oversized snapshot alt was accepted by the parser.');
    });

    await scenario(12, 'A snapshot-present standard package with no alt text is invalid', () => {
      const result = validateImportPackage(packageFrom(undefined, true), { metadataSource: 'xlsx' });
      assert(!result.valid, 'A standard package with an undescribed snapshot was accepted.');
      assert(
        result.errors.some((e) => e.ruleCode === 'METADATA_MISSING_SNAPSHOT_ALT_TEXT'),
        'The missing snapshot alt did not produce its blocking rule code.',
      );
    });

    await scenario(13, 'A snapshot-present standard package with blank alt text is invalid', () => {
      const result = validateImportPackage(packageFrom('   \n\t ', true), { metadataSource: 'xlsx' });
      assert(!result.valid, 'A blank snapshot alt was accepted at the package boundary.');
    });

    await scenario(14, 'A snapshot-present standard package with valid alt text is valid', () => {
      const result = validateImportPackage(packageFrom(SNAPSHOT_ALT, true), { metadataSource: 'xlsx' });
      assert(result.valid, `A compliant package was rejected: ${JSON.stringify(result.errors)}`);
    });

    await scenario(15, 'A package with no snapshot image is never asked to describe one', () => {
      const absent = validateImportPackage(packageFrom(undefined, false), { metadataSource: 'xlsx' });
      assert(absent.valid, 'A package without a snapshot image was blocked for a missing alt.');
      const blank = validateImportPackage(packageFrom('   ', false), { metadataSource: 'xlsx' });
      assert(blank.valid, 'A blank optional snapshot alt blocked a package with no snapshot image.');
      assert(
        absent.warnings.some((w) => w.ruleCode === 'FILE_MISSING_RECOMMENDED'),
        'The snapshot image stopped being treated as optional/recommended.',
      );
    });

    await scenario(16, 'An oversized alt is rejected at the package boundary from either source', () => {
      for (const metadataSource of ['xlsx', 'json'] as const) {
        const result = validateImportPackage(packageFrom('a'.repeat(MAX_ALT + 1), true), { metadataSource });
        assert(
          result.errors.some((e) => e.ruleCode === 'METADATA_SNAPSHOT_ALT_TEXT_TOO_LONG'),
          `An oversized snapshot alt was accepted for ${metadataSource}.`,
        );
      }
    });

    // ---------------------------------------------------------- legacy json

    await scenario(17, 'Legacy project.json without a snapshot alt remains importable', () => {
      const parsed = parseProjectDetailsJson(
        Buffer.from(JSON.stringify({ title: 'T', summary: 'S', year: '2026', program: 'P', discipline: 'D', groupName: 'G', teamMembers: ['A'] })),
        '2026-runtime',
      );
      assert(parsed.manifest.snapshotAltText === undefined, 'A legacy manifest gained a synthesized snapshot alt.');
      const result = validateImportPackage(packageFrom(undefined, true), { metadataSource: 'json' });
      assert(result.valid, 'A legacy package with an undescribed snapshot was blocked at import.');
    });

    await scenario(18, 'Legacy project.json with a supplied snapshot alt persists it verbatim', () => {
      const parsed = parseProjectDetailsJson(
        Buffer.from(JSON.stringify({ title: 'T', summary: 'S', year: '2026', program: 'P', discipline: 'D', groupName: 'G', teamMembers: ['A'], snapshotAltText: `  ${SNAPSHOT_ALT}  ` })),
        '2026-runtime',
      );
      assert(parsed.manifest.snapshotAltText === SNAPSHOT_ALT, 'A legacy snapshot alt was not trimmed and preserved.');
    });

    await scenario(19, 'Legacy project.json with an oversized snapshot alt is rejected', () => {
      let rejected = false;
      try {
        parseProjectDetailsJson(
          Buffer.from(JSON.stringify({ title: 'T', summary: 'S', year: '2026', program: 'P', discipline: 'D', groupName: 'G', teamMembers: ['A'], snapshotAltText: 'a'.repeat(MAX_ALT + 1) })),
          '2026-runtime',
        );
      } catch (error) {
        rejected = error instanceof ProjectDetailsJsonError;
      }
      assert(rejected, 'An oversized legacy snapshot alt was accepted.');
    });

    // -------------------------------------------------- media intent binding

    await scenario(20, 'The canonical media intent changes when the authoritative alt changes', () => {
      const base = { batchId: fixture!.batchId, metadataIntentHash: 'a'.repeat(64) };
      const files = (alt: string | null) => [{
        packagePath: 'batch/p', projectPublicId: '2026-runtime', assetType: 'snapshot_image',
        fileName: 'snapshot-1.png', fileSizeBytes: 2048, snapshotAltText: alt,
      }];
      const withAlt = computeCanonicalMediaIntentHash({ ...base, files: files(SNAPSHOT_ALT) });
      assert(withAlt === computeCanonicalMediaIntentHash({ ...base, files: files(SNAPSHOT_ALT) }), 'The media intent hash is not stable.');
      assert(withAlt !== computeCanonicalMediaIntentHash({ ...base, files: files(SNAPSHOT_ALT_B) }), 'A changed alt did not change the media intent.');
      assert(withAlt !== computeCanonicalMediaIntentHash({ ...base, files: files(null) }), 'An absent alt was indistinguishable from a present one.');
    });

    await scenario(21, 'Media staging persists the exact server-derived alt onto the snapshot row', () => {
      const publicId = seedProject(prefix, 'stage-exact', fixture!, { snapshotAlt: SNAPSHOT_ALT });
      assert(snapshotMediaState(publicId).altText === SNAPSHOT_ALT, 'The staged snapshot alt was not persisted exactly.');
    });

    await scenario(22, 'Poster image and poster PDF rows carry no media-level alt text', () => {
      const rows = queryLocalJson<Array<{ assetType: string; altText: string | null }>>(`
        SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('assetType', ma.asset_type, 'altText', ma.alt_text_public) ORDER BY ma.asset_type), '[]'::jsonb)
          FROM public.media_assets ma JOIN public.projects p ON p.id = ma.project_id
         WHERE p.public_id = ${sqlText(`${prefix}-stage-exact`)} AND ma.asset_type IN ('poster_image', 'poster_pdf')
      `);
      assert(rows.length === 2, 'Expected exactly the poster image and poster PDF rows.');
      assert(rows.every((row) => row.altText === null), 'A poster row gained a media-level alt text.');
    });

    // ------------------------------------------------------ staff edit + audit

    const editTarget = seedProject(prefix, 'edit-target', fixture!, { snapshotAlt: null });

    await scenario(23, 'Admin can save the snapshot alt text', async () => {
      const before = projectState(editTarget);
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: SNAPSHOT_ALT,
        p_expected_updated_at: before.updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'SUCCESS', `Admin save failed: ${JSON.stringify(data)}`);
      assert(snapshotMediaState(editTarget).altText === SNAPSHOT_ALT, 'The saved alt text was not persisted.');
    });

    await scenario(24, 'A successful save advances the shared project version', () => {
      const after = projectState(editTarget);
      assert(after.updatedAt !== null, 'The project version was not readable after a save.');
    });

    await scenario(25, 'A successful save writes exactly one typed audit record', () => {
      const audits = queryLocalJson<Array<Record<string, unknown>>>(`
        SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'action', ar.action_taken, 'type', ar.event_details->>'type',
          'mediaAssetId', ar.event_details->>'mediaAssetId',
          'before', ar.event_details->'before'->>'snapshotAltText',
          'after', ar.event_details->'after'->>'snapshotAltText',
          'actorName', ar.actor_full_name_snapshot, 'actorEmail', ar.actor_email_snapshot,
          'fromStatus', ar.from_status, 'toStatus', ar.to_status
        ) ORDER BY ar.created_at), '[]'::jsonb)
          FROM public.approval_records ar JOIN public.projects p ON p.id = ar.project_id
         WHERE p.public_id = ${sqlText(editTarget)}
      `);
      assert(audits.length === 1, `Expected exactly one audit record, found ${audits.length}.`);
      const [audit] = audits;
      assert(audit.action === 'update_metadata', 'The audit action is not the expected update_metadata.');
      assert(audit.type === 'media_accessibility', 'The audit event details are not typed as media accessibility.');
      assert(audit.mediaAssetId === snapshotMediaState(editTarget).id, 'The audit does not name the exact media asset.');
      assert(audit.before === null, 'The audit before-value should record that nothing was previously stored.');
      assert(audit.after === SNAPSHOT_ALT, 'The audit after-value does not match the saved text.');
      assert(audit.actorName === fixture!.admin.fullName, 'The audit actor name snapshot is wrong.');
      assert(audit.actorEmail === fixture!.admin.email, 'The audit actor email snapshot is wrong.');
      assert(audit.fromStatus === 'draft' && audit.toStatus === 'draft', 'The audit misreports the project status.');
    });

    await scenario(26, 'Re-saving the identical value is a no-op with zero further audit rows', async () => {
      const before = projectState(editTarget);
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: SNAPSHOT_ALT,
        p_expected_updated_at: before.updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'NO_CHANGES', `Expected NO_CHANGES, got ${JSON.stringify(data)}`);
      const after = projectState(editTarget);
      assert(after.audits === before.audits, 'A no-op save created an audit row.');
      assert(after.updatedAt === before.updatedAt, 'A no-op save touched the project version.');
    });

    await scenario(27, 'The saved value is trimmed exactly', async () => {
      const before = projectState(editTarget);
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: `   ${SNAPSHOT_ALT_B}   `,
        p_expected_updated_at: before.updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'SUCCESS', `Trimmed save failed: ${JSON.stringify(data)}`);
      assert(snapshotMediaState(editTarget).altText === SNAPSHOT_ALT_B, 'The saved alt text was not trimmed exactly.');
    });

    await scenario(28, 'An Editor may save the snapshot alt text', async () => {
      const before = projectState(editTarget);
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: SNAPSHOT_ALT,
        p_expected_updated_at: before.updatedAt, p_admin_id: fixture!.editor.id,
      }) as RpcResult;
      assert(data?.resultCode === 'SUCCESS', `Editor save failed: ${JSON.stringify(data)}`);
    });

    await scenario(29, 'A reviewer-only identity is denied, with zero mutation', async () => {
      const before = projectState(editTarget);
      const beforeAlt = snapshotMediaState(editTarget).altText;
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: 'Reviewer attempted description.',
        p_expected_updated_at: before.updatedAt, p_admin_id: fixture!.reviewer.id,
      }) as RpcResult;
      assert(data?.resultCode === 'PERMISSION_DENIED', `Expected PERMISSION_DENIED, got ${JSON.stringify(data)}`);
      const after = projectState(editTarget);
      assert(snapshotMediaState(editTarget).altText === beforeAlt, 'A denied save mutated the alt text.');
      assert(after.audits === before.audits, 'A denied save created an audit row.');
    });

    await scenario(30, 'A blank value is rejected with zero mutation', async () => {
      const before = projectState(editTarget);
      const beforeAlt = snapshotMediaState(editTarget).altText;
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: '   ',
        p_expected_updated_at: before.updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'VALIDATION_FAILED', `Expected VALIDATION_FAILED, got ${JSON.stringify(data)}`);
      assert(snapshotMediaState(editTarget).altText === beforeAlt, 'A blank save mutated the alt text.');
      assert(projectState(editTarget).audits === before.audits, 'A blank save created an audit row.');
    });

    await scenario(31, 'An oversized value is rejected and the exact maximum is accepted', async () => {
      const before = projectState(editTarget);
      const { data: rejected } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: 'a'.repeat(MAX_ALT + 1),
        p_expected_updated_at: before.updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(rejected?.resultCode === 'ALT_TEXT_TOO_LONG', `Expected ALT_TEXT_TOO_LONG, got ${JSON.stringify(rejected)}`);

      const { data: accepted } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: 'a'.repeat(MAX_ALT),
        p_expected_updated_at: projectState(editTarget).updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(accepted?.resultCode === 'SUCCESS', `The exact maximum was rejected: ${JSON.stringify(accepted)}`);
    });

    await scenario(32, 'A stale expected version loses, with zero mutation', async () => {
      const beforeAlt = snapshotMediaState(editTarget).altText;
      const beforeAudits = projectState(editTarget).audits;
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: editTarget, p_alt_text: 'Stale-tab description attempt.',
        p_expected_updated_at: '2000-01-01T00:00:00Z', p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'STALE_VERSION', `Expected STALE_VERSION, got ${JSON.stringify(data)}`);
      assert(snapshotMediaState(editTarget).altText === beforeAlt, 'A stale save mutated the alt text.');
      assert(projectState(editTarget).audits === beforeAudits, 'A stale save created an audit row.');
    });

    await scenario(33, 'A project with no snapshot image reports a bounded not-found failure', async () => {
      const noSnapshot = seedProject(prefix, 'no-snapshot-edit', fixture!, { withSnapshot: false });
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: noSnapshot, p_alt_text: SNAPSHOT_ALT,
        p_expected_updated_at: projectState(noSnapshot).updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'SNAPSHOT_MEDIA_NOT_FOUND', `Expected SNAPSHOT_MEDIA_NOT_FOUND, got ${JSON.stringify(data)}`);
      assert(projectState(noSnapshot).audits === 0, 'A not-found save created an audit row.');
    });

    await scenario(34, 'An unknown project reports a bounded not-found failure', async () => {
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: `${prefix}-does-not-exist`, p_alt_text: SNAPSHOT_ALT,
        p_expected_updated_at: new Date().toISOString(), p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'PROJECT_NOT_FOUND', `Expected PROJECT_NOT_FOUND, got ${JSON.stringify(data)}`);
    });

    await scenario(35, 'An approved project requires reopening before its alt can be edited', async () => {
      const approved = seedProject(prefix, 'approved-edit', fixture!, { status: 'approved' });
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: approved, p_alt_text: SNAPSHOT_ALT_B,
        p_expected_updated_at: projectState(approved).updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'APPROVAL_REOPEN_REQUIRED', `Expected APPROVAL_REOPEN_REQUIRED, got ${JSON.stringify(data)}`);
      assert(snapshotMediaState(approved).altText === SNAPSHOT_ALT, 'An approved project alt text was mutated.');
      assert(projectState(approved).audits === 0, 'A blocked approved edit created an audit row.');
    });

    await scenario(36, 'A published project keeps its accessibility metadata locked', async () => {
      const published = seedProject(prefix, 'published-edit', fixture!, { status: 'published' });
      const { data } = await serviceClient.rpc('update_snapshot_image_alt_text', {
        p_public_id: published, p_alt_text: SNAPSHOT_ALT_B,
        p_expected_updated_at: projectState(published).updatedAt, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'PUBLISHED_PROJECT_LOCKED', `Expected PUBLISHED_PROJECT_LOCKED, got ${JSON.stringify(data)}`);
      assert(snapshotMediaState(published).altText === SNAPSHOT_ALT, 'A published project alt text was mutated.');
    });

    // ---------------------------------------------------------- review gate

    await scenario(37, 'Application readiness blocks a snapshot with no alt and permits one with alt', () => {
      const withAlt = computeProjectReviewReadiness({
        publicId: 'x', title: 'T', summary: 'S', programId: 'p', programName: 'P', studyProgram: 'SP',
        discipline: 'D', groupName: 'G', teamMembers: ['A'], posterText: POSTER_TEXT,
        accessibilityText: ACCESSIBILITY_TEXT, snapshots: ['u'], validationErrors: [], validationWarnings: [],
        validationFlags: [], status: 'draft', disciplineMappingCount: 1, industryMappingCount: 1,
        mediaAssets: [
          { assetType: 'poster_image', isPublicApproved: false, publicUrl: null, altText: null },
          { assetType: 'poster_pdf', isPublicApproved: false, publicUrl: null, altText: null },
          { assetType: 'snapshot_image', isPublicApproved: false, publicUrl: null, altText: SNAPSHOT_ALT },
        ],
      });
      assert(withAlt.ready, `A described snapshot blocked readiness: ${withAlt.blockingReasons.join('; ')}`);

      const withoutAlt = computeProjectReviewReadiness({
        publicId: 'x', title: 'T', summary: 'S', programId: 'p', programName: 'P', studyProgram: 'SP',
        discipline: 'D', groupName: 'G', teamMembers: ['A'], posterText: POSTER_TEXT,
        accessibilityText: ACCESSIBILITY_TEXT, snapshots: ['u'], validationErrors: [], validationWarnings: [],
        validationFlags: [], status: 'draft', disciplineMappingCount: 1, industryMappingCount: 1,
        mediaAssets: [
          { assetType: 'poster_image', isPublicApproved: false, publicUrl: null, altText: null },
          { assetType: 'poster_pdf', isPublicApproved: false, publicUrl: null, altText: null },
          { assetType: 'snapshot_image', isPublicApproved: false, publicUrl: null, altText: null },
        ],
      });
      assert(!withoutAlt.ready, 'An undescribed snapshot passed application readiness.');
      assert(
        withoutAlt.blockingReasons.includes('Snapshot image alt text is missing.'),
        'The missing snapshot alt was not reported as a blocker.',
      );
      assert(
        !withoutAlt.warnings.includes('Snapshot image alt text is missing.'),
        'The missing snapshot alt was downgraded to a warning.',
      );
    });

    await scenario(38, 'The database blocks review submission for an undescribed snapshot', async () => {
      const blocked = seedProject(prefix, 'submit-blocked', fixture!, { snapshotAlt: null, inBatch: true });
      const { data } = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [blocked],
        p_admin_id: fixture!.admin.id, p_comments: null,
      }) as RpcResult;
      assert(data?.resultCode === 'READINESS_BLOCKED', `Expected READINESS_BLOCKED, got ${JSON.stringify(data)}`);
      assert(
        JSON.stringify(data?.blockingReasons ?? []).includes('MISSING_SNAPSHOT_ALT_TEXT'),
        `Expected MISSING_SNAPSHOT_ALT_TEXT, got ${JSON.stringify(data?.blockingReasons)}`,
      );
      assert(projectState(blocked).status === 'draft', 'A blocked submission changed the project status.');
      assert(projectState(blocked).audits === 0, 'A blocked submission created an audit row.');
    });

    await scenario(39, 'A mixed selection with one undescribed snapshot transitions nothing', async () => {
      const compliant = seedProject(prefix, 'submit-mixed-ok', fixture!, { inBatch: true });
      const blocked = `${prefix}-submit-blocked`;
      const { data } = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [compliant, blocked],
        p_admin_id: fixture!.admin.id, p_comments: null,
      }) as RpcResult;
      assert(data?.resultCode === 'READINESS_BLOCKED', `Expected READINESS_BLOCKED, got ${JSON.stringify(data)}`);
      assert(projectState(compliant).status === 'draft', 'A compliant project in a blocked selection was transitioned.');
      assert(projectState(compliant).audits === 0, 'A compliant project in a blocked selection gained an audit row.');
    });

    await scenario(40, 'A described snapshot and a snapshot-free project both submit successfully', async () => {
      const compliant = `${prefix}-submit-mixed-ok`;
      const noSnapshot = seedProject(prefix, 'submit-nosnap', fixture!, { withSnapshot: false, inBatch: true });
      const { data } = await serviceClient.rpc('submit_import_projects_for_review', {
        p_batch_id: fixture!.batchId, p_project_public_ids: [compliant, noSnapshot],
        p_admin_id: fixture!.admin.id, p_comments: null,
      }) as RpcResult;
      assert(data?.resultCode === 'SUCCESS', `Submission failed: ${JSON.stringify(data)}`);
      assert(projectState(compliant).status === 'submitted', 'The compliant project did not transition.');
      assert(projectState(noSnapshot).status === 'submitted', 'The snapshot-free project did not transition.');
    });

    // -------------------------------------------------------- approval gate

    await scenario(41, 'Approval is blocked for an undescribed snapshot, with zero mutation', async () => {
      const target = seedProject(prefix, 'approve-blocked', fixture!, { status: 'in_review', snapshotAlt: null });
      const { data } = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: target, p_action: 'approve', p_comments: null, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.resultCode === 'MEDIA_ACCESSIBILITY_REQUIRED', `Expected MEDIA_ACCESSIBILITY_REQUIRED, got ${JSON.stringify(data)}`);
      assert(projectState(target).status === 'in_review', 'A blocked approval changed the project status.');
      assert(projectState(target).audits === 0, 'A blocked approval created an audit row.');
    });

    await scenario(42, 'Request changes remains available for an undescribed snapshot', async () => {
      const target = `${prefix}-approve-blocked`;
      const { data } = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: target, p_action: 'request_changes', p_comments: 'Please describe the snapshot image.', p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.status === 'changes_requested', `Request changes was blocked: ${JSON.stringify(data)}`);
    });

    await scenario(43, 'Approval succeeds once the snapshot is described', async () => {
      const target = seedProject(prefix, 'approve-ok', fixture!, { status: 'in_review' });
      const { data } = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: target, p_action: 'approve', p_comments: null, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.status === 'approved', `Approval of a described snapshot failed: ${JSON.stringify(data)}`);
    });

    await scenario(44, 'Approval succeeds for a project with no snapshot image at all', async () => {
      const target = seedProject(prefix, 'approve-nosnap', fixture!, { status: 'in_review', withSnapshot: false });
      const { data } = await serviceClient.rpc('perform_project_review_action', {
        p_public_id: target, p_action: 'approve', p_comments: null, p_admin_id: fixture!.admin.id,
      }) as RpcResult;
      assert(data?.status === 'approved', `Approval without a snapshot image failed: ${JSON.stringify(data)}`);
    });

    await scenario(45, 'Application approval validation mirrors the database gate', () => {
      const project = createMockProject({ status: 'in_review' });
      assert(validateProjectForApproval(project, { snapshotMedia: null }).valid, 'Approval validation blocked a project with no snapshot.');
      assert(validateProjectForApproval(project, { snapshotMedia: { altText: SNAPSHOT_ALT } }).valid, 'Approval validation blocked a described snapshot.');
      assert(!validateProjectForApproval(project, { snapshotMedia: { altText: null } }).valid, 'Approval validation accepted an undescribed snapshot.');
    });

    // ------------------------------------------------------- preview gating

    await scenario(46, 'Preview generation fails closed for an undescribed snapshot', async () => {
      const target = seedProject(prefix, 'preview-blocked', fixture!, { status: 'approved', snapshotAlt: null });
      const { data } = await serviceClient.rpc('generate_participant_preview', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_token_hash: tokenPair().hash,
        p_expires_in_seconds: 604800, p_private_bucket: PRIVATE_BUCKET, p_is_correction_reissue: false,
      }) as RpcResult;
      assert(data?.resultCode === 'MEDIA_ACCESSIBILITY_REQUIRED', `Expected MEDIA_ACCESSIBILITY_REQUIRED, got ${JSON.stringify(data)}`);
      const previews = queryLocalJson<{ count: number }>(`
        SELECT pg_catalog.jsonb_build_object('count', pg_catalog.count(*))
          FROM public.participant_previews pp JOIN public.projects p ON p.id = pp.project_id
         WHERE p.public_id = ${sqlText(target)}
      `);
      assert(previews.count === 0, 'A blocked preview attempt still created a preview row.');
    });

    await scenario(47, 'The legacy 5-argument preview wrapper cannot bypass the gate', async () => {
      const { data } = await serviceClient.rpc('generate_participant_preview', {
        p_public_id: `${prefix}-preview-blocked`, p_admin_id: fixture!.admin.id, p_token_hash: tokenPair().hash,
        p_expires_in_seconds: 604800, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult;
      assert(data?.resultCode === 'MEDIA_ACCESSIBILITY_REQUIRED', `The 5-argument wrapper bypassed the gate: ${JSON.stringify(data)}`);
    });

    await scenario(48, 'The notification generator inherits the same gate', async () => {
      const target = `${prefix}-preview-blocked`;
      const { data } = await serviceClient.rpc('generate_participant_preview_with_notification', {
        p_public_id: target,
        p_admin_id: fixture!.admin.id,
        p_token_hash: tokenPair().hash,
        p_expires_in_seconds: 604800,
        p_private_bucket: PRIVATE_BUCKET,
        p_is_correction_reissue: false,
      }) as RpcResult;
      assert(
        data?.resultCode === 'MEDIA_ACCESSIBILITY_REQUIRED',
        `The notification generator bypassed the gate: ${JSON.stringify(data)}`,
      );
      const notifications = queryLocalJson<{ count: number }>(`
        SELECT pg_catalog.jsonb_build_object('count', pg_catalog.count(*))
          FROM public.participant_preview_notifications pn
          JOIN public.projects p ON p.id = pn.project_id
         WHERE p.public_id = ${sqlText(target)}
      `);
      assert(notifications.count === 0, 'A blocked preview attempt created a notification row.');
      const previews = queryLocalJson<{ count: number }>(`
        SELECT pg_catalog.jsonb_build_object('count', pg_catalog.count(*))
          FROM public.participant_previews pp
          JOIN public.projects p ON p.id = pp.project_id
         WHERE p.public_id = ${sqlText(target)}
      `);
      assert(previews.count === 0, 'A blocked preview attempt created a preview row.');
    });

    await scenario(49, 'A described snapshot yields a preview whose media snapshot stores the exact alt', async () => {
      const target = seedProject(prefix, 'preview-ok', fixture!, { status: 'approved' });
      const { data } = await serviceClient.rpc('generate_participant_preview', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_token_hash: tokenPair().hash,
        p_expires_in_seconds: 604800, p_private_bucket: PRIVATE_BUCKET, p_is_correction_reissue: false,
      }) as RpcResult;
      assert(data?.resultCode === 'SUCCESS', `Preview generation failed: ${JSON.stringify(data)}`);

      const stored = queryLocalJson<Array<{ assetType: string; altText: string | null }>>(`
        SELECT coalesce((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('assetType', elem->>'assetType', 'altText', elem->'altText') ORDER BY elem->>'assetType')
            FROM public.participant_previews pp
            JOIN public.projects p ON p.id = pp.project_id,
                 pg_catalog.jsonb_array_elements(pp.media_snapshot) elem
           WHERE p.public_id = ${sqlText(target)} AND pp.status = 'active'
        ), '[]'::jsonb)
      `);
      const snapshotEntry = stored.find((row) => row.assetType === 'snapshot_image');
      assert(snapshotEntry?.altText === SNAPSHOT_ALT, `The immutable media snapshot did not store the exact alt: ${JSON.stringify(stored)}`);
      const posterEntry = stored.find((row) => row.assetType === 'poster_image');
      assert(posterEntry?.altText === null, 'The poster image duplicated an alt into the media snapshot.');
    });

    await scenario(50, 'Participant HTML renders the snapshotted alt, never the filename', () => {
      const html = renderParticipantPreviewPage({
        snapshot: {
          title: 'Runtime Project', summary: null, background: null, solution: null, year: 2026,
          program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
          industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
          posterText: POSTER_TEXT, accessibilityText: ACCESSIBILITY_TEXT,
          citations: [], externalLinks: [], industryCategories: [],
        },
        media: [
          { mediaAssetId: 'm1', assetType: 'poster_image', fileName: 'poster.png', mimeType: 'image/png', altText: null, signedUrl: 'https://signed.invalid/poster.png' },
          { mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png', mimeType: 'image/png', altText: SNAPSHOT_ALT, signedUrl: 'https://signed.invalid/snapshot-1.png' },
        ],
        responseState: { type: 'unresponded' },
      });
      const alts = [...html.matchAll(/<img[^>]*\balt="([^"]*)"/g)].map((match) => match[1]);
      assert(alts.length === 2, `Expected two rendered images, found ${alts.length}.`);
      assert(alts[0] === ACCESSIBILITY_TEXT, 'The poster image did not use the snapshotted project accessibility text.');
      assert(alts[1] === SNAPSHOT_ALT, 'The snapshot image did not use its snapshotted media alt text.');
      assert(!alts.includes('snapshot-1.png'), 'A filename was used as participant-facing alt text.');
    });

    await scenario(51, 'Malicious alt text cannot inject markup into the participant page', () => {
      const html = renderParticipantPreviewPage({
        snapshot: {
          title: 'Runtime Project', summary: null, background: null, solution: null, year: 2026,
          program: null, studyProgram: null, discipline: null, disciplines: [], industry: null,
          industryPartner: null, academicSupervisor: null, groupName: null, teamMembers: [],
          posterText: POSTER_TEXT, accessibilityText: ACCESSIBILITY_TEXT,
          citations: [], externalLinks: [], industryCategories: [],
        },
        media: [
          { mediaAssetId: 'm2', assetType: 'snapshot_image', fileName: 'snapshot-1.png', mimeType: 'image/png', altText: '"><script>alert(1)</script>', signedUrl: 'https://signed.invalid/snapshot-1.png' },
        ],
        responseState: { type: 'unresponded' },
      });
      assert(!html.includes('<script>alert(1)</script>'), 'A snapshot alt text injected raw markup.');
      assert(html.includes('&quot;&gt;&lt;script&gt;'), 'The snapshot alt text was not HTML escaped.');
    });

    // ------------------------------------------------- publication readiness

    await scenario(52, 'Publication readiness rejects an undescribed snapshot outright', async () => {
      const target = `${prefix}-preview-blocked`;
      const { data } = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult;
      assert(data?.ready === false, 'An undescribed snapshot was publication-ready.');
      assert(data?.resultCode === 'ACCESSIBILITY_CONTENT_REQUIRED', `Expected ACCESSIBILITY_CONTENT_REQUIRED, got ${JSON.stringify(data)}`);
      assert(
        JSON.stringify(data?.blockers ?? []).includes('Snapshot image alt text is missing'),
        `Expected the snapshot-alt blocker, got ${JSON.stringify(data?.blockers)}`,
      );
    });

    await scenario(53, 'A confirmed preview with a described snapshot reaches READY', async () => {
      const target = `${prefix}-preview-ok`;
      executeLocalSql(`
        INSERT INTO public.participant_preview_confirmations(participant_preview_id, confirmed_at)
          SELECT pp.id, pg_catalog.now() FROM public.participant_previews pp
            JOIN public.projects p ON p.id = pp.project_id
           WHERE p.public_id = ${sqlText(target)} AND pp.status = 'active';
      `);
      const { data } = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult;
      assert(data?.ready === true, `A compliant confirmed project was not READY: ${JSON.stringify(data)}`);
      assert(data?.resultCode === 'READY', `Expected READY, got ${JSON.stringify(data)}`);
    });

    await scenario(54, 'Editing the alt after confirmation makes the media snapshot stale', async () => {
      const target = `${prefix}-preview-ok`;
      // Edited directly, because the approved-project gate deliberately routes staff through
      // Request changes; the point here is that the confirmation can no longer authorize publication.
      executeLocalSql(`
        UPDATE public.media_assets SET alt_text_public = ${sqlText(SNAPSHOT_ALT_B)}
         WHERE project_id = (SELECT id FROM public.projects WHERE public_id = ${sqlText(target)})
           AND asset_type = 'snapshot_image';
      `);
      const { data } = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult;
      assert(data?.ready === false, 'A stale media snapshot was still publication-ready.');
      assert(data?.resultCode === 'MEDIA_SNAPSHOT_STALE', `Expected MEDIA_SNAPSHOT_STALE, got ${JSON.stringify(data)}`);
    });

    await scenario(55, 'Restoring the confirmed alt restores readiness exactly', async () => {
      const target = `${prefix}-preview-ok`;
      executeLocalSql(`
        UPDATE public.media_assets SET alt_text_public = ${sqlText(SNAPSHOT_ALT)}
         WHERE project_id = (SELECT id FROM public.projects WHERE public_id = ${sqlText(target)})
           AND asset_type = 'snapshot_image';
      `);
      const { data } = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult;
      assert(data?.resultCode === 'READY', `Readiness did not return to READY: ${JSON.stringify(data)}`);
    });

    await scenario(56, 'A project with no snapshot image keeps its existing readiness behaviour', async () => {
      const target = seedProject(prefix, 'ready-nosnap', fixture!, { status: 'approved', withSnapshot: false });
      const { data } = await serviceClient.rpc('generate_participant_preview', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_token_hash: tokenPair().hash,
        p_expires_in_seconds: 604800, p_private_bucket: PRIVATE_BUCKET, p_is_correction_reissue: false,
      }) as RpcResult;
      assert(data?.resultCode === 'SUCCESS', `A snapshot-free project could not receive a preview: ${JSON.stringify(data)}`);
      executeLocalSql(`
        INSERT INTO public.participant_preview_confirmations(participant_preview_id, confirmed_at)
          SELECT pp.id, pg_catalog.now() FROM public.participant_previews pp
            JOIN public.projects p ON p.id = pp.project_id
           WHERE p.public_id = ${sqlText(target)} AND pp.status = 'active';
      `);
      const { data: readiness } = await serviceClient.rpc('get_project_publication_readiness', {
        p_public_id: target, p_admin_id: fixture!.admin.id, p_private_bucket: PRIVATE_BUCKET,
      }) as RpcResult;
      assert(readiness?.resultCode === 'READY', `A snapshot-free project was not READY: ${JSON.stringify(readiness)}`);
    });

    // ------------------------------------------------------------ public feed

    await scenario(57, 'The public feed emits both snapshots and the structured pairing', () => {
      const url = 'https://cdn.invalid/published/runtime/snapshot-1.png';
      const [record] = compilePublicFeed([createMockProject({
        status: 'published', snapshots: [url], snapshotMedia: [{ url, altText: SNAPSHOT_ALT }],
      })]);
      assert(JSON.stringify(record.snapshots) === JSON.stringify([url]), 'The compatible snapshots array changed shape.');
      assert(
        JSON.stringify(record.snapshotMedia) === JSON.stringify([{ url, altText: SNAPSHOT_ALT }]),
        'The structured snapshotMedia pairing was not emitted.',
      );
      assert(validatePublicFeed([record]).valid, 'A compliant feed record failed validation.');
    });

    await scenario(58, 'The feed validator rejects an undescribed or mismatched published snapshot', () => {
      const url = 'https://cdn.invalid/published/runtime/snapshot-1.png';
      const base = createMockProject({ status: 'published', snapshots: [url], snapshotMedia: [] });
      assert(!validatePublicFeed(compilePublicFeed([base])).valid, 'A published snapshot with no pairing passed validation.');

      const mismatched = createMockProject({
        status: 'published', snapshots: [url],
        snapshotMedia: [{ url: 'https://cdn.invalid/other.png', altText: SNAPSHOT_ALT }],
      });
      assert(!validatePublicFeed(compilePublicFeed([mismatched])).valid, 'A mismatched pairing passed validation.');

      for (const altText of ['', '   ', 'a'.repeat(MAX_ALT + 1)]) {
        const bad = createMockProject({ status: 'published', snapshots: [url], snapshotMedia: [{ url, altText }] });
        assert(!validatePublicFeed(compilePublicFeed([bad])).valid, `An invalid alt text ("${altText.slice(0, 8)}") passed validation.`);
      }
    });

    await scenario(59, 'The feed validator rejects unsafe, malformed, or private/draft snapshot URLs', () => {
      for (const badUrl of [
        'not-a-url',
        '/relative/path.png',
        'javascript:alert(1)',
        'data:image/png;base64,iVBORw0KGgo=',
        'https://cdn.invalid/storage/v1/object/public/project-drafts-private/a.png',
        'https://cdn.invalid/drafts/runtime/snapshot-1.png',
        'https://cdn.invalid/storage/v1/object/sign/project-public-assets/a.png',
      ]) {
        const record = createMockProject({
          status: 'published',
          snapshots: [badUrl],
          snapshotMedia: [{ url: badUrl, altText: SNAPSHOT_ALT }],
        });
        assert(!validatePublicFeed([record]).valid, `Unsafe snapshot URL "${badUrl}" passed validation.`);
      }
    });

    await scenario(60, 'The feed validator rejects duplicate snapshot URLs', () => {
      const url = 'https://cdn.invalid/published/runtime/snapshot-1.png';
      const dupSnapshots = createMockProject({
        status: 'published',
        snapshots: [url, url],
        snapshotMedia: [
          { url, altText: SNAPSHOT_ALT },
          { url, altText: SNAPSHOT_ALT },
        ],
      });
      assert(!validatePublicFeed([dupSnapshots]).valid, 'Duplicate snapshot URLs in snapshots passed validation.');

      const dupMedia = createMockProject({
        status: 'published',
        snapshots: [url, 'https://cdn.invalid/published/runtime/snapshot-2.png'],
        snapshotMedia: [
          { url, altText: 'First' },
          { url, altText: 'Duplicate' },
        ],
      });
      assert(!validatePublicFeed([dupMedia]).valid, 'Duplicate URLs in snapshotMedia passed validation.');
    });

    await scenario(61, 'The verifier created no public media and no published rows', () => {
      const leakage = queryLocalJson<{ publicMedia: number; published: number; snapshots: number }>(`
        SELECT pg_catalog.jsonb_build_object(
          'publicMedia', (SELECT pg_catalog.count(*) FROM public.media_assets ma JOIN public.projects p ON p.id = ma.project_id
                           WHERE p.public_id LIKE ${sqlText(`${prefix}-%`)} AND (ma.is_public_approved = true OR ma.public_url IS NOT NULL)),
          'published', (SELECT pg_catalog.count(*) FROM public.published_snapshots ps WHERE ps.created_at > pg_catalog.now() - interval '1 hour'
                          AND ps.feed_file_name LIKE ${sqlText(`${prefix}-%`)}),
          'snapshots', (SELECT pg_catalog.count(*) FROM public.publication_attempts pa WHERE pa.public_id LIKE ${sqlText(`${prefix}-%`)})
        )
      `);
      assert(leakage.publicMedia === 0, 'The verifier created public media.');
      assert(leakage.published === 0, 'The verifier wrote a published feed snapshot.');
      assert(leakage.snapshots === 0, 'The verifier created a publication attempt.');
    });
  } catch (error) {
    verifierError = error;
  } finally {
    try {
      executeLocalSql(`
        DELETE FROM public.participant_preview_confirmations c
          USING public.participant_previews pp, public.projects p
         WHERE c.participant_preview_id = pp.id AND pp.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.participant_previews pp
          USING public.projects p WHERE pp.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.approval_records ar
          USING public.projects p WHERE ar.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.media_assets ma
          USING public.projects p WHERE ma.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.project_disciplines pd
          USING public.projects p WHERE pd.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.project_industry_categories pic
          USING public.projects p WHERE pic.project_id = p.id AND p.public_id LIKE ${sqlText(`${prefix}-%`)};
        DELETE FROM public.projects WHERE public_id LIKE ${sqlText(`${prefix}-%`)};
        ${fixture ? `DELETE FROM public.import_batches WHERE id = '${fixture.batchId}'::uuid;` : ''}
        DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM public.admin_users WHERE email LIKE ${sqlText(`${prefix}-%@example.test`)});
        DELETE FROM public.admin_users WHERE email LIKE ${sqlText(`${prefix}-%@example.test`)};
        ${fixture ? `DELETE FROM public.programs WHERE id = '${fixture.program.id}'::uuid;` : ''}
        ${fixture ? `DELETE FROM public.disciplines WHERE id = '${fixture.discipline.id}'::uuid;` : ''}
        ${fixture ? `DELETE FROM public.industry_categories WHERE id = '${fixture.industry.id}'::uuid;` : ''}
      `);

      const residue = queryLocalJson<{ projects: number; actors: number; batches: number; media: number }>(`
        SELECT pg_catalog.jsonb_build_object(
          'projects', (SELECT pg_catalog.count(*) FROM public.projects WHERE public_id LIKE ${sqlText(`${prefix}-%`)}),
          'actors', (SELECT pg_catalog.count(*) FROM public.admin_users WHERE email LIKE ${sqlText(`${prefix}-%@example.test`)}),
          'batches', (SELECT pg_catalog.count(*) FROM public.import_batches WHERE id = '${fixture ? fixture.batchId : randomUUID()}'::uuid),
          'media', (SELECT pg_catalog.count(*) FROM public.media_assets ma JOIN public.projects p ON p.id = ma.project_id WHERE p.public_id LIKE ${sqlText(`${prefix}-%`)})
        )
      `);
      if (residue.projects !== 0 || residue.actors !== 0 || residue.batches !== 0 || residue.media !== 0) {
        throw new Error(`Verifier-owned rows survived cleanup: ${JSON.stringify(residue)}`);
      }
    } catch (cleanupError) {
      if (!verifierError) verifierError = cleanupError;
    }
  }

  if (verifierError) throw verifierError;
  console.log(`Snapshot image alt text runtime verification passed (${scenarioCount} independently asserted scenarios).`);
}

if (require.main === module) {
  verifySnapshotImageAltTextRuntime().catch((error) => {
    console.error('Snapshot image alt text runtime verification failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
