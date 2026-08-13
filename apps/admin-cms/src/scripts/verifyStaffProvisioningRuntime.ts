import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { resolveAdminContextFromAuthUser } from '../auth/adminContext';
import { AdminAuthError, type AuthenticatedAdminContext } from '../auth/authTypes';
import { canManageStaff, getPermissionsForRoles } from '../auth/permissions';
import { validateCredentialsStructure } from '../local-development/localStaffAuthVerification';
import { SYNTHETIC_STAFF_DEFINITIONS } from '../local-development/localStaffUsers';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { completeStaffActivation } from '../staff/staffActivation';
import { provisionStaffMember, type StaffInvitationGateway } from '../staff/staffProvisioningService';
import {
  SupabaseStaffInvitationGateway,
  SupabaseStaffProvisioningGateway,
} from '../staff/staffProvisioningRepository';
import { readStaffDirectory } from '../staff/staffDirectory';

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const MAIL_API = 'http://127.0.0.1:54324/api/v1';

type StaffLabel = 'local-admin' | 'local-reviewer' | 'local-editor';

interface ProvisioningRow {
  id: string;
  normalized_email: string;
  full_name: string;
  requested_roles: string[];
  status: string;
  auth_user_id: string | null;
  admin_user_id: string | null;
  auth_identity_owned: boolean;
  lease_expires_at: string;
  failure_code: string | null;
  requested_by_admin_id: string | null;
  requested_by_email_snapshot: string | null;
}

async function main(): Promise<void> {
  console.log('=== Controlled Staff Identity Provisioning Local Runtime Verification ===');

  const root = path.resolve(__dirname, '../../../..');
  const cli = path.resolve(root, 'node_modules/.bin/supabase');
  const env = parseSupabaseCliEnv(
    execSync(`"${cli}" status --workdir "${path.resolve(root, 'infra')}" -o env`, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );
  assert(
    env.API_URL && env.ANON_KEY && env.SERVICE_ROLE_KEY && isLoopbackUrl(env.API_URL),
    'Verifier requires loopback Local Supabase.',
  );

  const credentials = validateCredentialsStructure(
    JSON.parse(fs.readFileSync(path.resolve(root, 'apps/admin-cms/.local-users.json'), 'utf8')),
  );
  const service = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonClient = () =>
    createClient(env.API_URL!, env.ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  const prefix = `staffprov-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const targetEmail = (suffix: string) => `${prefix}.${suffix}@capstone.test`;

  const createdAuthIds = new Set<string>();
  const createdAdminIds = new Set<string>();
  const mailMessageIds = new Set<string>();
  const staff = new Map<StaffLabel, AuthenticatedAdminContext>();
  let editorReviewerAdded = false;
  let failureTriggerInstalled = false;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;

  const psql = (sql: string): string =>
    execFileSync(
      'docker',
      ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();

  const scenario = async (number: number, name: string, run: () => Promise<void> | void): Promise<void> => {
    await run();
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  const context = (label: StaffLabel): AuthenticatedAdminContext => {
    const value = staff.get(label);
    assert(value, `Missing ${label} context.`);
    return value;
  };

  const signIn = async (label: StaffLabel) => {
    const definition = SYNTHETIC_STAFF_DEFINITIONS.find((entry) => entry.label === label);
    assert(definition, `Missing ${label} definition.`);
    const client = anonClient();
    const result = await client.auth.signInWithPassword({
      email: definition.email,
      password: credentials[definition.email],
    });
    assert.ifError(result.error);
    assert(result.data.user, `${label} login did not issue a session.`);
    const resolved = await resolveAdminContextFromAuthUser(result.data.user.id, service);
    staff.set(label, resolved);
    return { client, context: resolved };
  };

  /** Runs the real production workflow with the real Supabase gateways. */
  const provision = async (
    actor: AuthenticatedAdminContext,
    input: unknown,
    options: { enabled?: boolean; invitations?: StaffInvitationGateway } = {},
  ) =>
    provisionStaffMember(
      {
        permissions: actor.permissions,
        actorAdminUserId: actor.adminUserId,
        provisioningEnabled: options.enabled ?? true,
        provisioning: new SupabaseStaffProvisioningGateway(service),
        invitations: options.invitations ?? new SupabaseStaffInvitationGateway(service),
      },
      input,
    );

  const requestFor = async (email: string): Promise<ProvisioningRow | null> => {
    const result = await service
      .from('staff_provisioning_requests')
      .select('*')
      .eq('normalized_email', email)
      .order('created_at', { ascending: false })
      .limit(1);
    assert.ifError(result.error);
    return (result.data?.[0] as ProvisioningRow | undefined) ?? null;
  };

  const requestsFor = async (email: string): Promise<ProvisioningRow[]> => {
    const result = await service.from('staff_provisioning_requests').select('*').eq('normalized_email', email);
    assert.ifError(result.error);
    return (result.data ?? []) as ProvisioningRow[];
  };

  const authUsersFor = async (email: string): Promise<string[]> =>
    psql(`SELECT id FROM auth.users WHERE pg_catalog.lower(pg_catalog.btrim(email)) = '${email}';`)
      .split(/\r?\n/)
      .filter(Boolean);

  const profileFor = async (email: string) => {
    const result = await service.from('admin_users').select('id, email, full_name, auth_user_id').eq('email', email);
    assert.ifError(result.error);
    return (result.data ?? []) as Array<{ id: string; email: string; full_name: string; auth_user_id: string }>;
  };

  const rolesFor = async (adminUserId: string): Promise<string[]> => {
    const result = await service.from('user_roles').select('role').eq('user_id', adminUserId);
    assert.ifError(result.error);
    return (result.data ?? []).map((row) => String(row.role)).sort();
  };

  const track = async (email: string) => {
    for (const id of await authUsersFor(email)) createdAuthIds.add(id);
    for (const profile of await profileFor(email)) createdAdminIds.add(profile.id);
  };

  /**
   * Reads the Local email sink (the pinned stack ships Mailpit). Every target address carries the
   * unique run prefix, so a recipient search is exact and cannot observe another run's mail. No
   * external mail provider or SMTP relay is contacted at any point.
   */
  const mailbox = async (email: string) => {
    const response = await fetch(`${MAIL_API}/search?query=${encodeURIComponent(`to:${email}`)}`);
    assert(response.ok, 'Local email sink is not reachable.');
    const payload = (await response.json()) as { messages?: Array<{ ID: string; Subject: string }> };
    const messages = payload.messages ?? [];
    for (const message of messages) mailMessageIds.add(message.ID);
    return messages.map((message) => ({ id: message.ID, subject: message.Subject }));
  };

  const mailBody = async (_email: string, id: string): Promise<string> => {
    const response = await fetch(`${MAIL_API}/message/${encodeURIComponent(id)}`);
    assert(response.ok, 'Local invitation message could not be read.');
    const message = (await response.json()) as { HTML?: string; Text?: string };
    return `${message.HTML ?? ''}\n${message.Text ?? ''}`;
  };

  const tokenHashFrom = (body: string): string => {
    const match = body.match(/token_hash=([A-Za-z0-9_-]+)/);
    assert(match, 'Invitation message did not contain the expected confirmation link.');
    return match[1];
  };

  /** Mirrors the production accept + set-password flow for a Local invited identity. */
  const activate = async (email: string, password: string) => {
    const messages = await mailbox(email);
    assert.equal(messages.length, 1, 'Expected exactly one Local invitation message.');
    const body = await mailBody(email, messages[0].id);
    const tokenHash = tokenHashFrom(body);

    const client = anonClient();
    const verified = await client.auth.verifyOtp({ type: 'invite', token_hash: tokenHash });
    assert.ifError(verified.error);
    assert(verified.data.user, 'Invitation acceptance did not resolve an identity.');

    const updated = await client.auth.updateUser({ password });
    assert.ifError(updated.error);

    const activation = await completeStaffActivation(service, verified.data.user.id);
    await client.auth.signOut();
    return { authUserId: verified.data.user.id, activation, tokenHash };
  };

  const expectAuthError = async (authUserId: string, type: AdminAuthError['type']) => {
    try {
      await resolveAdminContextFromAuthUser(authUserId, service);
      assert.fail(`Expected ${type}.`);
    } catch (error) {
      assert(error instanceof AdminAuthError, `Expected an AdminAuthError, got ${String(error)}`);
      assert.equal(error.type, type);
    }
  };

  const countOf = async (table: string): Promise<number> => {
    const result = await service.from(table).select('id', { count: 'exact', head: true });
    assert.ifError(result.error);
    return result.count ?? 0;
  };

  const workflowBaseline = async () => ({
    projects: await countOf('projects'),
    media: await countOf('media_assets'),
    approvals: await countOf('approval_records'),
    publications: await countOf('publication_attempts'),
    snapshots: await countOf('published_snapshots'),
    removals: await countOf('public_removal_attempts'),
    statuses: psql('SELECT status, count(*) FROM public.projects GROUP BY status ORDER BY status;'),
  });

  const storageBaseline = async () => {
    const buckets = ['project-public-assets', 'public-feeds'];
    const listing: string[] = [];
    for (const bucket of buckets) {
      const result = await service.storage.from(bucket).list('', { limit: 1000 });
      listing.push(`${bucket}:${JSON.stringify((result.data ?? []).map((entry) => entry.name).sort())}`);
    }
    return listing.join('|');
  };

  const provisioningBaselineCount = Number(
    psql('SELECT count(*) FROM public.staff_provisioning_requests;'),
  );
  const authBaselineCount = Number(psql('SELECT count(*) FROM auth.users;'));
  const adminBaselineCount = await countOf('admin_users');
  const beforeWorkflow = await workflowBaseline();
  const beforeStorage = await storageBaseline();

  try {
    const admin = (await signIn('local-admin')).context;
    const reviewer = (await signIn('local-reviewer')).context;
    const editor = (await signIn('local-editor')).context;

    await scenario(1, 'existing initial Admin authenticates and holds staff.manage', () => {
      assert(canManageStaff(admin.permissions));
      assert.deepEqual(admin.permissions, getPermissionsForRoles(['admin']));
    });
    await scenario(2, 'Reviewer lacks staff.manage', () => {
      assert(!canManageStaff(reviewer.permissions));
    });
    await scenario(3, 'Editor lacks staff.manage', () => {
      assert(!canManageStaff(editor.permissions));
    });

    const addReviewer = await service.from('user_roles').insert({ user_id: editor.adminUserId, role: 'reviewer' });
    assert.ifError(addReviewer.error);
    editorReviewerAdded = true;
    const combined = await resolveAdminContextFromAuthUser(editor.authUserId, service);
    await scenario(4, 'Editor+Reviewer still lacks staff.manage', () => {
      assert.deepEqual(combined.roles, ['reviewer', 'editor']);
      assert(!canManageStaff(combined.permissions));
    });
    const removeReviewer = await service
      .from('user_roles')
      .delete()
      .eq('user_id', editor.adminUserId)
      .eq('role', 'reviewer');
    assert.ifError(removeReviewer.error);
    editorReviewerAdded = false;

    // ---- Primary happy path -------------------------------------------------------------
    const reviewerEmail = targetEmail('reviewer');
    const reviewerPassword = `Local_${crypto.randomBytes(18).toString('hex')}!`;
    const logs: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    let created;
    try {
      created = await provision(admin, {
        fullName: '  Synthetic Provisioned Reviewer  ',
        email: `  ${reviewerEmail.toUpperCase()}  `,
        roles: ['reviewer'],
      });
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    await track(reviewerEmail);

    await scenario(5, 'Admin creates a valid Reviewer invitation', () => {
      assert.equal(created.code, 'INVITATION_PENDING');
    });

    const reviewerRequest = await requestFor(reviewerEmail);
    assert(reviewerRequest, 'Reviewer provisioning record is missing.');
    await scenario(6, 'normalized email, name and roles persist consistently everywhere', async () => {
      assert.equal(reviewerRequest.normalized_email, reviewerEmail);
      assert.equal(reviewerRequest.full_name, 'Synthetic Provisioned Reviewer');
      assert.deepEqual(reviewerRequest.requested_roles, ['reviewer']);
      assert.equal(reviewerRequest.status, 'pending_activation');
      assert.equal(reviewerRequest.requested_by_admin_id, admin.adminUserId);
      assert.equal(created.invitation?.email, reviewerEmail);
      assert.equal(created.invitation?.fullName, 'Synthetic Provisioned Reviewer');
      const profiles = await profileFor(reviewerEmail);
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].full_name, 'Synthetic Provisioned Reviewer');
    });

    const messages = await mailbox(reviewerEmail);
    await scenario(7, 'the Local email sink receives exactly the intended invitation', () => {
      assert.equal(messages.length, 1, 'Expected exactly one Local invitation message.');
      assert(messages[0].subject.toLowerCase().includes('account setup'));
    });

    const inviteBody = await mailBody(reviewerEmail, messages[0].id);
    const inviteToken = tokenHashFrom(inviteBody);
    await scenario(8, 'no invitation secret reaches application logs or database evidence', async () => {
      const evidence = JSON.stringify(await requestsFor(reviewerEmail));
      assert(!evidence.includes(inviteToken), 'Invitation token was persisted as evidence.');
      for (const forbidden of ['token', 'password', 'access_token', 'refresh_token']) {
        assert(!evidence.toLowerCase().includes(`"${forbidden}"`), `Evidence exposed ${forbidden}.`);
      }
      for (const line of logs) {
        assert(!line.includes(inviteToken), 'Invitation token was written to logs.');
        assert(!line.includes(reviewerPassword), 'A password was written to logs.');
      }
    });

    await scenario(9, 'a pending identity is denied Admin/CMS authority before activation', async () => {
      assert(reviewerRequest.auth_user_id);
      await expectAuthError(reviewerRequest.auth_user_id, 'STAFF_ACTIVATION_PENDING');
    });

    const activated = await activate(reviewerEmail, reviewerPassword);
    await scenario(10, 'the invited identity completes activation successfully', async () => {
      assert.equal(activated.activation, 'ACTIVATED');
      assert.equal((await requestFor(reviewerEmail))?.status, 'activated');
    });

    await scenario(11, 'the activated Reviewer can sign in through the ordinary login flow', async () => {
      const login = await anonClient().auth.signInWithPassword({
        email: reviewerEmail,
        password: reviewerPassword,
      });
      assert.ifError(login.error);
      assert(login.data.session, 'Activated staff did not receive a session.');
    });

    await scenario(12, 'the activated Reviewer receives exactly the Reviewer permission set', async () => {
      const resolved = await resolveAdminContextFromAuthUser(activated.authUserId, service);
      assert.deepEqual(resolved.roles, ['reviewer']);
      assert.deepEqual(resolved.permissions, getPermissionsForRoles(['reviewer']));
      assert(!canManageStaff(resolved.permissions));
    });

    await scenario(13, 'the newly provisioned Reviewer cannot provision anyone else', async () => {
      const resolved = await resolveAdminContextFromAuthUser(activated.authUserId, service);
      const denied = await provision(resolved, {
        fullName: 'Escalation Attempt',
        email: targetEmail('escalation'),
        roles: ['admin'],
      });
      assert.equal(denied.code, 'PERMISSION_DENIED');
      assert.equal((await requestsFor(targetEmail('escalation'))).length, 0);
      assert.equal((await authUsersFor(targetEmail('escalation'))).length, 0);
    });

    // ---- Other supported target roles --------------------------------------------------
    const editorEmail = targetEmail('editor');
    const editorOutcome = await provision(admin, {
      fullName: 'Synthetic Provisioned Editor',
      email: editorEmail,
      roles: ['editor'],
    });
    await track(editorEmail);
    await scenario(14, 'Admin can provision an Editor', async () => {
      assert.equal(editorOutcome.code, 'INVITATION_PENDING');
      const profiles = await profileFor(editorEmail);
      assert.deepEqual(await rolesFor(profiles[0].id), ['editor']);
    });

    const adminEmail = targetEmail('admin');
    const adminOutcome = await provision(admin, {
      fullName: 'Synthetic Provisioned Admin',
      email: adminEmail,
      roles: ['admin'],
    });
    await track(adminEmail);
    await scenario(15, 'Admin can provision another Admin', async () => {
      assert.equal(adminOutcome.code, 'INVITATION_PENDING');
      const profiles = await profileFor(adminEmail);
      assert.deepEqual(await rolesFor(profiles[0].id), ['admin']);
    });

    const multiEmail = targetEmail('multirole');
    const multiPassword = `Local_${crypto.randomBytes(18).toString('hex')}!`;
    const multiOutcome = await provision(admin, {
      fullName: 'Synthetic Multi Role',
      email: multiEmail,
      roles: ['editor', 'reviewer', 'editor'],
    });
    await track(multiEmail);
    await scenario(16, 'multi-role staff receive the exact deterministic permission union', async () => {
      assert.equal(multiOutcome.code, 'INVITATION_PENDING');
      assert.deepEqual((await requestFor(multiEmail))?.requested_roles, ['reviewer', 'editor']);
      const multiActivated = await activate(multiEmail, multiPassword);
      assert.equal(multiActivated.activation, 'ACTIVATED');
      const resolved = await resolveAdminContextFromAuthUser(multiActivated.authUserId, service);
      assert.deepEqual(resolved.roles, ['reviewer', 'editor']);
      assert.deepEqual(resolved.permissions, ['projects.read', 'projects.review', 'projects.edit']);
      assert(!canManageStaff(resolved.permissions));
    });

    // ---- Idempotency and convergence ---------------------------------------------------
    await scenario(17, 'a duplicate sequential invitation converges without duplicate state', async () => {
      const repeat = await provision(admin, {
        fullName: 'Synthetic Provisioned Editor',
        email: editorEmail,
        roles: ['editor'],
      });
      assert.equal(repeat.code, 'ALREADY_INVITED');
      assert.equal((await authUsersFor(editorEmail)).length, 1);
      assert.equal((await profileFor(editorEmail)).length, 1);
      assert.equal((await requestsFor(editorEmail)).length, 1);
    });

    await scenario(18, 'an already provisioned target converges without duplicate state', async () => {
      const repeat = await provision(admin, {
        fullName: 'Synthetic Provisioned Reviewer',
        email: reviewerEmail,
        roles: ['reviewer'],
      });
      assert.equal(repeat.code, 'ALREADY_PROVISIONED');
      assert.equal((await authUsersFor(reviewerEmail)).length, 1);
      assert.equal((await profileFor(reviewerEmail)).length, 1);
      const profiles = await profileFor(reviewerEmail);
      assert.deepEqual(await rolesFor(profiles[0].id), ['reviewer']);
    });

    await scenario(19, 'ten concurrent identical races each converge to one authoritative identity', async () => {
      for (let iteration = 1; iteration <= 10; iteration += 1) {
        const concurrentEmail = targetEmail(`concurrent-${iteration}`);
        const outcomes = await Promise.all([
          provision(admin, { fullName: 'Synthetic Concurrent', email: concurrentEmail, roles: ['reviewer'] }),
          provision(admin, { fullName: 'Synthetic Concurrent', email: concurrentEmail, roles: ['reviewer'] }),
        ]);
        await track(concurrentEmail);
        const codes = outcomes.map((entry) => entry.code).sort();
        assert.equal(codes.filter((code) => code === 'INVITATION_PENDING').length, 1);
        assert.equal(codes.filter((code) => code === 'IN_PROGRESS').length, 1);
        assert.equal((await authUsersFor(concurrentEmail)).length, 1);
        assert.equal((await profileFor(concurrentEmail)).length, 1);
        assert.equal((await requestsFor(concurrentEmail)).length, 1);
        const profiles = await profileFor(concurrentEmail);
        assert.deepEqual(await rolesFor(profiles[0].id), ['reviewer']);
        assert.equal((await mailbox(concurrentEmail)).length, 1);
        assert.equal((await requestFor(concurrentEmail))?.status, 'pending_activation');
      }
    });

    await scenario(20, 'ten case/whitespace-equivalent races each converge to one lifecycle', async () => {
      for (let iteration = 1; iteration <= 10; iteration += 1) {
        const raceEmail = targetEmail(`race-${iteration}`);
        const outcomes = await Promise.all([
          provision(admin, { fullName: 'Synthetic Race', email: `  ${raceEmail.toUpperCase()} `, roles: ['editor'] }),
          provision(admin, { fullName: 'Synthetic Race', email: raceEmail, roles: ['editor'] }),
        ]);
        await track(raceEmail);
        const codes = outcomes.map((entry) => entry.code).sort();
        assert.equal(codes.filter((code) => code === 'INVITATION_PENDING').length, 1);
        assert.equal(codes.filter((code) => code === 'IN_PROGRESS').length, 1);
        assert.equal((await authUsersFor(raceEmail)).length, 1);
        assert.equal((await profileFor(raceEmail)).length, 1);
        assert.equal((await requestsFor(raceEmail)).length, 1);
        const profiles = await profileFor(raceEmail);
        assert.deepEqual(await rolesFor(profiles[0].id), ['editor']);
        assert.equal((await mailbox(raceEmail)).length, 1);
        assert.equal((await requestFor(raceEmail))?.status, 'pending_activation');
      }
    });

    // ---- Validation --------------------------------------------------------------------
    const rejections: Array<[number, string, unknown]> = [
      [21, 'a malformed email is rejected before any side effect', { fullName: 'A', email: 'not-an-email', roles: ['reviewer'] }],
      [22, 'a blank name is rejected before any side effect', { fullName: '   ', email: targetEmail('blank'), roles: ['reviewer'] }],
      [23, 'an empty role set is rejected before any side effect', { fullName: 'A', email: targetEmail('noroles'), roles: [] }],
      [24, 'an unknown role is rejected before any side effect', { fullName: 'A', email: targetEmail('unknownrole'), roles: ['superuser'] }],
    ];
    for (const [number, name, input] of rejections) {
      await scenario(number, name, async () => {
        const before = Number(psql('SELECT count(*) FROM public.staff_provisioning_requests;'));
        const beforeAuth = Number(psql('SELECT count(*) FROM auth.users;'));
        const outcome = await provision(admin, input);
        assert.equal(outcome.code, 'VALIDATION_FAILED');
        assert.equal(Number(psql('SELECT count(*) FROM public.staff_provisioning_requests;')), before);
        assert.equal(Number(psql('SELECT count(*) FROM auth.users;')), beforeAuth);
      });
    }

    await scenario(25, 'browser-supplied actor, authority and status fields cannot change authority', async () => {
      const spoofEmail = targetEmail('spoof');
      const outcome = await provision(reviewer, {
        fullName: 'Spoofed Request',
        email: spoofEmail,
        roles: ['admin'],
        actorAdminUserId: admin.adminUserId,
        authUserId: admin.authUserId,
        permissions: ['staff.manage'],
        status: 'activated',
        requestId: crypto.randomUUID(),
      });
      assert.equal(outcome.code, 'PERMISSION_DENIED');
      assert.equal((await requestsFor(spoofEmail)).length, 0);
      assert.equal((await authUsersFor(spoofEmail)).length, 0);
    });

    await scenario(26, 'a wrong authenticated identity cannot activate another provisioning record', async () => {
      const pending = await requestFor(adminEmail);
      assert.equal(pending?.status, 'pending_activation');
      assert.equal(await completeStaffActivation(service, admin.authUserId), 'ACTIVATION_MISMATCH');
      assert.equal(await completeStaffActivation(service, activated.authUserId), 'ALREADY_ACTIVATED');
      assert.equal((await requestFor(adminEmail))?.status, 'pending_activation');
    });

    // ---- Privilege boundaries -----------------------------------------------------------
    const privilegedCalls: Array<[string, Record<string, unknown>]> = [
      ['reserve_staff_provisioning', { p_actor_admin_id: admin.adminUserId, p_email: targetEmail('rpc'), p_full_name: 'X', p_roles: ['admin'] }],
      ['recover_staff_provisioning_identity', { p_request_id: crypto.randomUUID(), p_execution_token: crypto.randomUUID() }],
      ['bind_staff_provisioning_identity', { p_request_id: crypto.randomUUID(), p_execution_token: crypto.randomUUID(), p_auth_user_id: crypto.randomUUID() }],
      ['finalize_staff_provisioning', { p_request_id: crypto.randomUUID(), p_execution_token: crypto.randomUUID() }],
      ['begin_staff_provisioning_compensation', { p_request_id: crypto.randomUUID(), p_execution_token: crypto.randomUUID(), p_auth_user_id: crypto.randomUUID() }],
      ['activate_staff_provisioning', { p_auth_user_id: crypto.randomUUID() }],
      ['fail_staff_provisioning', { p_request_id: crypto.randomUUID(), p_execution_token: crypto.randomUUID(), p_failure_code: 'X', p_compensation_state: 'not_required' }],
    ];

    await scenario(27, 'anon cannot execute any privileged provisioning function', async () => {
      const client = anonClient();
      for (const [fn, args] of privilegedCalls) {
        const result = await client.rpc(fn, args);
        assert(result.error, `anon executed ${fn}.`);
      }
      const read = await client.from('staff_provisioning_requests').select('id').limit(1);
      assert(read.error || (read.data ?? []).length === 0, 'anon read provisioning evidence.');
    });

    await scenario(28, 'authenticated non-service clients cannot execute privileged provisioning functions', async () => {
      for (const label of ['local-admin', 'local-reviewer', 'local-editor'] as StaffLabel[]) {
        const definition = SYNTHETIC_STAFF_DEFINITIONS.find((entry) => entry.label === label)!;
        const client = anonClient();
        const login = await client.auth.signInWithPassword({
          email: definition.email,
          password: credentials[definition.email],
        });
        assert.ifError(login.error);
        for (const [fn, args] of privilegedCalls) {
          const result = await client.rpc(fn, args);
          assert(result.error, `${label} executed ${fn} directly.`);
        }
        const write = await client.from('staff_provisioning_requests').insert({
          normalized_email: targetEmail('direct'),
          full_name: 'Direct',
          requested_roles: ['admin'],
        });
        assert(write.error, `${label} wrote provisioning state directly.`);
        await client.auth.signOut();
      }
    });

    await scenario(29, 'the service_role path succeeds only with an authoritative admin actor', async () => {
      const denied = await service.rpc('reserve_staff_provisioning', {
        p_actor_admin_id: reviewer.adminUserId,
        p_email: targetEmail('serviceactor'),
        p_full_name: 'Service Actor',
        p_roles: ['reviewer'],
      });
      assert.ifError(denied.error);
      assert.equal(denied.data.resultCode, 'PERMISSION_DENIED');

      const unknownActor = await service.rpc('reserve_staff_provisioning', {
        p_actor_admin_id: crypto.randomUUID(),
        p_email: targetEmail('unknownactor'),
        p_full_name: 'Unknown Actor',
        p_roles: ['reviewer'],
      });
      assert.ifError(unknownActor.error);
      assert.equal(unknownActor.data.resultCode, 'PERMISSION_DENIED');
      assert.equal((await requestsFor(targetEmail('serviceactor'))).length, 0);
    });

    // ---- Compensation -------------------------------------------------------------------
    const compensationEmail = targetEmail('compensate');
    psql(`CREATE OR REPLACE FUNCTION public.staffprov_force_failure() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW.email = '${compensationEmail}' OR NEW.email = '${targetEmail('nocompensate')}' THEN RAISE EXCEPTION 'FORCED_LOCAL_FAILURE'; END IF; RETURN NEW; END; $fn$;`);
    psql('CREATE TRIGGER staffprov_force_failure_trigger BEFORE INSERT ON public.admin_users FOR EACH ROW EXECUTE FUNCTION public.staffprov_force_failure();');
    failureTriggerInstalled = true;

    const compensated = await provision(admin, {
      fullName: 'Synthetic Compensation',
      email: compensationEmail,
      roles: ['reviewer'],
    });
    await scenario(30, 'a forced database failure after Auth creation performs safe compensation', async () => {
      assert.equal(compensated.code, 'PROVISIONING_FAILED');
      const row = await requestFor(compensationEmail);
      assert.equal(row?.status, 'failed');
      assert.equal(row?.failure_code, 'FINALIZE_FAILED');
      assert.equal(
        (await authUsersFor(compensationEmail)).length,
        0,
        'Compensation left an orphaned Auth identity behind.',
      );
      assert.equal((await profileFor(compensationEmail)).length, 0);
    });

    const noCompensationEmail = targetEmail('nocompensate');
    const refusingInvitations: StaffInvitationGateway = {
      invite: (input) => new SupabaseStaffInvitationGateway(service).invite(input),
      deleteAuthIdentity: async () => false,
    };
    const compensationFailed = await provision(
      admin,
      { fullName: 'Synthetic Compensation Failure', email: noCompensationEmail, roles: ['reviewer'] },
      { invitations: refusingInvitations },
    );
    await track(noCompensationEmail);
    await scenario(31, 'a forced compensation failure is recorded and fails closed', async () => {
      assert.equal(compensationFailed.code, 'COMPENSATION_FAILED');
      const row = await requestFor(noCompensationEmail);
      assert.equal(row?.status, 'compensation_failed');
      assert.equal(row?.failure_code, 'FINALIZE_FAILED');
      assert.equal((await profileFor(noCompensationEmail)).length, 0, 'A failed attempt produced staff authority.');
      const orphan = await authUsersFor(noCompensationEmail);
      assert.equal(orphan.length, 1, 'The refused compensation should have left the identity for follow-up.');
      await expectAuthError(orphan[0], 'ADMIN_NOT_PROVISIONED');
    });

    psql('DROP TRIGGER IF EXISTS staffprov_force_failure_trigger ON public.admin_users;');
    psql('DROP FUNCTION IF EXISTS public.staffprov_force_failure();');
    failureTriggerInstalled = false;

    const recoveryEmail = targetEmail('recovery');
    const reserved = await service.rpc('reserve_staff_provisioning', {
      p_actor_admin_id: admin.adminUserId,
      p_email: recoveryEmail,
      p_full_name: 'Synthetic Recovery',
      p_roles: ['editor'],
    });
    assert.ifError(reserved.error);
    assert.equal(reserved.data.resultCode, 'RESERVED');
    psql(`UPDATE public.staff_provisioning_requests SET lease_expires_at = pg_catalog.now() - interval '1 second' WHERE id = '${reserved.data.requestId}';`);
    const recovered = await provision(admin, {
      fullName: 'Synthetic Recovery',
      email: recoveryEmail,
      roles: ['editor'],
    });
    await track(recoveryEmail);
    await scenario(32, 'a retry from a recoverable partial state converges without duplicates', async () => {
      assert.equal(recovered.code, 'INVITATION_PENDING');
      assert.equal((await requestsFor(recoveryEmail)).length, 1);
      assert.equal((await authUsersFor(recoveryEmail)).length, 1);
      assert.equal((await profileFor(recoveryEmail)).length, 1);
      const profiles = await profileFor(recoveryEmail);
      assert.deepEqual(await rolesFor(profiles[0].id), ['editor']);
    });

    const staleEmail = targetEmail('stale-owner');
    const staleReservation = await service.rpc('reserve_staff_provisioning', {
      p_actor_admin_id: admin.adminUserId,
      p_email: staleEmail,
      p_full_name: 'Synthetic Stale Owner',
      p_roles: ['reviewer'],
    });
    assert.ifError(staleReservation.error);
    psql(`UPDATE public.staff_provisioning_requests SET lease_expires_at = pg_catalog.now() - interval '1 second' WHERE id = '${staleReservation.data.requestId}';`);
    const replacement = await service.rpc('reserve_staff_provisioning', {
      p_actor_admin_id: admin.adminUserId,
      p_email: staleEmail,
      p_full_name: 'Synthetic Stale Owner',
      p_roles: ['reviewer'],
    });
    assert.ifError(replacement.error);
    await scenario(33, 'expired lease recovery rotates ownership and fences every stale mutation', async () => {
      assert.equal(replacement.data.resultCode, 'RECOVERED');
      assert.notEqual(replacement.data.executionToken, staleReservation.data.executionToken);
      for (const [fn, args] of [
        ['recover_staff_provisioning_identity', { p_request_id: staleReservation.data.requestId, p_execution_token: staleReservation.data.executionToken }],
        ['bind_staff_provisioning_identity', { p_request_id: staleReservation.data.requestId, p_execution_token: staleReservation.data.executionToken, p_auth_user_id: crypto.randomUUID() }],
        ['finalize_staff_provisioning', { p_request_id: staleReservation.data.requestId, p_execution_token: staleReservation.data.executionToken }],
        ['begin_staff_provisioning_compensation', { p_request_id: staleReservation.data.requestId, p_execution_token: staleReservation.data.executionToken, p_auth_user_id: crypto.randomUUID() }],
        ['fail_staff_provisioning', { p_request_id: staleReservation.data.requestId, p_execution_token: staleReservation.data.executionToken, p_failure_code: 'STALE', p_compensation_state: 'not_required' }],
      ] as const) {
        const response = await service.rpc(fn, args);
        assert.ifError(response.error);
        assert.equal(response.data.resultCode, 'EXECUTION_TOKEN_MISMATCH');
      }
      assert.equal((await requestFor(staleEmail))?.status, 'reserved');
    });

    const unrelatedEmail = targetEmail('unrelated-after-reserve');
    const unrelatedReservation = await service.rpc('reserve_staff_provisioning', {
      p_actor_admin_id: admin.adminUserId,
      p_email: unrelatedEmail,
      p_full_name: 'Synthetic Unrelated',
      p_roles: ['reviewer'],
    });
    assert.ifError(unrelatedReservation.error);
    const unrelated = await service.auth.admin.createUser({ email: unrelatedEmail, email_confirm: true });
    assert.ifError(unrelated.error);
    assert(unrelated.data.user);
    createdAuthIds.add(unrelated.data.user.id);
    psql(`UPDATE public.staff_provisioning_requests SET lease_expires_at = pg_catalog.now() - interval '1 second' WHERE id = '${unrelatedReservation.data.requestId}';`);
    const unrelatedOutcome = await provision(admin, {
      fullName: 'Synthetic Unrelated', email: unrelatedEmail, roles: ['reviewer'],
    });
    await scenario(34, 'an unrelated Auth identity created after reservation is never claimed or deleted', async () => {
      assert.equal(unrelatedOutcome.code, 'INVITATION_FAILED');
      assert.deepEqual(await authUsersFor(unrelatedEmail), [unrelated.data.user.id]);
      const row = await requestFor(unrelatedEmail);
      assert.equal(row?.auth_user_id, null);
      assert.equal(row?.auth_identity_owned, false);
      assert.equal(row?.status, 'failed');
      assert.equal((await profileFor(unrelatedEmail)).length, 0);
    });

    await scenario(35, 'provisioning fails closed when it is not explicitly enabled', async () => {
      const disabledEmail = targetEmail('disabled');
      const before = Number(psql('SELECT count(*) FROM public.staff_provisioning_requests;'));
      const outcome = await provision(
        admin,
        { fullName: 'Synthetic Disabled', email: disabledEmail, roles: ['reviewer'] },
        { enabled: false },
      );
      assert.equal(outcome.code, 'PROVISIONING_DISABLED');
      assert.equal((await requestsFor(disabledEmail)).length, 0);
      assert.equal((await authUsersFor(disabledEmail)).length, 0);
      assert.equal(Number(psql('SELECT count(*) FROM public.staff_provisioning_requests;')), before);
    });

    await scenario(36, 'activation is never blocked by the creation enablement flag', async () => {
      const pending = await requestFor(editorEmail);
      assert.equal(pending?.status, 'pending_activation');
      const editorPassword = `Local_${crypto.randomBytes(18).toString('hex')}!`;
      const result = await activate(editorEmail, editorPassword);
      assert.equal(result.activation, 'ACTIVATED');
      const resolved = await resolveAdminContextFromAuthUser(result.authUserId, service);
      assert.deepEqual(resolved.permissions, getPermissionsForRoles(['editor']));
    });

    // ---- Bootstrap regression -----------------------------------------------------------
    await scenario(37, 'bootstrap_initial_admin cannot provision an arbitrary additional staff member', async () => {
      const outsiderEmail = targetEmail('bootstrap');
      const outsiderPassword = `Local_${crypto.randomBytes(18).toString('hex')}!`;
      const outsider = await service.auth.admin.createUser({
        email: outsiderEmail,
        password: outsiderPassword,
        email_confirm: true,
      });
      assert.ifError(outsider.error);
      assert(outsider.data.user);
      createdAuthIds.add(outsider.data.user.id);

      const attempt = await service.rpc('bootstrap_initial_admin', {
        p_auth_user_id: outsider.data.user.id,
        p_email: outsiderEmail,
        p_full_name: 'Bootstrap Escalation Attempt',
      });
      assert(attempt.error, 'bootstrap_initial_admin provisioned an arbitrary additional staff member.');
      assert.equal((await profileFor(outsiderEmail)).length, 0);
      await expectAuthError(outsider.data.user.id, 'ADMIN_NOT_PROVISIONED');

      for (const client of [anonClient()]) {
        const denied = await client.rpc('bootstrap_initial_admin', {
          p_auth_user_id: outsider.data.user.id,
          p_email: outsiderEmail,
          p_full_name: 'Bootstrap Escalation Attempt',
        });
        assert(denied.error, 'bootstrap_initial_admin is reachable from the browser.');
      }
    });

    // ---- Inherited governance ------------------------------------------------------------
    await scenario(38, 'existing Admin, Reviewer and Editor governance behaviour is unchanged', async () => {
      assert.deepEqual(
        (await resolveAdminContextFromAuthUser(admin.authUserId, service)).permissions,
        getPermissionsForRoles(['admin']),
      );
      assert.deepEqual(
        (await resolveAdminContextFromAuthUser(reviewer.authUserId, service)).permissions,
        getPermissionsForRoles(['reviewer']),
      );
      assert.deepEqual(
        (await resolveAdminContextFromAuthUser(editor.authUserId, service)).permissions,
        getPermissionsForRoles(['editor']),
      );
      const rejected = await service.from('user_roles').insert({ user_id: editor.adminUserId, role: 'unknown' });
      assert(rejected.error, 'Database accepted an unknown staff role.');
    });

    const crashBeforeDeleteEmail = targetEmail('crash-before-delete');
    const crashBeforeDelete = await service.rpc('reserve_staff_provisioning', {
      p_actor_admin_id: admin.adminUserId, p_email: crashBeforeDeleteEmail,
      p_full_name: 'Synthetic Crash Before Delete', p_roles: ['reviewer'],
    });
    assert.ifError(crashBeforeDelete.error);
    const crashBeforeDeleteAuthId = await new SupabaseStaffInvitationGateway(service).invite({
      email: crashBeforeDeleteEmail, fullName: 'Synthetic Crash Before Delete',
      requestId: crashBeforeDelete.data.requestId, authOwnershipToken: crashBeforeDelete.data.authOwnershipToken,
    });
    assert(crashBeforeDeleteAuthId);
    createdAuthIds.add(crashBeforeDeleteAuthId);
    assert.equal((await service.rpc('bind_staff_provisioning_identity', { p_request_id: crashBeforeDelete.data.requestId, p_execution_token: crashBeforeDelete.data.executionToken, p_auth_user_id: crashBeforeDeleteAuthId })).data.resultCode, 'BOUND');
    assert.equal((await service.rpc('begin_staff_provisioning_compensation', { p_request_id: crashBeforeDelete.data.requestId, p_execution_token: crashBeforeDelete.data.executionToken, p_auth_user_id: crashBeforeDeleteAuthId })).data.resultCode, 'COMPENSATION_AUTHORIZED');
    const beforeDeleteMailCount = (await mailbox(crashBeforeDeleteEmail)).length;
    psql(`UPDATE public.staff_provisioning_requests SET lease_expires_at = pg_catalog.now() - interval '1 second' WHERE id = '${crashBeforeDelete.data.requestId}';`);
    const crashBeforeDeleteRecovery = await provision(admin, { fullName: 'Synthetic Crash Before Delete', email: crashBeforeDeleteEmail, roles: ['reviewer'] });
    await track(crashBeforeDeleteEmail);
    await scenario(39, 'expired compensation before delete recovers exactly the marked identity without a second invitation', async () => {
      assert.equal(crashBeforeDeleteRecovery.code, 'PROVISIONING_FAILED');
      assert.equal((await requestFor(crashBeforeDeleteEmail))?.status, 'failed');
      assert.equal((await authUsersFor(crashBeforeDeleteEmail)).length, 0);
      assert.equal((await profileFor(crashBeforeDeleteEmail)).length, 0);
      assert.equal((await requestsFor(crashBeforeDeleteEmail)).length, 1);
      assert.equal((await mailbox(crashBeforeDeleteEmail)).length, beforeDeleteMailCount);
      assert.equal((await service.rpc('begin_staff_provisioning_compensation', { p_request_id: crashBeforeDelete.data.requestId, p_execution_token: crashBeforeDelete.data.executionToken, p_auth_user_id: crashBeforeDeleteAuthId })).data.resultCode, 'EXECUTION_TOKEN_MISMATCH');
    });

    const crashAfterDeleteEmail = targetEmail('crash-after-delete');
    const crashAfterDelete = await service.rpc('reserve_staff_provisioning', {
      p_actor_admin_id: admin.adminUserId, p_email: crashAfterDeleteEmail,
      p_full_name: 'Synthetic Crash After Delete', p_roles: ['reviewer'],
    });
    assert.ifError(crashAfterDelete.error);
    const crashAfterDeleteAuthId = await new SupabaseStaffInvitationGateway(service).invite({
      email: crashAfterDeleteEmail, fullName: 'Synthetic Crash After Delete',
      requestId: crashAfterDelete.data.requestId, authOwnershipToken: crashAfterDelete.data.authOwnershipToken,
    });
    assert(crashAfterDeleteAuthId);
    assert.equal((await service.rpc('bind_staff_provisioning_identity', { p_request_id: crashAfterDelete.data.requestId, p_execution_token: crashAfterDelete.data.executionToken, p_auth_user_id: crashAfterDeleteAuthId })).data.resultCode, 'BOUND');
    assert.equal((await service.rpc('begin_staff_provisioning_compensation', { p_request_id: crashAfterDelete.data.requestId, p_execution_token: crashAfterDelete.data.executionToken, p_auth_user_id: crashAfterDeleteAuthId })).data.resultCode, 'COMPENSATION_AUTHORIZED');
    assert(await new SupabaseStaffInvitationGateway(service).deleteAuthIdentity(crashAfterDeleteAuthId));
    const afterDeleteMailCount = (await mailbox(crashAfterDeleteEmail)).length;
    psql(`UPDATE public.staff_provisioning_requests SET lease_expires_at = pg_catalog.now() - interval '1 second' WHERE id = '${crashAfterDelete.data.requestId}';`);
    const crashAfterDeleteRecovery = await provision(admin, { fullName: 'Synthetic Crash After Delete', email: crashAfterDeleteEmail, roles: ['reviewer'] });
    await scenario(40, 'expired compensation after a lost delete response records completed cleanup without reinviting', async () => {
      assert.equal(crashAfterDeleteRecovery.code, 'PROVISIONING_FAILED');
      assert.equal((await requestFor(crashAfterDeleteEmail))?.status, 'failed');
      assert.equal((await authUsersFor(crashAfterDeleteEmail)).length, 0);
      assert.equal((await profileFor(crashAfterDeleteEmail)).length, 0);
      assert.equal((await requestsFor(crashAfterDeleteEmail)).length, 1);
      assert.equal((await mailbox(crashAfterDeleteEmail)).length, afterDeleteMailCount);
    });

    await scenario(41, 'the bounded staff directory exposes no internal identifiers', async () => {
      const directory = await readStaffDirectory(service);
      const serialized = JSON.stringify(directory);
      assert(directory.staff.some((entry) => entry.email === reviewerEmail));
      assert(directory.staff.some((entry) => entry.status === 'pending_activation'));
      assert(directory.incidents.some((entry) => entry.status === 'compensation_failed'));
      assert(!serialized.includes(admin.authUserId), 'Directory exposed an Auth identity.');
      assert(!serialized.includes(admin.adminUserId), 'Directory exposed a staff profile identifier.');
      assert(!serialized.includes(inviteToken), 'Directory exposed an invitation secret.');
    });

    await scenario(42, 'no project workflow, media, publication or feed state changed', async () => {
      assert.deepEqual(await workflowBaseline(), beforeWorkflow);
    });

    await scenario(43, 'no public storage, feed or external provider operation occurred', async () => {
      assert.equal(await storageBaseline(), beforeStorage);
      assert(isLoopbackUrl(env.API_URL!), 'Verification targeted a non-loopback endpoint.');
      const source = fs.readFileSync(
        path.resolve(root, 'apps/admin-cms/src/staff/staffProvisioningRepository.ts'),
        'utf8',
      );
      for (const forbidden of ['duda', 'publish-cloud-feed', 'smtp', 'sendgrid', 'mailgun', 'fetch(']) {
        assert(!source.toLowerCase().includes(forbidden), `Provisioning reached an external boundary: ${forbidden}`);
      }
    });

    await scenario(44, 'cleanup and residue verification run in the finalizer', () => {
      // Executed in the finally block below.
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      if (failureTriggerInstalled) {
        psql('DROP TRIGGER IF EXISTS staffprov_force_failure_trigger ON public.admin_users;');
        psql('DROP FUNCTION IF EXISTS public.staffprov_force_failure();');
      }
      if (editorReviewerAdded && staff.has('local-editor')) {
        await service
          .from('user_roles')
          .delete()
          .eq('user_id', context('local-editor').adminUserId)
          .eq('role', 'reviewer');
      }

      // Every verifier-owned identity carries the run prefix, so cleanup can never reach a
      // pre-existing account.
      psql(`DELETE FROM public.staff_provisioning_requests WHERE normalized_email LIKE '${prefix}%';`);
      for (const id of createdAdminIds) {
        await service.from('admin_users').delete().eq('id', id);
      }
      psql(`DELETE FROM public.admin_users WHERE email LIKE '${prefix}%';`);
      const residualAuth = psql(
        `SELECT id FROM auth.users WHERE pg_catalog.lower(pg_catalog.btrim(email)) LIKE '${prefix}%';`,
      ).split(/\r?\n/).filter(Boolean);
      for (const id of residualAuth) createdAuthIds.add(id);
      for (const authId of createdAuthIds) {
        const deleted = await service.auth.admin.deleteUser(authId);
        if (deleted.error && !/not found/i.test(deleted.error.message)) {
          throw new Error(`Verifier-owned Auth identity could not be removed: ${deleted.error.message}`);
        }
      }

      // Remove only this run's own messages from the Local sink.
      if (mailMessageIds.size) {
        await fetch(`${MAIL_API}/messages`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ IDs: [...mailMessageIds] }),
        });
      }

      // Independent residue verification against the exact pre-verifier baseline.
      assert.equal(
        psql(`SELECT count(*) FROM public.staff_provisioning_requests WHERE normalized_email LIKE '${prefix}%';`),
        '0',
      );
      assert.equal(psql(`SELECT count(*) FROM public.admin_users WHERE email LIKE '${prefix}%';`), '0');
      assert.equal(psql(`SELECT count(*) FROM auth.users WHERE email LIKE '${prefix}%';`), '0');
      assert.equal(
        psql("SELECT count(*) FROM pg_catalog.pg_proc WHERE proname = 'staffprov_force_failure';"),
        '0',
      );
      assert.equal(
        psql("SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname = 'staffprov_force_failure_trigger';"),
        '0',
      );
      assert.equal(
        Number(psql('SELECT count(*) FROM public.staff_provisioning_requests;')),
        provisioningBaselineCount,
      );
      assert.equal(Number(psql('SELECT count(*) FROM auth.users;')), authBaselineCount);
      assert.equal(await countOf('admin_users'), adminBaselineCount);
      assert.deepEqual(await workflowBaseline(), beforeWorkflow);
      assert.equal(await storageBaseline(), beforeStorage);
      console.log('PASS: Scenario 43 - independent residue check confirms the exact pre-verifier baseline');
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  console.log('OVERALL STAFF IDENTITY PROVISIONING RUNTIME VERIFICATION RESULT: PASS');
}

main().catch((error) => {
  console.error('STAFF PROVISIONING VERIFIER FAILURE:', error instanceof Error ? error.message : String(error));
  console.error('OVERALL STAFF IDENTITY PROVISIONING RUNTIME VERIFICATION RESULT: FAIL');
  process.exit(1);
});
