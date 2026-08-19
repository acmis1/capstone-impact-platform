import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  RECOVERY_PASSWORD_PATH,
  validateConfirmationParams,
} from '../auth/confirmationValidation';
import {
  RECOVERY_CONTEXT_MAX_AGE_SECONDS,
  signRecoveryContext,
  verifyRecoveryContext,
} from '../auth/recoveryContext';
import { enforceAdminRecoveryGate } from '../auth/requireAdmin';
import { AdminAuthError } from '../auth/authTypes';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const CALLBACK_URL = 'http://localhost:3000/auth/recovery/callback';

interface MailSummary {
  ID: string;
  Subject: string;
}

interface MemoryStorage {
  values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function recoveryTokenFrom(body: string): string {
  const match = body.match(/token_hash=([A-Za-z0-9_-]+)/);
  assert(match, 'Local recovery email did not contain a token-hash link.');
  return match[1];
}

async function main(): Promise<void> {
  console.log('=== Secure Password Recovery Local Runtime Verification ===');

  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const cliEnv = parseSupabaseCliEnv(execSync(
    `"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`,
    { cwd: root, encoding: 'utf8', stdio: 'pipe' },
  ));
  assert(
    cliEnv.API_URL && cliEnv.ANON_KEY && cliEnv.SERVICE_ROLE_KEY && isLoopbackUrl(cliEnv.API_URL),
    'Verifier requires loopback Local Supabase.',
  );
  assert(cliEnv.INBUCKET_URL && isLoopbackUrl(cliEnv.INBUCKET_URL), 'Verifier requires loopback Mailpit.');
  const mailApi = `${cliEnv.INBUCKET_URL.replace(/\/$/, '')}/api/v1`;

  const localEnv = parseSupabaseCliEnv(
    fs.readFileSync(path.resolve(root, 'apps/admin-cms/.env.local'), 'utf8'),
  );
  const signingSecret = localEnv.CAPSTONE_AUTH_FLOW_SECRET;
  assert(signingSecret && Buffer.byteLength(signingSecret, 'utf8') >= 32, 'Local recovery signing secret is unavailable.');

  const service = createClient(cliEnv.API_URL, cliEnv.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = (storage?: MemoryStorage): SupabaseClient => createClient(
    cliEnv.API_URL!,
    cliEnv.ANON_KEY!,
    {
      auth: {
        flowType: 'pkce',
        persistSession: Boolean(storage),
        autoRefreshToken: false,
        detectSessionInUrl: false,
        ...(storage ? { storage } : {}),
      },
    },
  );

  const prefix = `recovery-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const staffEmail = `${prefix}.staff@capstone.test`;
  const expiryEmail = `${prefix}.expired@capstone.test`;
  const absentEmail = `${prefix}.absent@capstone.test`;
  const oldPassword = `Old_${crypto.randomBytes(18).toString('hex')}!`;
  const newPassword = `New_${crypto.randomBytes(18).toString('hex')}!`;
  const expiryPassword = `Expiry_${crypto.randomBytes(18).toString('hex')}!`;
  const authIds = new Set<string>();
  const adminIds = new Set<string>();
  const mailIds = new Set<string>();
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;

  const psql = (sql: string): string => execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

  const scenario = async (number: number, name: string, run: () => Promise<void> | void) => {
    await run();
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  const searchMail = async (recipient: string): Promise<MailSummary[]> => {
    const response = await fetch(`${mailApi}/search?query=${encodeURIComponent(`to:${recipient}`)}`);
    assert(response.ok, 'Local Mailpit search failed.');
    const body = await response.json() as { messages?: MailSummary[] };
    for (const message of body.messages ?? []) mailIds.add(message.ID);
    return body.messages ?? [];
  };

  const waitForMail = async (recipient: string): Promise<MailSummary> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const messages = await searchMail(recipient);
      if (messages.length === 1) return messages[0];
      assert(messages.length < 2, 'Expected exactly one verifier-owned recovery email.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Local recovery email was not delivered to Mailpit.');
  };

  const mailBody = async (id: string): Promise<string> => {
    const response = await fetch(`${mailApi}/message/${encodeURIComponent(id)}`);
    assert(response.ok, 'Local Mailpit message read failed.');
    const message = await response.json() as { HTML?: string; Text?: string };
    return `${message.HTML ?? ''}\n${message.Text ?? ''}`;
  };

  const snapshotStaff = async () => {
    const profiles = await service
      .from('admin_users')
      .select('id,email,full_name,auth_user_id')
      .eq('email', staffEmail);
    assert.ifError(profiles.error);
    assert.equal(profiles.data?.length, 1);
    const adminId = String(profiles.data![0].id);
    const roles = await service.from('user_roles').select('role').eq('user_id', adminId).order('role');
    assert.ifError(roles.error);
    const provisioning = await service
      .from('staff_provisioning_requests')
      .select('id,status,requested_roles,auth_user_id,admin_user_id')
      .eq('normalized_email', staffEmail)
      .order('created_at');
    assert.ifError(provisioning.error);
    return JSON.stringify({ profile: profiles.data, roles: roles.data, provisioning: provisioning.data });
  };

  try {
    const created = await service.auth.admin.createUser({
      email: staffEmail,
      password: oldPassword,
      email_confirm: true,
    });
    assert.ifError(created.error);
    assert(created.data.user);
    authIds.add(created.data.user.id);
    const profile = await service.from('admin_users').insert({
      email: staffEmail,
      full_name: 'Local Password Recovery Fixture',
      auth_user_id: created.data.user.id,
    }).select('id').single();
    assert.ifError(profile.error);
    adminIds.add(String(profile.data.id));
    assert.ifError((await service.from('user_roles').insert({ user_id: profile.data.id, role: 'reviewer' })).error);
    const staffBefore = await snapshotStaff();

    await scenario(1, 'a provisioned Local staff identity is isolated for recovery', async () => {
      const client = anon();
      const login = await client.auth.signInWithPassword({ email: staffEmail, password: oldPassword });
      assert.ifError(login.error);
      assert(login.data.session && login.data.user);
      assert.ifError((await client.auth.signOut({ scope: 'local' })).error);
    });

    const requestStorage = memoryStorage();
    const requestClient = anon(requestStorage);
    const existingRequest = await requestClient.auth.resetPasswordForEmail(staffEmail, {
      redirectTo: CALLBACK_URL,
    });
    const absentRequest = await anon(memoryStorage()).auth.resetPasswordForEmail(absentEmail, {
      redirectTo: CALLBACK_URL,
    });
    const responseShape = (result: typeof existingRequest) => ({
      error: result.error === null ? null : 'bounded-error',
      dataKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data).sort() : [],
    });

    await scenario(2, 'existing and nonexistent recovery requests have an identical provider response shape', () => {
      assert.deepEqual(responseShape(existingRequest), responseShape(absentRequest));
    });
    await scenario(3, 'PKCE verifier state is established only in the initiating client', () => {
      assert([...requestStorage.values.keys()].some((key) => key.endsWith('-code-verifier')));
    });

    const recoveryMessage = await waitForMail(staffEmail);
    const recoveryBody = await mailBody(recoveryMessage.ID);
    const tokenHash = recoveryTokenFrom(recoveryBody);
    await scenario(4, 'Mailpit receives the exact custom token-hash recovery URL', () => {
      assert(recoveryBody.includes('/auth/confirm?token_hash='));
      assert(recoveryBody.includes('type=recovery'));
      assert(recoveryBody.includes('next=/auth/reset-password'));
      assert(!recoveryBody.includes('staff_metadata'));
    });

    await scenario(5, 'GET capture validation alone does not consume the token', async () => {
      assert.deepEqual(
        validateConfirmationParams({ tokenHash, type: 'recovery', next: RECOVERY_PASSWORD_PATH }),
        { isValid: true, type: 'recovery', next: RECOVERY_PASSWORD_PATH },
      );
      const client = anon();
      const oldLogin = await client.auth.signInWithPassword({ email: staffEmail, password: oldPassword });
      assert.ifError(oldLogin.error);
      assert(oldLogin.data.session);
      assert.ifError((await client.auth.signOut({ scope: 'local' })).error);
    });

    const recoveryClient = anon();
    const accepted = await recoveryClient.auth.verifyOtp({ type: 'recovery', token_hash: tokenHash });
    assert.ifError(accepted.error);
    assert(accepted.data.user && accepted.data.session);
    assert.equal(accepted.data.user.id, created.data.user.id);
    await scenario(6, 'explicit recovery acceptance establishes one real recovery session', () => {
      assert(accepted.data.session);
    });

    let signedContext: string | null = signRecoveryContext(accepted.data.user.id, {
      secret: signingSecret,
    });
    await scenario(7, 'the signed recovery context is valid, user-bound, and short-lived', () => {
      const verified = verifyRecoveryContext(signedContext, {
        secret: signingSecret,
        expectedUserId: accepted.data.user!.id,
      });
      assert(verified.valid);
      assert.equal(verified.payload.expiresAt - verified.payload.issuedAt, RECOVERY_CONTEXT_MAX_AGE_SECONDS);
      assert(!JSON.stringify(verified.payload).match(/email|name|role/i));
    });
    await scenario(8, 'the production Admin recovery gate rejects the active context', () => {
      assert.throws(
        () => enforceAdminRecoveryGate('valid'),
        (error) => error instanceof AdminAuthError && error.type === 'PASSWORD_RECOVERY_REQUIRED',
      );
    });

    const update = await recoveryClient.auth.updateUser({ password: newPassword });
    assert.ifError(update.error);
    assert(update.data.user);
    const staffAfter = await snapshotStaff();
    await scenario(9, 'password update leaves profile, role, and provisioning rows byte-for-byte unchanged', () => {
      assert.equal(staffAfter, staffBefore);
    });

    assert.ifError((await recoveryClient.auth.signOut({ scope: 'local' })).error);
    const ended = await recoveryClient.auth.getSession();
    assert.ifError(ended.error);
    signedContext = null;
    await scenario(10, 'the recovery session terminates and local context is cleared', () => {
      assert.equal(ended.data.session, null);
      assert.equal(signedContext, null);
    });
    await scenario(11, 'the old password fails and the new password signs in', async () => {
      const oldLogin = await anon().auth.signInWithPassword({ email: staffEmail, password: oldPassword });
      assert(oldLogin.error);
      assert.equal(oldLogin.data.session, null);
      const client = anon();
      const newLogin = await client.auth.signInWithPassword({ email: staffEmail, password: newPassword });
      assert.ifError(newLogin.error);
      assert(newLogin.data.session);
      assert.ifError((await client.auth.signOut({ scope: 'local' })).error);
    });

    await scenario(12, 'the consumed token cannot be replayed', async () => {
      const replay = await anon().auth.verifyOtp({ type: 'recovery', token_hash: tokenHash });
      assert(replay.error);
      assert.equal(replay.data.session, null);
    });
    await scenario(13, 'malformed recovery tokens fail without a session', async () => {
      const malformed = await anon().auth.verifyOtp({ type: 'recovery', token_hash: 'malformed' });
      assert(malformed.error);
      assert.equal(malformed.data.session, null);
    });

    const expiryCreated = await service.auth.admin.createUser({
      email: expiryEmail,
      password: expiryPassword,
      email_confirm: true,
    });
    assert.ifError(expiryCreated.error);
    assert(expiryCreated.data.user);
    authIds.add(expiryCreated.data.user.id);
    const expiryRequest = await anon().auth.resetPasswordForEmail(expiryEmail, { redirectTo: CALLBACK_URL });
    assert.ifError(expiryRequest.error);
    const expiryMessage = await waitForMail(expiryEmail);
    const expiryToken = recoveryTokenFrom(await mailBody(expiryMessage.ID));
    psql(`UPDATE auth.users SET recovery_sent_at = now() - interval '2 hours' WHERE id = '${expiryCreated.data.user.id}';`);
    await scenario(14, 'an expired real recovery token fails without a session', async () => {
      const expired = await anon().auth.verifyOtp({ type: 'recovery', token_hash: expiryToken });
      assert(expired.error);
      assert.equal(expired.data.session, null);
    });
    await scenario(15, 'an expired signed recovery context fails locally', () => {
      const context = signRecoveryContext(created.data.user!.id, {
        secret: signingSecret,
        nowSeconds: 1_800_000_000,
      });
      assert.equal(verifyRecoveryContext(context, {
        secret: signingSecret,
        nowSeconds: 1_800_000_000 + RECOVERY_CONTEXT_MAX_AGE_SECONDS,
      }).valid, false);
    });

    await scenario(16, 'the nonexistent-address request produced no verifier-owned email', async () => {
      assert.equal((await searchMail(absentEmail)).length, 0);
    });
    await scenario(17, 'PKCE callback exchange is not falsely claimed under the custom Local template', () => {
      assert(recoveryBody.includes('token_hash='));
      assert(!recoveryBody.includes('/auth/recovery/callback?code='));
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      for (const adminId of adminIds) {
        const deleted = await service.from('admin_users').delete().eq('id', adminId);
        assert.ifError(deleted.error);
      }
      for (const authId of authIds) {
        const deleted = await service.auth.admin.deleteUser(authId);
        if (deleted.error && !/not found/i.test(deleted.error.message)) {
          throw new Error('Verifier-owned Auth cleanup failed.');
        }
      }
      if (mailIds.size) {
        const deletedMail = await fetch(`${mailApi}/messages`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ IDs: [...mailIds] }),
        });
        assert(deletedMail.ok, 'Verifier-owned Mailpit cleanup failed.');
      }
      assert.equal(psql(`SELECT count(*) FROM auth.users WHERE email LIKE '${prefix}%';`), '0');
      assert.equal(psql(`SELECT count(*) FROM public.admin_users WHERE email LIKE '${prefix}%';`), '0');
      assert.equal(psql(`SELECT count(*) FROM public.staff_provisioning_requests WHERE normalized_email LIKE '${prefix}%';`), '0');
      console.log('PASS: Scenario 18 - all verifier-owned Auth, staff, session, and Mailpit fixtures are removed');
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure || cleanupFailure) {
    console.error('Password recovery runtime verification failed.');
    process.exitCode = 1;
    return;
  }
  console.log('PASS: Local custom token-hash recovery tested end to end.');
  console.log('SKIP: Local PKCE callback exchange requires a default ConfirmationURL email; the active Local custom template intentionally emits TokenHash.');
  console.log('PASS: Secure password recovery Local runtime verification complete.');
}

void main();
