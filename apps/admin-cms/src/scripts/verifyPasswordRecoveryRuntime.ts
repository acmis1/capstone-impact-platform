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
  type RecoveryContextStatus,
} from '../auth/recoveryContext';
import { enforceAdminRecoveryGate } from '../auth/requireAdmin';
import { resolveAdminContextFromAuthUser } from '../auth/adminContext';
import { UUID_PATTERN, type VerifiedAuthClaims } from '../auth/claims';
import { parseClaimsResult } from '../auth/claimsResult';
import {
  getCurrentPasswordRecoverySessionState,
  hasRecoveryAcceptanceProvenance,
  hasSupportedAdminPasswordProvenance,
  registerPasswordRecoverySession,
  type RecoverySessionState,
} from '../auth/recoverySession';
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

async function verifiedRuntimeClaims(client: SupabaseClient): Promise<VerifiedAuthClaims> {
  return parseClaimsResult(await client.auth.getClaims());
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
  const sessionIds = new Set<string>();
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

  /**
   * Mirrors the production requireAdmin() trust order: the provenance gate must pass before an
   * Admin client, staff profile, or role lookup is ever attempted. The counter therefore proves
   * that a rejected session performed no Admin resolution at all.
   */
  let adminResolutionAttempts = 0;
  const guardedAdminResolution = async (
    resolved: VerifiedAuthClaims,
    state: RecoverySessionState,
    context: RecoveryContextStatus,
  ) => {
    enforceAdminRecoveryGate(resolved, state, context);
    adminResolutionAttempts += 1;
    return resolveAdminContextFromAuthUser(resolved.userId, service);
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

    const recoveryClaimsBeforeRefresh = await verifiedRuntimeClaims(recoveryClient);
    sessionIds.add(recoveryClaimsBeforeRefresh.sessionId);
    assert.equal(recoveryClaimsBeforeRefresh.userId, accepted.data.user.id);
    const refreshedRecovery = await recoveryClient.auth.refreshSession();
    assert.ifError(refreshedRecovery.error);
    assert(refreshedRecovery.data.session && refreshedRecovery.data.user);
    const recoveryClaimsAfterRefresh = await verifiedRuntimeClaims(recoveryClient);
    await scenario(7, 'recovery session ID remains stable across refresh', () => {
      assert.equal(recoveryClaimsAfterRefresh.sessionId, recoveryClaimsBeforeRefresh.sessionId);
      assert.deepEqual(recoveryClaimsBeforeRefresh.authenticationMethods, ['otp']);
      assert.deepEqual(recoveryClaimsAfterRefresh.authenticationMethods, ['otp']);
    });
    await scenario(8, 'recovery session maps to one Auth session row', () => {
      assert.equal(
        psql(
          `SELECT pg_catalog.count(*)::text || ':' || COALESCE(pg_catalog.bool_and(user_id = '${recoveryClaimsBeforeRefresh.userId}'::uuid), false)::text FROM auth.sessions WHERE id = '${recoveryClaimsBeforeRefresh.sessionId}'::uuid;`,
        ),
        '1:true',
      );
    });

    const freshPasswordClient = anon();
    const freshPasswordLogin = await freshPasswordClient.auth.signInWithPassword({
      email: staffEmail,
      password: oldPassword,
    });
    assert.ifError(freshPasswordLogin.error);
    assert(freshPasswordLogin.data.session && freshPasswordLogin.data.user);
    const freshPasswordClaims = await verifiedRuntimeClaims(freshPasswordClient);
    sessionIds.add(freshPasswordClaims.sessionId);
    await scenario(9, 'fresh password login uses a distinct session', () => {
      assert.notEqual(freshPasswordClaims.sessionId, recoveryClaimsBeforeRefresh.sessionId);
      assert.deepEqual(freshPasswordClaims.authenticationMethods, ['password']);
    });
    assert.ifError((await freshPasswordClient.auth.signOut({ scope: 'local' })).error);

    await scenario(10, 'Local Supabase applied exactly 50 migrations', () => {
      assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '50');
    });

    const registrations = await Promise.all([
      registerPasswordRecoverySession(service, recoveryClaimsAfterRefresh),
      registerPasswordRecoverySession(service, recoveryClaimsAfterRefresh),
    ]);
    await scenario(11, 'concurrent durable registration is idempotent', () => {
      assert.deepEqual(
        registrations.sort(),
        ['ALREADY_REGISTERED', 'REGISTERED'],
      );
    });
    await scenario(12, 'durable registration creates exactly one bounded ledger row', () => {
      assert.equal(
        psql(
          `SELECT count(*) FROM public.password_recovery_sessions WHERE session_id = '${recoveryClaimsAfterRefresh.sessionId}'::uuid AND auth_user_id = '${recoveryClaimsAfterRefresh.userId}'::uuid AND purpose = 'password_recovery';`,
        ),
        '1',
      );
    });

    const recoveryState = await getCurrentPasswordRecoverySessionState(recoveryClient);
    await scenario(13, 'authenticated no-argument lookup finds the exact recovery session', () => {
      assert.equal(recoveryState, 'RECOVERY_SESSION');
    });

    await scenario(14, 'anonymous callers cannot execute the authenticated lookup', async () => {
      const result = await anon().rpc('get_current_password_recovery_session_state');
      assert.equal(result.error?.code, '42501');
    });
    await scenario(15, 'authenticated callers cannot execute durable registration', async () => {
      const result = await recoveryClient.rpc('register_password_recovery_session', {
        p_session_id: recoveryClaimsAfterRefresh.sessionId,
        p_auth_user_id: recoveryClaimsAfterRefresh.userId,
      });
      assert.equal(result.error?.code, '42501');
    });
    await scenario(16, 'browser and service roles have no direct ledger table privileges', async () => {
      const unauthorized = [
        await anon().from('password_recovery_sessions').select('session_id').limit(1),
        await recoveryClient.from('password_recovery_sessions').select('session_id').limit(1),
        await recoveryClient.from('password_recovery_sessions').insert({
          session_id: crypto.randomUUID(),
          auth_user_id: recoveryClaimsAfterRefresh.userId,
          purpose: 'password_recovery',
        }),
        await recoveryClient.from('password_recovery_sessions')
          .update({ purpose: 'password_recovery' })
          .eq('session_id', crypto.randomUUID()),
        await recoveryClient.from('password_recovery_sessions')
          .delete()
          .eq('session_id', crypto.randomUUID()),
        await service.from('password_recovery_sessions').select('session_id').limit(1),
      ];
      assert(unauthorized.every(({ error }) => error?.code === '42501'));
    });

    let signedContext: string | null = signRecoveryContext(
      accepted.data.user.id,
      recoveryClaimsAfterRefresh.sessionId,
      {
        secret: signingSecret,
      },
    );
    await scenario(17, 'signed context is bound to the exact recovery user and session', () => {
      const verified = verifyRecoveryContext(signedContext, {
        secret: signingSecret,
        expectedUserId: accepted.data.user!.id,
        expectedSessionId: recoveryClaimsAfterRefresh.sessionId,
      });
      assert(verified.valid);
      assert.equal(verified.payload.expiresAt - verified.payload.issuedAt, RECOVERY_CONTEXT_MAX_AGE_SECONDS);
      assert(!JSON.stringify(verified.payload).match(/email|name|role/i));
    });
    await scenario(18, 'the production Admin gate blocks durable recovery with valid context', () => {
      assert.throws(
        () => enforceAdminRecoveryGate(
          recoveryClaimsAfterRefresh,
          'RECOVERY_SESSION',
          'valid',
        ),
        (error) => error instanceof AdminAuthError && error.type === 'PASSWORD_RECOVERY_REQUIRED',
      );
    });

    signedContext = null;
    await scenario(19, 'deleting only the signed context does not unblock Admin', () => {
      assert.equal(signedContext, null);
      assert.throws(
        () => enforceAdminRecoveryGate(recoveryClaimsAfterRefresh, 'RECOVERY_SESSION', 'absent'),
        (error) => error instanceof AdminAuthError && error.type === 'PASSWORD_RECOVERY_REQUIRED',
      );
    });

    const deterministicContext = signRecoveryContext(
      recoveryClaimsAfterRefresh.userId,
      recoveryClaimsAfterRefresh.sessionId,
      { secret: signingSecret, nowSeconds: 1_800_000_000 },
    );
    await scenario(20, 'expired signed context does not unblock durable recovery state', () => {
      assert.equal(verifyRecoveryContext(deterministicContext, {
        secret: signingSecret,
        nowSeconds: 1_800_000_000 + RECOVERY_CONTEXT_MAX_AGE_SECONDS,
        expectedUserId: recoveryClaimsAfterRefresh.userId,
        expectedSessionId: recoveryClaimsAfterRefresh.sessionId,
      }).valid, false);
      assert.throws(
        () => enforceAdminRecoveryGate(recoveryClaimsAfterRefresh, 'RECOVERY_SESSION', 'invalid'),
        (error) => error instanceof AdminAuthError && error.type === 'PASSWORD_RECOVERY_REQUIRED',
      );
    });

    const refreshedAgain = await recoveryClient.auth.refreshSession();
    assert.ifError(refreshedAgain.error);
    assert(refreshedAgain.data.session);
    const claimsAfterDurableRefresh = await verifiedRuntimeClaims(recoveryClient);
    const stateAfterRefresh = await getCurrentPasswordRecoverySessionState(recoveryClient);
    await scenario(21, 'session refresh preserves the ID, durable lookup, and Admin block', () => {
      assert.equal(claimsAfterDurableRefresh.sessionId, recoveryClaimsAfterRefresh.sessionId);
      assert.equal(stateAfterRefresh, 'RECOVERY_SESSION');
      assert.throws(
        () => enforceAdminRecoveryGate(claimsAfterDurableRefresh, stateAfterRefresh, 'absent'),
        (error) => error instanceof AdminAuthError && error.type === 'PASSWORD_RECOVERY_REQUIRED',
      );
    });

    await scenario(22, 'malformed signed context remains blocked by durable state', () => {
      assert.equal(verifyRecoveryContext('malformed.context', { secret: signingSecret }).valid, false);
      assert.throws(
        () => enforceAdminRecoveryGate(claimsAfterDurableRefresh, 'RECOVERY_SESSION', 'invalid'),
        (error) => error instanceof AdminAuthError && error.type === 'PASSWORD_RECOVERY_REQUIRED',
      );
    });

    signedContext = signRecoveryContext(
      claimsAfterDurableRefresh.userId,
      claimsAfterDurableRefresh.sessionId,
      { secret: signingSecret },
    );
    assert(verifyRecoveryContext(signedContext, {
      secret: signingSecret,
      expectedUserId: claimsAfterDurableRefresh.userId,
      expectedSessionId: claimsAfterDurableRefresh.sessionId,
    }).valid);

    const update = await recoveryClient.auth.updateUser({ password: newPassword });
    assert.ifError(update.error);
    assert(update.data.user);
    const staffAfter = await snapshotStaff();
    await scenario(23, 'password update leaves profile, role, and provisioning rows byte-for-byte unchanged', () => {
      assert.equal(staffAfter, staffBefore);
    });

    const staleAccessToken = refreshedAgain.data.session.access_token;
    assert.ifError((await recoveryClient.auth.signOut({ scope: 'local' })).error);
    const ended = await recoveryClient.auth.getSession();
    assert.ifError(ended.error);
    signedContext = null;
    await scenario(24, 'successful sign-out deletes the Auth session and cascades the ledger row', () => {
      assert.equal(ended.data.session, null);
      assert.equal(signedContext, null);
      assert.equal(
        psql(`SELECT count(*) FROM auth.sessions WHERE id = '${claimsAfterDurableRefresh.sessionId}'::uuid;`),
        '0',
      );
      assert.equal(
        psql(`SELECT count(*) FROM public.password_recovery_sessions WHERE session_id = '${claimsAfterDurableRefresh.sessionId}'::uuid;`),
        '0',
      );
    });

    const staleClient = createClient(cliEnv.API_URL!, cliEnv.ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${staleAccessToken}` } },
    });
    const staleClaims = parseClaimsResult(await staleClient.auth.getClaims(staleAccessToken));
    const staleLookup = await getCurrentPasswordRecoverySessionState(staleClient);
    await scenario(25, 'a still-unexpired stale recovery token has an inactive session and cannot enter Admin', async () => {
      assert.deepEqual(staleClaims.authenticationMethods, ['otp']);
      // Its auth.sessions row is gone, so the lookup reports inactive provenance, not an
      // ordinary non-recovery session.
      assert.equal(staleLookup, 'INVALID_CONTEXT');
      const attemptsBefore = adminResolutionAttempts;
      await assert.rejects(
        () => guardedAdminResolution(staleClaims, staleLookup, 'absent'),
        (error: unknown) => error instanceof AdminAuthError
          && error.type === 'AUTHENTICATION_PROVENANCE_INVALID',
      );
      assert.equal(adminResolutionAttempts, attemptsBefore);
    });

    await scenario(26, 'the old password fails after the recovery update', async () => {
      const oldLogin = await anon().auth.signInWithPassword({
        email: staffEmail,
        password: oldPassword,
      });
      assert(oldLogin.error);
      assert.equal(oldLogin.data.session, null);
    });

    const newPasswordClient = anon();
    const newLogin = await newPasswordClient.auth.signInWithPassword({
      email: staffEmail,
      password: newPassword,
    });
    assert.ifError(newLogin.error);
    assert(newLogin.data.session);
    const newPasswordClaims = await verifiedRuntimeClaims(newPasswordClient);
    sessionIds.add(newPasswordClaims.sessionId);
    const newPasswordState = await getCurrentPasswordRecoverySessionState(newPasswordClient);
    await scenario(27, 'fresh password login has a distinct supported session with no ledger row', () => {
      assert.notEqual(newPasswordClaims.sessionId, claimsAfterDurableRefresh.sessionId);
      assert.deepEqual(newPasswordClaims.authenticationMethods, ['password']);
      assert.equal(newPasswordState, 'NOT_REGISTERED');
      assert.doesNotThrow(() => enforceAdminRecoveryGate(
        newPasswordClaims,
        newPasswordState,
        'absent',
      ));
    });
    await scenario(28, 'ordinary Admin authorization succeeds only after fresh password login', async () => {
      const admin = await resolveAdminContextFromAuthUser(newPasswordClaims.userId, service);
      assert.equal(admin.authUserId, newPasswordClaims.userId);
      assert(admin.roles.includes('reviewer'));
    });
    assert.ifError((await newPasswordClient.auth.signOut({ scope: 'local' })).error);

    await scenario(29, 'the consumed token cannot be replayed', async () => {
      const replay = await anon().auth.verifyOtp({ type: 'recovery', token_hash: tokenHash });
      assert(replay.error);
      assert.equal(replay.data.session, null);
    });
    await scenario(30, 'malformed recovery tokens fail without a session', async () => {
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
    await scenario(31, 'an expired real recovery token fails without a session', async () => {
      const expired = await anon().auth.verifyOtp({ type: 'recovery', token_hash: expiryToken });
      assert(expired.error);
      assert.equal(expired.data.session, null);
    });
    await scenario(32, 'the nonexistent-address request produced no verifier-owned email', async () => {
      assert.equal((await searchMail(absentEmail)).length, 0);
    });
    await scenario(33, 'PKCE callback exchange is not falsely claimed under the custom Local template', () => {
      assert(recoveryBody.includes('token_hash='));
      assert(!recoveryBody.includes('/auth/recovery/callback?code='));
    });

    // Stale password access token: Supabase cannot revoke an issued JWT before its encoded exp,
    // so a retained ordinary password token must be rejected once its Auth session is deleted.
    const activeClient = anon();
    const activeLogin = await activeClient.auth.signInWithPassword({
      email: staffEmail,
      password: newPassword,
    });
    assert.ifError(activeLogin.error);
    assert(activeLogin.data.session);
    const activeClaims = await verifiedRuntimeClaims(activeClient);
    sessionIds.add(activeClaims.sessionId);
    const retainedToken = activeLogin.data.session.access_token;
    const activeLookup = await getCurrentPasswordRecoverySessionState(activeClient);
    const activeAdmin = await guardedAdminResolution(activeClaims, activeLookup, 'absent');

    await scenario(34, 'an active password session is bounded, present in auth.sessions, and admits Admin', () => {
      assert.deepEqual(activeClaims.authenticationMethods, ['password']);
      assert(UUID_PATTERN.test(activeClaims.sessionId));
      assert.equal(
        psql(
          `SELECT pg_catalog.count(*)::text || ':' || COALESCE(pg_catalog.bool_and(user_id = '${activeClaims.userId}'::uuid), false)::text FROM auth.sessions WHERE id = '${activeClaims.sessionId}'::uuid;`,
        ),
        '1:true',
      );
      assert.equal(activeLookup, 'NOT_REGISTERED');
      assert.equal(activeAdmin.authUserId, activeClaims.userId);
      assert(activeAdmin.roles.includes('reviewer'));
    });

    const attemptsBeforeStalePassword = adminResolutionAttempts;
    assert.ifError((await activeClient.auth.signOut({ scope: 'local' })).error);
    // Local-only: a throwaway client presenting the retained token, used for the lookup RPC only.
    const stalePasswordClient = createClient(cliEnv.API_URL!, cliEnv.ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${retainedToken}` } },
    });
    const staleAdmission = await stalePasswordClient.auth.getClaims(retainedToken);
    assert.ifError(staleAdmission.error);
    const stalePasswordClaims = parseClaimsResult(staleAdmission);
    const staleExpiry = (staleAdmission.data?.claims as { exp?: unknown } | undefined)?.exp;

    await scenario(35, 'sign-out deletes the password Auth session while its issued token stays valid', () => {
      assert.equal(
        psql(`SELECT count(*) FROM auth.sessions WHERE id = '${activeClaims.sessionId}'::uuid;`),
        '0',
      );
      // The retained token still verifies and still carries exact password provenance.
      assert.equal(stalePasswordClaims.sessionId, activeClaims.sessionId);
      assert.deepEqual(stalePasswordClaims.authenticationMethods, ['password']);
      assert(
        typeof staleExpiry === 'number' && staleExpiry * 1000 > Date.now(),
        'Retained password token expired before the stale-token check could run.',
      );
    });

    const stalePasswordLookup = await getCurrentPasswordRecoverySessionState(stalePasswordClient);
    await scenario(36, 'a retained password token for a deleted Auth session is refused Admin', async () => {
      assert.equal(stalePasswordLookup, 'INVALID_CONTEXT');
      await assert.rejects(
        () => guardedAdminResolution(stalePasswordClaims, stalePasswordLookup, 'absent'),
        (error: unknown) => error instanceof AdminAuthError
          && error.type === 'AUTHENTICATION_PROVENANCE_INVALID',
      );
      // No Admin client, staff profile, or role lookup was reached for the stale token.
      assert.equal(adminResolutionAttempts, attemptsBeforeStalePassword);
    });

    // Bounded pure-application contract only. Local Auth genuinely emits `otp` for the custom
    // TokenHash flow (proven above by real sessions), while Supabase's documented `amr` contract
    // also defines `recovery` for the hosted default-template PKCE exchange. No Auth token is
    // manufactured here: these are in-process claim structures exercising the provenance helpers.
    await scenario(37, 'documented recovery AMR is accepted only by recovery entry', () => {
      const structural = (authenticationMethods: string[]): VerifiedAuthClaims => ({
        userId: activeClaims.userId,
        sessionId: activeClaims.sessionId,
        authenticationMethods,
      });

      for (const method of ['otp', 'recovery']) {
        // Accepted as recovery-entry provenance.
        assert.equal(hasRecoveryAcceptanceProvenance(structural([method])), true);
        // Never accepted as Admin password provenance, and never admitted to Admin
        // without a durable recovery ledger row.
        assert.equal(hasSupportedAdminPasswordProvenance(structural([method])), false);
        assert.throws(
          () => enforceAdminRecoveryGate(structural([method]), 'NOT_REGISTERED', 'absent'),
          (error) => error instanceof AdminAuthError
            && error.type === 'AUTHENTICATION_PROVENANCE_INVALID',
        );
      }

      // Exact single-method equality only: no other documented method, near-miss string,
      // or multi-method set is recovery-entry provenance.
      for (const methods of [
        [],
        ['password'],
        ['invite'],
        ['magiclink'],
        ['email/signup'],
        ['email_change'],
        ['oauth'],
        ['token_refresh'],
        ['unknown'],
        ['otp_extra'],
        ['recovery_code'],
        ['OTP'],
        ['RECOVERY'],
        ['otp', 'password'],
        ['recovery', 'password'],
        ['otp', 'recovery'],
      ]) {
        assert.equal(hasRecoveryAcceptanceProvenance(structural(methods)), false);
      }

      // The real Local recovery session proven earlier still satisfies the same helper, and the
      // real Local password session still does not.
      assert.equal(hasRecoveryAcceptanceProvenance(recoveryClaimsAfterRefresh), true);
      assert.equal(hasRecoveryAcceptanceProvenance(activeClaims), false);
      assert.equal(hasSupportedAdminPasswordProvenance(activeClaims), true);
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
      if (sessionIds.size > 0) {
        const ids = [...sessionIds].map((id) => `'${id}'::uuid`).join(',');
        assert.equal(psql(`SELECT count(*) FROM auth.sessions WHERE id IN (${ids});`), '0');
        assert.equal(
          psql(`SELECT count(*) FROM public.password_recovery_sessions WHERE session_id IN (${ids});`),
          '0',
        );
      }
      console.log('PASS: Scenario 38 - all verifier-owned Auth, staff, session, ledger, and Mailpit fixtures are removed');
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
