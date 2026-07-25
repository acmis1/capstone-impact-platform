import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv, validateAllowedOutputPath } from './localEnvironmentFile';
import { execSync } from 'node:child_process';

export interface StaffUserConfig {
  label: string;
  email: string;
  fullName: string;
  role: 'admin' | 'reviewer' | 'editor';
}

export const SYNTHETIC_STAFF_DEFINITIONS: StaffUserConfig[] = [
  {
    label: 'local-admin',
    email: 'local.admin@capstone.test',
    fullName: 'Local Synthetic Admin',
    role: 'admin',
  },
  {
    label: 'local-reviewer',
    email: 'local.reviewer@capstone.test',
    fullName: 'Local Synthetic Reviewer',
    role: 'reviewer',
  },
  {
    label: 'local-editor',
    email: 'local.editor@capstone.test',
    fullName: 'Local Synthetic Editor',
    role: 'editor',
  },
];

export interface CredentialsFileFormat {
  generatedAt: string;
  users: Record<string, string>; // email -> password
}

/**
 * Generates a strong random password for local synthetic user.
 */
export function generateRandomPassword(): string {
  return `LocalDev_${crypto.randomBytes(12).toString('hex')}!`;
}

export interface ProvisionUsersOptions {
  credentialsOutputPath?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  cliOutput?: string;
}

/**
 * Reads or initializes local credentials map without exposing secrets.
 */
export function loadOrGenerateLocalCredentials(credsPath: string): Record<string, string> {
  const userCreds: Record<string, string> = {};
  if (fs.existsSync(credsPath)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as CredentialsFileFormat;
      if (fileData && fileData.users) {
        Object.assign(userCreds, fileData.users);
      }
    } catch {
      // Ignore parse errors and generate fresh
    }
  }

  for (const def of SYNTHETIC_STAFF_DEFINITIONS) {
    if (!userCreds[def.email]) {
      userCreds[def.email] = generateRandomPassword();
    }
  }

  return userCreds;
}

/**
 * Worker function containing synthetic staff user provisioning logic.
 * Accepts a Supabase client dependency and a target credentials file path.
 */
export async function provisionLocalStaffUsersWorker(
  supabaseAdmin: SupabaseClient,
  credsPath: string
): Promise<{
  credentialsPath: string;
  provisionedRoles: string[];
}> {
  // Load or generate credentials map
  const credentialsMap = loadOrGenerateLocalCredentials(credsPath);

  // Save updated credentials map to disk
  const credsData: CredentialsFileFormat = {
    generatedAt: new Date().toISOString(),
    users: credentialsMap,
  };
  const targetDir = path.dirname(credsPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.writeFileSync(credsPath, JSON.stringify(credsData, null, 2), { encoding: 'utf8', mode: 0o600 });

  // Paginate Auth users list with a finite maximum-page guard
  const existingAuthUsers: Record<string, string> = {}; // email -> auth_id
  let page = 1;
  const perPage = 50;
  const maxPages = 10;
  let reachedEnd = false;

  while (page <= maxPages) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error('Failed to list local Auth users.');
    }
    if (!data.users || data.users.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const u of data.users) {
      if (u.email) {
        existingAuthUsers[u.email.toLowerCase()] = u.id;
      }
    }
    if (data.users.length < perPage) {
      reachedEnd = true;
      break;
    }
    page++;
  }

  if (!reachedEnd) {
    throw new Error('Pagination limit reached while listing Auth users.');
  }

  const provisionedRoles: string[] = [];

  // Provision each synthetic user deterministically
  for (const def of SYNTHETIC_STAFF_DEFINITIONS) {
    const emailNorm = def.email.toLowerCase();
    const password = credentialsMap[def.email];
    let authUserId = existingAuthUsers[emailNorm];

    if (!authUserId) {
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: def.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: def.fullName },
      });
      if (createErr || !newUser.user) {
        throw new Error(`Failed to create Auth user.`);
      }
      authUserId = newUser.user.id;
    } else {
      const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
        password,
        email_confirm: true,
        user_metadata: { full_name: def.fullName },
      });
      if (updateErr) {
        throw new Error(`Failed to update Auth user.`);
      }
    }

    // Upsert public.admin_users record
    const { data: adminUserRow, error: adminErr } = await supabaseAdmin
      .from('admin_users')
      .upsert(
        {
          email: emailNorm,
          full_name: def.fullName,
          auth_user_id: authUserId,
        },
        { onConflict: 'email' }
      )
      .select('id')
      .single();

    if (adminErr || !adminUserRow) {
      throw new Error(`Failed to upsert admin_users profile.`);
    }

    const adminProfileId = adminUserRow.id;

    // Delete existing roles for ONLY this profile and insert exact target role
    const { error: deleteRoleErr } = await supabaseAdmin
      .from('user_roles')
      .delete()
      .eq('user_id', adminProfileId);

    if (deleteRoleErr) {
      throw new Error(`Failed to reset roles for user.`);
    }

    const { error: insertRoleErr } = await supabaseAdmin.from('user_roles').insert({
      user_id: adminProfileId,
      role: def.role,
    });

    if (insertRoleErr) {
      throw new Error(`Failed to set user_role for user.`);
    }

    provisionedRoles.push(`${def.role}:${def.email}`);
  }

  return { credentialsPath: credsPath, provisionedRoles };
}

/**
 * Public local entry point. Always performs local status and loopback URL validation.
 * Never imports server-only environment modules or contacts hosted endpoints.
 */
export async function provisionLocalStaffUsers(options: ProvisionUsersOptions = {}): Promise<{
  credentialsPath: string;
  provisionedRoles: string[];
}> {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const defaultCredsPath = path.resolve(repoRoot, 'apps/admin-cms/.local-users.json');
  const credsPath = options.credentialsOutputPath ? path.resolve(options.credentialsOutputPath) : defaultCredsPath;

  // Validate allowed output path restriction
  validateAllowedOutputPath(credsPath, defaultCredsPath, repoRoot);

  let apiUrl = options.supabaseUrl;
  let serviceKey = options.serviceRoleKey;

  if (!apiUrl || !serviceKey) {
    const workdir = path.resolve(repoRoot, 'infra');
    const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;
    try {
      const rawEnv = options.cliOutput || execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
      const parsed = parseSupabaseCliEnv(rawEnv);
      apiUrl = parsed.API_URL || apiUrl;
      serviceKey = parsed.SERVICE_ROLE_KEY || serviceKey;
    } catch {
      throw new Error('Local Supabase CLI status query failed.');
    }
  }

  if (!apiUrl || !isLoopbackUrl(apiUrl)) {
    throw new Error('Non-loopback Supabase endpoint rejected.');
  }

  if (!serviceKey) {
    throw new Error('Local service-role administrative key required.');
  }

  const supabaseAdmin = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return provisionLocalStaffUsersWorker(supabaseAdmin, credsPath);
}
