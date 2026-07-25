import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { SYNTHETIC_STAFF_DEFINITIONS } from '../local-development/localStaffUsers';
import { compilePublicFeed } from '../feed/compilePublicFeed';
import { validatePublicFeed } from '../feed/validatePublicFeed';
import { execSync } from 'node:child_process';
import type { Project } from '../domain/project';

const EXPECTED_TABLES = [
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
];

const EXPECTED_BUCKETS = [
  {
    name: 'project-drafts-private',
    isPublic: false,
    sizeLimit: 20971520,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  },
  {
    name: 'project-public-assets',
    isPublic: true,
    sizeLimit: 20971520,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
  },
  {
    name: 'public-feeds',
    isPublic: true,
    sizeLimit: 10485760,
    allowedMimeTypes: ['application/json'],
  },
];

function normalizeMimeTypes(mimeTypes?: string[] | null): string[] {
  if (!mimeTypes || !Array.isArray(mimeTypes)) return [];
  return [...mimeTypes].map((m) => String(m).toLowerCase().trim()).sort();
}

function areMimeTypesEqual(a?: string[] | null, b?: string[] | null): boolean {
  const normA = normalizeMimeTypes(a);
  const normB = normalizeMimeTypes(b);
  if (normA.length !== normB.length) return false;
  return normA.every((val, index) => val === normB[index]);
}

function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function mapDbRowToProject(row: Record<string, unknown>): Project {
  const publicId = String(row.public_id || row.id || '');
  const numericId = hashStringToNumber(publicId || '1');

  const rawLayout = (row.layout_config as Record<string, unknown>) || {};
  const templateId = (rawLayout.templateId as Project['layoutConfig']['templateId']) || 'poster_showcase';
  const featuredMedia = (rawLayout.featuredMedia as Project['layoutConfig']['featuredMedia']) || 'poster';
  const sectionOrder = Array.isArray(rawLayout.sectionOrder)
    ? (rawLayout.sectionOrder as string[])
    : ['background', 'solution'];

  return {
    id: numericId,
    publicId,
    title: String(row.title || 'Sample Title'),
    summary: String(row.summary || 'Sample Summary'),
    background: String(row.background || 'Sample Background'),
    solution: String(row.solution || 'Sample Solution'),
    year: row.year ? String(row.year) : '2026',
    program: String(row.program_name || 'School of Computing'),
    studyProgram: String(row.study_program || 'Computer Science'),
    discipline: String(row.discipline || 'Software Engineering'),
    disciplines: Array.isArray(row.disciplines)
      ? (row.disciplines as string[])
      : [String(row.discipline || 'Software Engineering')],
    industry: String(row.industry || 'Technology'),
    industryPartner: String(row.industry_partner || ''),
    academicSupervisor: String(row.academic_supervisor || ''),
    groupName: String(row.group_name || 'Capstone Team 1'),
    teamMembers: Array.isArray(row.team_members) ? (row.team_members as string[]) : ['Student One', 'Student Two'],
    poster: String(row.poster_url || ''),
    posterPdf: String(row.poster_pdf_url || ''),
    posterText: String(row.poster_text_public || ''),
    accessibilityText: String(row.accessibility_text_public || ''),
    snapshots: Array.isArray(row.snapshots) ? (row.snapshots as string[]) : [],
    videoUrl: String(row.video_url || ''),
    demoUrl: String(row.demo_url || ''),
    repositoryUrl: String(row.repository_url || ''),
    externalLinks: Array.isArray(row.external_links)
      ? (row.external_links as Array<{ label: string; url: string }>)
      : [],
    citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
    layoutConfig: {
      templateId,
      featuredMedia,
      sectionOrder,
    },
    status: (row.status as Project['status']) || 'draft',
  };
}

function runLocalDbQuery(sql: string, repoRoot: string): Array<Record<string, unknown>> {
  const workdir = path.resolve(repoRoot, 'infra');
  const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const cmd = `"${cliPath}" db query --local --workdir "${workdir}" -o json "${sql.replace(/"/g, '\\"')}"`;
  try {
    const raw = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error('Local DB query JSON parsing failed.');
    }
    const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as { rows?: Array<Record<string, unknown>> };
    return parsed.rows || [];
  } catch {
    throw new Error('Local database schema query failed.');
  }
}

export async function verifyLocalSupabaseSetup(customCredsPath?: string): Promise<boolean> {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const defaultCredsPath = path.resolve(repoRoot, 'apps/admin-cms/.local-users.json');
  const credsPath = customCredsPath ? path.resolve(customCredsPath) : defaultCredsPath;

  // 1. Fetch CLI status
  const workdir = path.resolve(repoRoot, 'infra');
  const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;

  let rawEnv = '';
  try {
    rawEnv = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
  } catch {
    console.error('❌ Failed to query local Supabase CLI status.');
    return false;
  }

  const parsedEnv = parseSupabaseCliEnv(rawEnv);
  const apiUrl = parsedEnv.API_URL || 'http://127.0.0.1:54321';
  const anonKey = parsedEnv.ANON_KEY || '';
  const serviceKey = parsedEnv.SERVICE_ROLE_KEY || '';

  // 2. Loopback URL check
  if (!isLoopbackUrl(apiUrl)) {
    console.error('❌ Non-loopback Supabase endpoint rejected.');
    return false;
  }

  if (!serviceKey || !anonKey) {
    console.error('❌ Service role key or Anon key missing from status.');
    return false;
  }

  console.log('✔ Loopback Supabase endpoint verified.');

  const adminClient = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. Live local schema verification via local CLI db query
  try {
    // 3a. Tables verification
    const tableRows = runLocalDbQuery(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      repoRoot
    );
    const existingTableNames = new Set(tableRows.map((r) => String(r.table_name)));
    for (const tableName of EXPECTED_TABLES) {
      if (!existingTableNames.has(tableName)) {
        console.error(`❌ Table verification failed: missing table [${tableName}].`);
        return false;
      }
    }
    console.log(`✔ Live database tables verified (all ${EXPECTED_TABLES.length} tables present).`);

    // 3b. RLS verification
    const rlsRows = runLocalDbQuery(
      "SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'",
      repoRoot
    );
    const rlsMap = new Map(rlsRows.map((r) => [String(r.table_name), Boolean(r.rls_enabled)]));
    for (const tableName of EXPECTED_TABLES) {
      if (rlsMap.get(tableName) !== true) {
        console.error(`❌ RLS verification failed: RLS disabled on table [${tableName}].`);
        return false;
      }
    }
    console.log('✔ Live database RLS verified (RLS enabled on all 13 tables).');

    // 3c. Triggers & Indexes verification
    const triggerRows = runLocalDbQuery(
      "SELECT trigger_name FROM information_schema.triggers WHERE event_object_schema = 'public' AND event_object_table = 'projects'",
      repoRoot
    );
    if (!triggerRows.some((r) => String(r.trigger_name) === 'update_projects_updated_at')) {
      console.error('❌ Trigger verification failed: missing update_projects_updated_at trigger.');
      return false;
    }

    const indexRows = runLocalDbQuery(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
      repoRoot
    );
    const existingIndexNames = new Set(indexRows.map((r) => String(r.indexname)));
    const expectedIndexes = [
      'idx_projects_status',
      'idx_projects_year',
      'idx_projects_public_id',
      'idx_media_assets_project_id',
      'idx_validation_flags_project_id',
      'idx_approval_records_project_id',
    ];
    for (const idxName of expectedIndexes) {
      if (!existingIndexNames.has(idxName)) {
        console.error(`❌ Index verification failed: missing index [${idxName}].`);
        return false;
      }
    }
    console.log('✔ Live database indexes & triggers verified.');

    // 3d. Policies verification
    const policyRows = runLocalDbQuery(
      "SELECT policyname FROM pg_policies WHERE schemaname = 'public'",
      repoRoot
    );
    const existingPolicies = new Set(policyRows.map((r) => String(r.policyname)));
    const requiredPolicies = [
      'select_programs_authenticated',
      'select_disciplines_authenticated',
      'select_industry_categories_authenticated',
      'admin_all_projects',
      'admin_all_admin_users',
      'admin_all_user_roles',
    ];
    for (const pol of requiredPolicies) {
      if (!existingPolicies.has(pol)) {
        console.error(`❌ Policy verification failed: missing policy [${pol}].`);
        return false;
      }
    }
    console.log('✔ Live database RLS policies verified.');

    // 3e. Grants & Function execution restrictions verification
    const grantRows = runLocalDbQuery(
      "SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public'",
      repoRoot
    );
    const anonGrants = grantRows.filter((r) => String(r.grantee) === 'anon');
    const forbiddenAnonTables = new Set(['admin_users', 'user_roles', 'projects', 'import_batches', 'media_assets']);
    for (const g of anonGrants) {
      if (forbiddenAnonTables.has(String(g.table_name))) {
        console.error(`❌ Security grant violation: anon role has ${g.privilege_type} access to ${g.table_name}.`);
        return false;
      }
    }

    const funcGrantRows = runLocalDbQuery(
      "SELECT grantee, routine_name FROM information_schema.routine_privileges WHERE routine_schema = 'public' AND routine_name = 'bootstrap_initial_admin'",
      repoRoot
    );
    const forbiddenFuncGrantees = new Set(['PUBLIC', 'anon', 'authenticated']);
    for (const fg of funcGrantRows) {
      if (forbiddenFuncGrantees.has(String(fg.grantee))) {
        console.error(`❌ Function execution grant violation: ${fg.grantee} has access to bootstrap_initial_admin.`);
        return false;
      }
    }
    console.log('✔ Live database table grants & function execution restrictions verified.');

    // 3f. Bootstrap function definition verification
    const funcDefRows = runLocalDbQuery(
      "SELECT pg_get_functiondef(oid) AS funcdef FROM pg_proc WHERE proname = 'bootstrap_initial_admin' AND pronamespace = 'public'::regnamespace",
      repoRoot
    );
    if (!funcDefRows || funcDefRows.length === 0 || !funcDefRows[0].funcdef) {
      console.error('❌ Function verification failed: bootstrap_initial_admin missing.');
      return false;
    }
    const funcDefStr = String(funcDefRows[0].funcdef);
    if (!funcDefStr.includes('btrim') || funcDefStr.includes('pg_catalog.trim(')) {
      console.error('❌ Function definition runtime error: bootstrap_initial_admin uses incorrect trim implementation.');
      return false;
    }
    console.log('✔ Live bootstrap_initial_admin function definition verified (btrim preserved).');
  } catch {
    console.error('❌ Live database schema verification failed.');
    return false;
  }

  // 4. Storage Bucket & Fixture object verification via database catalog and storage API
  const bucketRows = runLocalDbQuery(
    "SELECT name, public, file_size_limit, allowed_mime_types FROM storage.buckets",
    repoRoot
  );

  for (const expected of EXPECTED_BUCKETS) {
    const found = bucketRows.find((b) => String(b.name) === expected.name);
    if (!found) {
      console.error(`❌ Storage bucket verification failed: missing bucket [${expected.name}].`);
      return false;
    }
    if (Boolean(found.public) !== expected.isPublic) {
      console.error(`❌ Storage bucket visibility mismatch for [${expected.name}].`);
      return false;
    }
    if (found.file_size_limit == null || Number(found.file_size_limit) !== expected.sizeLimit) {
      console.error(`❌ Storage bucket file size limit mismatch for [${expected.name}].`);
      return false;
    }
    const dbMimes = Array.isArray(found.allowed_mime_types) ? (found.allowed_mime_types as string[]) : [];
    if (!areMimeTypesEqual(dbMimes, expected.allowedMimeTypes)) {
      console.error(`❌ Storage bucket allowed MIME types mismatch for [${expected.name}].`);
      return false;
    }
  }

  // Verify local fixture objects exist in storage
  const { data: publicFixtureList, error: pubListErr } = await adminClient.storage
    .from('project-public-assets')
    .list('2026/traffic-engine', { search: 'poster.png' });

  if (pubListErr || !publicFixtureList || !publicFixtureList.some((f) => f.name === 'poster.png')) {
    console.error('❌ Storage fixture verification failed: missing public poster fixture object.');
    return false;
  }

  const { data: privateFixtureList, error: privListErr } = await adminClient.storage
    .from('project-drafts-private')
    .list('2026/hydrogrid', { search: 'poster.png' });

  if (privListErr || !privateFixtureList || !privateFixtureList.some((f) => f.name === 'poster.png')) {
    console.error('❌ Storage fixture verification failed: missing private draft fixture object.');
    return false;
  }

  console.log('✔ Storage buckets & required local fixture objects verified (exact visibility, limits, MIME, objects).');

  // 5. Synthetic project seed & Feed verification
  const { data: dbProjects, error: projErr } = await adminClient.from('projects').select('*');
  if (projErr || !dbProjects || dbProjects.length === 0) {
    console.error('❌ Synthetic project verification failed: No project rows found.');
    return false;
  }

  // Verify representative statuses present in local seed (published, approved, draft, in_review)
  const seedStatuses = new Set(dbProjects.map((p) => String(p.status)));
  const requiredStatuses = ['published', 'approved', 'draft', 'in_review'];
  for (const st of requiredStatuses) {
    if (!seedStatuses.has(st)) {
      console.error(`❌ Synthetic project seed missing representative status [${st}].`);
      return false;
    }
  }

  const domainProjects = dbProjects.map((row) => mapDbRowToProject(row as Record<string, unknown>));
  const feedItems = compilePublicFeed(domainProjects);
  const validateResult = validatePublicFeed(feedItems);

  if (!validateResult.valid) {
    console.error(`❌ Public feed contract validation failed: ${validateResult.errors.join('; ')}`);
    return false;
  }

  // Assert compiled feed contains EXACT approved and published public IDs only
  const feedPublicIds = feedItems.map((item) => item.publicId).sort();
  const expectedPublicIds = ['2026-medical-drone', '2026-traffic-engine'].sort();
  if (feedPublicIds.length !== expectedPublicIds.length || !feedPublicIds.every((v, i) => v === expectedPublicIds[i])) {
    console.error('❌ Public feed public IDs mismatch.');
    return false;
  }

  // Assert draft and in_review public IDs are strictly absent
  const forbiddenPublicIds = new Set(['2026-agri-iot', '2026-vr-rehab']);
  for (const item of feedItems) {
    if (forbiddenPublicIds.has(item.publicId)) {
      console.error(`❌ Security violation: Non-public project [${item.publicId}] included in public feed.`);
      return false;
    }
  }

  // Assert serialized feed records do NOT contain sensitive or internal fields
  const forbiddenKeys = [
    'internal_staff_notes',
    'private_review_comments',
    'source_folder',
    'import_batch_id',
    'validation_flags',
    'validationFlags',
    'archive_metadata',
    'archiveMetadata',
  ];

  for (const item of feedItems) {
    const jsonStr = JSON.stringify(item);
    for (const key of forbiddenKeys) {
      if (jsonStr.includes(`"${key}"`)) {
        console.error(`❌ Security leakage: Serialized public feed contains internal field [${key}].`);
        return false;
      }
    }
  }

  console.log('✔ Public feed compilation verified (exact public IDs, internal/sensitive fields excluded).');

  // 6. Verify credentials file & Synthetic staff user identities and role mappings
  if (!fs.existsSync(credsPath)) {
    console.error('❌ Local credentials file missing.');
    return false;
  }

  const { data: authUsersData, error: listAuthErr } = await adminClient.auth.admin.listUsers();
  if (listAuthErr || !authUsersData || !authUsersData.users) {
    console.error('❌ Failed to query Auth users for synthetic staff verification.');
    return false;
  }

  const authUserMap = new Map(authUsersData.users.map((u) => [u.email?.toLowerCase(), u]));

  for (const def of SYNTHETIC_STAFF_DEFINITIONS) {
    const authUser = authUserMap.get(def.email.toLowerCase());
    if (!authUser) {
      console.error(`❌ Missing Auth user identity for synthetic staff [${def.label}].`);
      return false;
    }

    const { data: adminUserRow, error: profileErr } = await adminClient
      .from('admin_users')
      .select('id')
      .eq('auth_user_id', authUser.id)
      .single();

    if (profileErr || !adminUserRow) {
      console.error(`❌ Profile linkage failed for synthetic staff [${def.label}].`);
      return false;
    }

    const { data: roleRows, error: roleErr } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', adminUserRow.id);

    if (roleErr || !roleRows || roleRows.length !== 1 || roleRows[0].role !== def.role) {
      console.error(`❌ Role mapping mismatch for synthetic staff [${def.label}].`);
      return false;
    }
  }

  console.log('✔ Synthetic staff accounts verified (Admin, Reviewer, Editor identities & roles exact).');
  console.log('✔ Local Supabase verification complete and verified on local environment.');
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  let credentialsPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--credentials-output' && i + 1 < args.length) {
      credentialsPath = args[i + 1];
      i++;
    }
  }

  try {
    const success = await verifyLocalSupabaseSetup(credentialsPath);
    if (!success) {
      process.exit(1);
    }
  } catch {
    console.error('❌ Local verification script encountered an error.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
