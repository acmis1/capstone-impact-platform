import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { SYNTHETIC_STAFF_DEFINITIONS } from '../local-development/localStaffUsers';
import { execSync } from 'node:child_process';

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
  { name: 'project-drafts-private', isPublic: false },
  { name: 'project-public-assets', isPublic: true },
  { name: 'public-feeds', isPublic: true },
];

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Failed to query local Supabase status: ${msg}`);
    return false;
  }

  const parsedEnv = parseSupabaseCliEnv(rawEnv);
  const apiUrl = parsedEnv.API_URL || 'http://127.0.0.1:54321';
  const anonKey = parsedEnv.ANON_KEY || '';
  const serviceKey = parsedEnv.SERVICE_ROLE_KEY || '';

  // 2. Loopback URL check
  if (!isLoopbackUrl(apiUrl)) {
    console.error(`❌ Non-loopback URL rejected: [${apiUrl}]`);
    return false;
  }

  if (!serviceKey || !anonKey) {
    console.error('❌ Service role key or Anon key missing from status.');
    return false;
  }

  console.log('✔ Loopback Supabase URL verified.');

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
      console.error(`❌ Table check failed for [${tableName}]: ${error.message}`);
      return false;
    }
  }
  console.log(`✔ All ${EXPECTED_TABLES.length} required database tables exist.`);

  // 4. Storage Bucket verification via storage.buckets database table
  const { data: buckets, error: bucketErr } = await adminClient
    .schema('storage')
    .from('buckets')
    .select('name, public');

  if (bucketErr || !buckets) {
    console.error(`❌ Failed to query Storage buckets: ${bucketErr?.message}`);
    return false;
  }

  for (const expected of EXPECTED_BUCKETS) {
    const found = buckets.find((b) => b.name === expected.name);
    if (!found) {
      console.error(`❌ Required storage bucket missing: [${expected.name}]`);
      return false;
    }
    if (found.public !== expected.isPublic) {
      console.error(
        `❌ Storage bucket [${expected.name}] visibility mismatch: expected public=${expected.isPublic}, found public=${found.public}`
      );
      return false;
    }
  }
  console.log('✔ Required storage buckets exist with correct public/private visibility.');

  // 5. Check synthetic projects
  const { data: projects, error: projErr } = await adminClient.from('projects').select('id, public_id, status');
  if (projErr || !projects || projects.length === 0) {
    console.error(`❌ Synthetic project verification failed: ${projErr?.message || 'No projects found'}`);
    return false;
  }
  console.log(`✔ Synthetic project seed verified (${projects.length} sample projects found).`);

  // 6. Verify credentials & Sign-in
  if (!fs.existsSync(credsPath)) {
    console.error(`❌ Local credentials file missing at [${credsPath}]. Run npm run supabase:users:local first.`);
    return false;
  }

  const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  const userPasswords: Record<string, string> = credsData.users || {};

  for (const def of SYNTHETIC_STAFF_DEFINITIONS) {
    const password = userPasswords[def.email];
    if (!password) {
      console.error(`❌ Missing password for synthetic user [${def.email}] in credentials file.`);
      return false;
    }

    // Attempt password sign in
    const { data: authResult, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: def.email,
      password,
    });

    if (signInErr || !authResult.user) {
      console.error(`❌ Password sign-in failed for [${def.email}]: ${signInErr?.message}`);
      return false;
    }

    // Verify role mapping
    const authUserId = authResult.user.id;
    const { data: adminUserRow, error: profileErr } = await adminClient
      .from('admin_users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (profileErr || !adminUserRow) {
      console.error(`❌ admin_users profile linkage failed for [${def.email}]: ${profileErr?.message}`);
      return false;
    }

    const { data: roleRows, error: roleErr } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', adminUserRow.id);

    if (roleErr || !roleRows || roleRows.length !== 1 || roleRows[0].role !== def.role) {
      console.error(
        `❌ Role mapping failed for [${def.email}]: expected role [${def.role}], found [${
          roleRows?.map((r) => r.role).join(',') || 'none'
        }]`
      );
      return false;
    }
  }

  console.log('✔ Synthetic staff accounts verified (Admin, Reviewer, Editor login & roles exact).');
  console.log('🎉 Local Supabase verification complete and 100% successful.');
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

  const success = await verifyLocalSupabaseSetup(credentialsPath);
  if (!success) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
