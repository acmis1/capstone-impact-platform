import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import {
  validateCredentialsStructure,
  verifySyntheticStaffAuthLogins,
} from '../local-development/localStaffAuthVerification';
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

const LOOKUP_TABLES = ['programs', 'disciplines', 'industry_categories'];

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

function normalizeRoles(rolesInput: unknown): string[] {
  if (!rolesInput) return [];
  if (Array.isArray(rolesInput)) {
    return rolesInput.map((r) => String(r).replace(/[{}]/g, '').toLowerCase().trim());
  }
  const str = String(rolesInput).replace(/[{}]/g, '').toLowerCase().trim();
  return str.split(',').map((s) => s.trim());
}

function normalizePolicyExpr(expr: unknown): string {
  if (expr == null) return '';
  let str = String(expr).toLowerCase().trim();
  while (str.startsWith('(') && str.endsWith(')')) {
    str = str.slice(1, -1).trim();
  }
  return str;
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
    teamMembers: Array.isArray(row.team_members) ? (row.team_members as string[]) : ['Participant One', 'Participant Two'],
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

const CHILD_PROCESS_TIMEOUT_MS = 120_000;
const NETWORK_REQUEST_TIMEOUT_MS = 15_000;

function runLocalDbQuery(sql: string, repoRoot: string): Array<Record<string, unknown>> {
  const workdir = path.resolve(repoRoot, 'infra');
  const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const cmd = `"${cliPath}" db query --local --workdir "${workdir}" -o json "${sql.replace(/"/g, '\\"')}"`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const raw = execSync(cmd, { encoding: 'utf8', cwd: repoRoot, stdio: 'pipe', timeout: CHILD_PROCESS_TIMEOUT_MS, killSignal: 'SIGTERM' });
      // Find where JSON payload actually starts ([ or {)
      const startIdx = raw.search(/\[|\{/);
      if (startIdx !== -1) {
        const jsonCandidate = raw.slice(startIdx).trim();
        const endChar = jsonCandidate.startsWith('[') ? ']' : '}';
        const endIdx = jsonCandidate.lastIndexOf(endChar);
        if (endIdx !== -1) {
          const cleanJson = jsonCandidate.slice(0, endIdx + 1);
          const parsed = JSON.parse(cleanJson) as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
          if (Array.isArray(parsed)) return parsed;
          if (parsed.rows && Array.isArray(parsed.rows)) return parsed.rows;
        }
      }
    } catch (err: unknown) {
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Local database schema query failed: ${detail}`);
}

export function createDeadlineFetch(timeoutMs = NETWORK_REQUEST_TIMEOUT_MS, fetchImpl: typeof fetch = fetch) {
  return (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return fetchImpl(input, { ...init, signal }).finally(() => clearTimeout(timer));
  };
}

export const deadlineFetch = createDeadlineFetch();

export async function verifyLocalSupabaseSetup(customCredsPath?: string): Promise<boolean> {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const defaultCredsPath = path.resolve(repoRoot, 'apps/admin-cms/.local-users.json');
  const credsPath = customCredsPath ? path.resolve(customCredsPath) : defaultCredsPath;

  // 1. Fetch CLI status
  const workdir = path.resolve(repoRoot, 'infra');
  const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
  const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;

  let rawEnv = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
    rawEnv = execSync(cmd, { encoding: 'utf8', cwd: repoRoot, stdio: 'pipe', timeout: CHILD_PROCESS_TIMEOUT_MS, killSignal: 'SIGTERM' });
      if (rawEnv.includes('API_URL')) break;
    } catch {
      // Retry
    }
  }

  if (!rawEnv) {
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
    global: { fetch: deadlineFetch },
  });

  const createAnonClient = () =>
    createClient(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: deadlineFetch },
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

    // 3d. Live Policy Semantics verification (Section 6)
    const policyRows = runLocalDbQuery(
      "SELECT tablename, policyname, roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'",
      repoRoot
    );

    // Verify lookup policies (select_*_authenticated)
    for (const lookupTable of LOOKUP_TABLES) {
      const polName = `select_${lookupTable}_authenticated`;
      const foundPol = policyRows.find((r) => String(r.policyname) === polName);
      if (!foundPol) {
        console.error(`❌ Policy verification failed: missing lookup policy [${polName}].`);
        return false;
      }
      if (String(foundPol.tablename) !== lookupTable) {
        console.error(`❌ Policy table mismatch for [${polName}].`);
        return false;
      }
      if (String(foundPol.cmd).toUpperCase() !== 'SELECT') {
        console.error(`❌ Policy command mismatch for [${polName}].`);
        return false;
      }
      const rolesArr = normalizeRoles(foundPol.roles);
      if (!rolesArr.includes('authenticated')) {
        console.error(`❌ Policy role mismatch for [${polName}].`);
        return false;
      }
      if (normalizePolicyExpr(foundPol.qual) !== 'true') {
        console.error(`❌ Policy qual expression mismatch for [${polName}].`);
        return false;
      }
    }

    // Verify all 13 admin_all_* policies
    for (const tableName of EXPECTED_TABLES) {
      const polName = `admin_all_${tableName}`;
      const foundPol = policyRows.find((r) => String(r.policyname) === polName);
      if (!foundPol) {
        console.error(`❌ Policy verification failed: missing restrictive policy [${polName}].`);
        return false;
      }
      if (String(foundPol.tablename) !== tableName) {
        console.error(`❌ Policy table mismatch for [${polName}].`);
        return false;
      }
      if (String(foundPol.cmd).toUpperCase() !== 'ALL') {
        console.error(`❌ Policy command mismatch for [${polName}].`);
        return false;
      }
      const rolesArr = normalizeRoles(foundPol.roles);
      if (!rolesArr.includes('authenticated')) {
        console.error(`❌ Policy role mismatch for [${polName}].`);
        return false;
      }
      if (normalizePolicyExpr(foundPol.qual) !== 'false' || normalizePolicyExpr(foundPol.with_check) !== 'false') {
        console.error(`❌ Policy expression mismatch for restrictive policy [${polName}].`);
        return false;
      }
    }
    console.log('✔ Live database policy semantics verified (lookup SELECT true & 13 restrictive admin_all FALSE).');

    // 3e. Exact Live Table-Grant Matrix verification (Section 4)
    const grantRows = runLocalDbQuery(
      "SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public'",
      repoRoot
    );

    // Set of "grantee|table_name|privilege_type"
    const grantSet = new Set(
      grantRows.map((r) => `${String(r.grantee).toLowerCase()}|${String(r.table_name).toLowerCase()}|${String(r.privilege_type).toUpperCase()}`)
    );

    const CRUD_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

    // Assert anon has ZERO privileges on all 13 tables
    for (const t of EXPECTED_TABLES) {
      for (const priv of CRUD_PRIVILEGES) {
        if (grantSet.has(`anon|${t}|${priv}`)) {
          console.error(`❌ Security grant violation: anon role has unexpected ${priv} grant on ${t}.`);
          return false;
        }
      }
    }

    // Assert authenticated has SELECT on lookup tables ONLY, no INSERT/UPDATE/DELETE, and ZERO privileges on remaining 10 tables
    for (const t of EXPECTED_TABLES) {
      const isLookup = LOOKUP_TABLES.includes(t);
      if (isLookup) {
        if (!grantSet.has(`authenticated|${t}|SELECT`)) {
          console.error(`❌ Missing required grant: authenticated role missing SELECT grant on lookup table ${t}.`);
          return false;
        }
        for (const priv of ['INSERT', 'UPDATE', 'DELETE']) {
          if (grantSet.has(`authenticated|${t}|${priv}`)) {
            console.error(`❌ Security grant violation: authenticated role has unexpected ${priv} grant on lookup table ${t}.`);
            return false;
          }
        }
      } else {
        for (const priv of CRUD_PRIVILEGES) {
          if (grantSet.has(`authenticated|${t}|${priv}`)) {
            console.error(`❌ Security grant violation: authenticated role has unexpected ${priv} grant on internal table ${t}.`);
            return false;
          }
        }
      }
    }

    // Assert service_role has SELECT, INSERT, UPDATE, DELETE on all 13 tables
    for (const t of EXPECTED_TABLES) {
      for (const priv of CRUD_PRIVILEGES) {
        if (!grantSet.has(`service_role|${t}|${priv}`)) {
          console.error(`❌ Missing required grant: service_role missing ${priv} grant on table ${t}.`);
          return false;
        }
      }
    }
    console.log('✔ Exact live table-grant matrix verified (anon 0, authenticated lookup SELECT only, service_role full CRUD across all 13 tables).');

    // 3f. Function Execution Grants verification (Section 5)
    const funcGrantRows = runLocalDbQuery(
      "SELECT grantee, routine_name FROM information_schema.routine_privileges WHERE routine_schema = 'public'",
      repoRoot
    );
    const funcGrantSet = new Set(
      funcGrantRows.map((r) => `${String(r.grantee).toUpperCase()}|${String(r.routine_name).toLowerCase()}`)
    );

    // bootstrap_initial_admin assertions: service_role HAS execute, PUBLIC/anon/authenticated DO NOT
    if (!funcGrantSet.has('SERVICE_ROLE|bootstrap_initial_admin')) {
      console.error('❌ Function grant verification failed: service_role missing EXECUTE on bootstrap_initial_admin.');
      return false;
    }
    for (const forbiddenGrantee of ['PUBLIC', 'ANON', 'AUTHENTICATED']) {
      if (funcGrantSet.has(`${forbiddenGrantee}|bootstrap_initial_admin`)) {
        console.error(`❌ Function grant security violation: ${forbiddenGrantee} has EXECUTE on bootstrap_initial_admin.`);
        return false;
      }
    }

    // update_updated_at_column assertions: PUBLIC, anon, authenticated, service_role ALL DO NOT HAVE EXECUTE
    for (const grantee of ['PUBLIC', 'ANON', 'AUTHENTICATED', 'SERVICE_ROLE']) {
      if (funcGrantSet.has(`${grantee}|update_updated_at_column`)) {
        console.error(`❌ Function grant security violation: ${grantee} has EXECUTE on update_updated_at_column.`);
        return false;
      }
    }
    console.log('✔ Function execution grants verified (bootstrap_initial_admin restricted to service_role; update_updated_at_column unexposed).');

    // 3g. Bootstrap function definition verification
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

    // 3h. Transactional Review Action RPC function & execution grants verification
    const reviewRpcRows = runLocalDbQuery(
      "SELECT p.prosecdef, pg_get_functiondef(p.oid) AS funcdef FROM pg_proc p WHERE p.proname = 'perform_project_review_action' AND p.pronamespace = 'public'::regnamespace",
      repoRoot
    );
    if (!reviewRpcRows || reviewRpcRows.length === 0 || !reviewRpcRows[0].funcdef) {
      console.error('❌ Function verification failed: perform_project_review_action missing.');
      return false;
    }
    const rpcDefStr = String(reviewRpcRows[0].funcdef);
    if (!rpcDefStr.includes('SECURITY DEFINER')) {
      console.error('❌ Function verification failed: perform_project_review_action missing SECURITY DEFINER.');
      return false;
    }
    if (!rpcDefStr.toLowerCase().includes('search_path')) {
      console.error('❌ Function verification failed: perform_project_review_action search_path is not set.');
      return false;
    }

    if (!funcGrantSet.has('SERVICE_ROLE|perform_project_review_action')) {
      console.error('❌ Function grant verification failed: service_role missing EXECUTE on perform_project_review_action.');
      return false;
    }
    for (const forbiddenGrantee of ['PUBLIC', 'ANON', 'AUTHENTICATED']) {
      if (funcGrantSet.has(`${forbiddenGrantee}|perform_project_review_action`)) {
        console.error(`❌ Function grant security violation: ${forbiddenGrantee} has EXECUTE on perform_project_review_action.`);
        return false;
      }
    }
    console.log('✔ Live perform_project_review_action RPC function definition & service_role-only execution grants verified.');
    // 3i. Transactional project metadata RPC function & execution grants verification
    const metadataRpcRows = runLocalDbQuery(
      "SELECT p.prosecdef, pg_get_functiondef(p.oid) AS funcdef FROM pg_proc p WHERE p.proname = 'update_project_metadata' AND p.pronamespace = 'public'::regnamespace",
      repoRoot
    );
    if (!metadataRpcRows || metadataRpcRows.length !== 1 || !metadataRpcRows[0].funcdef) {
      console.error('Function verification failed: update_project_metadata missing or ambiguous.');
      return false;
    }
    const metadataRpcDef = String(metadataRpcRows[0].funcdef);
    if (!metadataRpcRows[0].prosecdef || !metadataRpcDef.includes('FOR UPDATE') || !metadataRpcDef.toLowerCase().includes('search_path')) {
      console.error('Function verification failed: update_project_metadata security or locking contract missing.');
      return false;
    }
    if (!funcGrantSet.has('SERVICE_ROLE|update_project_metadata')) {
      console.error('Function grant verification failed: service_role missing EXECUTE on update_project_metadata.');
      return false;
    }
    for (const forbiddenGrantee of ['PUBLIC', 'ANON', 'AUTHENTICATED']) {
      if (funcGrantSet.has(`${forbiddenGrantee}|update_project_metadata`)) {
        console.error(`Function grant security violation: ${forbiddenGrantee} has EXECUTE on update_project_metadata.`);
        return false;
      }
    }
    console.log('Live update_project_metadata RPC definition, row lock, and service_role-only execution grants verified.');
  } catch (err: unknown) {
    console.error('❌ Live database schema verification failed:', err instanceof Error ? err.message : String(err));
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

  // Assert compiled feed contains EXACT published public IDs only (approved is no longer public feed eligible)
  const feedPublicIds = feedItems.map((item) => item.publicId).sort();
  const expectedPublicIds = ['2026-traffic-engine'].sort();
  if (feedPublicIds.length !== expectedPublicIds.length || !feedPublicIds.every((v, i) => v === expectedPublicIds[i])) {
    console.error('❌ Public feed public IDs mismatch.');
    return false;
  }

  // Assert draft, in_review, and approved public IDs are strictly absent
  const forbiddenPublicIds = new Set(['2026-agri-iot', '2026-vr-rehab', '2026-medical-drone']);
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

  // 6. Real Password Sign-in & Synthetic staff user credentials verification (Section 2)
  if (!fs.existsSync(credsPath)) {
    console.error('❌ Local credentials file missing.');
    return false;
  }

  let userCreds: Record<string, string>;
  try {
    const fileContent = fs.readFileSync(credsPath, 'utf8');
    const parsed = JSON.parse(fileContent) as unknown;
    userCreds = validateCredentialsStructure(parsed);
  } catch {
    console.error('❌ Local credentials file validation failed.');
    return false;
  }

  const loginSuccess = await verifySyntheticStaffAuthLogins(userCreds, createAnonClient, adminClient);
  if (!loginSuccess) {
    return false;
  }

  console.log('✔ Synthetic staff accounts verified via real password sign-in (Admin, Reviewer, Editor logins, profile linkages & roles exact).');
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
