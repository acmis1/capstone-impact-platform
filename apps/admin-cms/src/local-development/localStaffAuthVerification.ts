import type { SupabaseClient } from '@supabase/supabase-js';
import { SYNTHETIC_STAFF_DEFINITIONS } from './localStaffUsers';

export function validateCredentialsStructure(parsed: unknown): Record<string, string> {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid credentials file: Root must be an object.');
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.users || typeof obj.users !== 'object' || Array.isArray(obj.users)) {
    throw new Error('Invalid credentials file: Missing or invalid top-level users object.');
  }

  const userCreds = obj.users as Record<string, unknown>;
  const expectedEmails = new Set(SYNTHETIC_STAFF_DEFINITIONS.map((d) => d.email));
  const foundEmails = new Set(Object.keys(userCreds));

  if (foundEmails.size !== expectedEmails.size) {
    throw new Error('Invalid credentials file: Unexpected credential keys count.');
  }

  for (const expected of expectedEmails) {
    if (!foundEmails.has(expected)) {
      throw new Error('Invalid credentials file: Missing required synthetic email key.');
    }
    const val = userCreds[expected];
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw new Error('Invalid credentials file: Non-empty password string required.');
    }
  }

  return userCreds as Record<string, string>;
}

export async function verifySyntheticStaffAuthLogins(
  userCreds: Record<string, string>,
  createAnonClient: () => SupabaseClient,
  adminClient: SupabaseClient
): Promise<boolean> {
  for (const def of SYNTHETIC_STAFF_DEFINITIONS) {
    const password = userCreds[def.email];
    if (!password) {
      console.error(`❌ Missing password for synthetic staff [${def.label}].`);
      return false;
    }

    const anonClient = createAnonClient();
    const { data: authResult, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: def.email,
      password,
    });

    if (signInErr || !authResult.user) {
      console.error(`❌ Password sign-in failed for synthetic staff [${def.label}].`);
      return false;
    }

    if (authResult.user.email?.toLowerCase() !== def.email.toLowerCase()) {
      console.error(`❌ Auth user email mismatch for synthetic staff [${def.label}].`);
      return false;
    }

    const authUserId = authResult.user.id;
    const { data: adminUserRow, error: profileErr } = await adminClient
      .from('admin_users')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();

    if (profileErr || !adminUserRow) {
      console.error(`❌ Profile linkage mismatch for synthetic staff [${def.label}].`);
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

  return true;
}
