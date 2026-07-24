import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl, parseSupabaseCliEnv } from './localEnvironmentFile';
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

export interface StoredUserCredential {
  email: string;
  role: string;
  passwordHash?: string;
  password?: string;
}

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
 * Main provisioner logic for local synthetic staff users.
 */
export async function provisionLocalStaffUsers(options: ProvisionUsersOptions = {}): Promise<{
  credentialsPath: string;
  provisionedRoles: string[];
}> {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const defaultCredsPath = path.resolve(repoRoot, 'apps/admin-cms/.local-users.json');
  const credsPath = options.credentialsOutputPath ? path.resolve(options.credentialsOutputPath) : defaultCredsPath;

  // 1. Resolve URL and service role key from CLI status if not supplied
  let apiUrl = options.supabaseUrl;
  let serviceKey = options.serviceRoleKey;

  if (!apiUrl || !serviceKey) {
    const workdir = path.resolve(repoRoot, 'infra');
    const cliPath = path.resolve(repoRoot, 'node_modules/.bin/supabase');
    const cmd = `"${cliPath}" status --workdir "${workdir}" -o env`;
    try {
      const rawEnv = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
      const parsed = parseSupabaseCliEnv(rawEnv);
      apiUrl = parsed.API_URL || apiUrl;
      serviceKey = parsed.SERVICE_ROLE_KEY || serviceKey;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read local status output: ${msg}`);
    }
  }

  if (!apiUrl || !isLoopbackUrl(apiUrl)) {
    throw new Error(`Security Error: Non-loopback Supabase URL rejected: ${apiUrl}`);
  }

  if (!serviceKey) {
    throw new Error('Security Error: Local service-role key is required to provision staff users.');
  }

  const supabaseAdmin = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 2. Load or generate credentials map
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

  // 3. Paginate Auth users list
  const existingAuthUsers: Record<string, string> = {}; // email -> auth_id
  let page = 1;
  const perPage = 50;
  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Failed to list local Auth users: ${error.message}`);
    }
    if (!data.users || data.users.length === 0) break;
    for (const u of data.users) {
      if (u.email) {
        existingAuthUsers[u.email.toLowerCase()] = u.id;
      }
    }
    if (data.users.length < perPage) break;
    page++;
  }

  const provisionedRoles: string[] = [];

  // 4. Provision each synthetic user deterministically
  for (const def of SYNTHETIC_STAFF_DEFINITIONS) {
    const emailNorm = def.email.toLowerCase();
    const password = credentialsMap[def.email];
    let authUserId = existingAuthUsers[emailNorm];

    if (!authUserId) {
      // Create missing Auth user
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: def.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: def.fullName },
      });
      if (createErr || !newUser.user) {
        throw new Error(`Failed to create Auth user [${def.email}]: ${createErr?.message}`);
      }
      authUserId = newUser.user.id;
    } else {
      // Update password & ensure confirmed
      const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authUserId, {
        password,
        email_confirm: true,
        user_metadata: { full_name: def.fullName },
      });
      if (updateErr) {
        throw new Error(`Failed to update Auth user [${def.email}]: ${updateErr.message}`);
      }
    }

    // 5. Upsert public.admin_users record
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
      throw new Error(`Failed to upsert admin_users profile for [${def.email}]: ${adminErr?.message}`);
    }

    const adminProfileId = adminUserRow.id;

    // 6. Delete existing roles for this profile and insert exact target role
    await supabaseAdmin.from('user_roles').delete().eq('user_id', adminProfileId);

    const { error: roleErr } = await supabaseAdmin.from('user_roles').insert({
      user_id: adminProfileId,
      role: def.role,
    });

    if (roleErr) {
      throw new Error(`Failed to set user_role [${def.role}] for [${def.email}]: ${roleErr.message}`);
    }

    provisionedRoles.push(`${def.role}:${def.email}`);
  }

  return { credentialsPath: credsPath, provisionedRoles };
}
