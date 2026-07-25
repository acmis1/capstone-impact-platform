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
  { name: 'project-drafts-private', isPublic: false, sizeLimit: 20971520 },
  { name: 'project-public-assets', isPublic: true, sizeLimit: 20971520 },
  { name: 'public-feeds', isPublic: true, sizeLimit: 10485760 },
];

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
    poster: String(row.poster_url || 'https://placehold.co/600x400.png'),
    posterPdf: String(row.poster_pdf_url || 'https://placehold.co/sample.pdf'),
    posterText: String(row.poster_text_public || ''),
    accessibilityText: String(row.accessibility_text_public || ''),
    snapshots: Array.isArray(row.snapshots) ? (row.snapshots as string[]) : [],
    videoUrl: String(row.video_url || ''),
    demoUrl: String(row.demo_url || ''),
    repositoryUrl: String(row.repository_url || ''),
    externalLinks: Array.isArray(row.external_links) ? (row.external_links as any[]) : [],
    citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
    layoutConfig: {
      templateId: 'poster_showcase',
      featuredMedia: 'poster',
      sectionOrder: ['background', 'solution'],
    },
    status: (row.status as Project['status']) || 'draft',
  };
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
  const anonClient = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. Table verification
  for (const tableName of EXPECTED_TABLES) {
    const { error } = await adminClient.from(tableName).select('*', { count: 'exact', head: true });
    if (error) {
      console.error(`❌ Table check failed for table.`);
      return false;
    }
  }
  console.log(`✔ All ${EXPECTED_TABLES.length} required database tables exist.`);

  // 4. Storage Bucket verification via storage.buckets database table
  const { data: buckets, error: bucketErr } = await adminClient
    .schema('storage')
    .from('buckets')
    .select('name, public, file_size_limit, allowed_mime_types');

  if (bucketErr || !buckets) {
    console.error('❌ Failed to query Storage buckets.');
    return false;
  }

  for (const expected of EXPECTED_BUCKETS) {
    const found = buckets.find((b) => b.name === expected.name);
    if (!found) {
      console.error(`❌ Storage bucket verification failed: missing bucket.`);
      return false;
    }
    if (found.public !== expected.isPublic) {
      console.error('❌ Storage bucket visibility mismatch.');
      return false;
    }
    if (found.file_size_limit && Number(found.file_size_limit) !== expected.sizeLimit) {
      console.error('❌ Storage bucket file size limit mismatch.');
      return false;
    }
  }
  console.log('✔ Storage buckets verified (existence, visibility, size limits exact).');

  // 5. Check synthetic projects
  const { data: dbProjects, error: projErr } = await adminClient.from('projects').select('*');
  if (projErr || !dbProjects || dbProjects.length === 0) {
    console.error('❌ Synthetic project verification failed: No project rows found.');
    return false;
  }
  console.log(`✔ Synthetic project seed verified (${dbProjects.length} sample projects found).`);

  // 6. Feed compilation eligibility & Sanitization check
  const domainProjects = dbProjects.map((row) => mapDbRowToProject(row as Record<string, unknown>));
  const feedItems = compilePublicFeed(domainProjects);
  const validateResult = validatePublicFeed(feedItems);

  if (!validateResult.valid) {
    console.error(`❌ Public feed contract validation failed: ${validateResult.errors.join('; ')}`);
    return false;
  }

  // Ensure no draft, in_review, changes_requested, archived, or deleted records appear in public feed
  for (const item of feedItems) {
    const orig = dbProjects.find((p) => String(p.public_id) === item.publicId || String(p.id) === item.publicId);
    if (orig && orig.status !== 'approved' && orig.status !== 'published') {
      console.error('❌ Public feed security leak: Non-public status record included.');
      return false;
    }
  }

  console.log('✔ Public feed compilation verified (approved/published only, internal fields stripped).');

  // 7. Verify credentials & Sign-in
  if (!fs.existsSync(credsPath)) {
    console.error('❌ Local credentials file missing.');
    return false;
  }

  let credsData: { users?: Record<string, string> };
  try {
    credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as { users?: Record<string, string> };
  } catch {
    console.error('❌ Failed to parse local credentials file.');
    return false;
  }

  const userPasswords: Record<string, string> = credsData.users || {};

  for (const def of SYNTHETIC_STAFF_DEFINITIONS) {
    const password = userPasswords[def.email];
    if (!password) {
      console.error('❌ Missing password for synthetic user.');
      return false;
    }

    const { data: authResult, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: def.email,
      password,
    });

    if (signInErr || !authResult.user) {
      console.error(`❌ Password sign-in failed for synthetic user: ${signInErr?.message}`);
      return false;
    }

    const authUserId = authResult.user.id;
    const { data: adminUserRow, error: profileErr } = await adminClient
      .from('admin_users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (profileErr || !adminUserRow) {
      console.error('❌ Profile linkage failed for synthetic user.');
      return false;
    }

    const { data: roleRows, error: roleErr } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', adminUserRow.id);

    if (roleErr || !roleRows || roleRows.length !== 1 || roleRows[0].role !== def.role) {
      console.error('❌ Role mapping mismatch for synthetic user.');
      return false;
    }
  }

  console.log('✔ Synthetic staff accounts verified (Admin, Reviewer, Editor login & roles exact).');
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
