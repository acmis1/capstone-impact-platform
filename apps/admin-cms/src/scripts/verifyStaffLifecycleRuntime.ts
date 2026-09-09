import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveAdminContextFromAuthUser } from '../auth/adminContext';
import { AdminAuthError } from '../auth/authTypes';
import { getPermissionsForRoles } from '../auth/permissions';
import { parseClaimsResult } from '../auth/claimsResult';
import { getCurrentPasswordRecoverySessionState } from '../auth/recoverySession';
import {
  dockerProxyCustomHeaders,
  startDockerLoopbackProxy,
  stopDockerLoopbackProxy,
} from '../local-development/safeSupabaseCli';
import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import {
  SupabaseStaffAccessProviderGateway,
  SupabaseStaffLifecycleDatabaseGateway,
} from '../staff/staffLifecycleRepository';
import { manageStaffLifecycle, type StaffAccessProviderGateway } from '../staff/staffLifecycleService';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const suffix = randomBytes(4).toString('hex');
const projectId = `capstone-staff-lifecycle-${suffix}`;
const networkName = `${projectId}-loopback`;
const portBase = Number.parseInt(process.env.CAPSTONE_STAFF_LIFECYCLE_PORT_BASE ?? '55320', 10);
const dockerTimeoutMs = 30_000;

assert(
  Number.isSafeInteger(portBase) && portBase >= 1024 && portBase <= 65_527,
  'CAPSTONE_STAFF_LIFECYCLE_PORT_BASE_INVALID',
);

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: dockerTimeoutMs,
  }).trim();
}

function configurePorts(config: string): string {
  const ports: Array<[RegExp, number]> = [
    [/^port = 54321$/m, portBase + 1],
    [/^port = 54322$/m, portBase + 2],
    [/^shadow_port = 54320$/m, portBase],
    [/^port = 54323$/m, portBase + 3],
    [/^port = 54324$/m, portBase + 4],
    [/^smtp_port = 54325$/m, portBase + 5],
    [/^pop3_port = 54326$/m, portBase + 6],
  ];
  let updated = config.replace(/^project_id = .*$/m, `project_id = "${projectId}"`);
  for (const [pattern, port] of ports) {
    const key = pattern.source.replace(/^\^/, '').split(' = ')[0];
    updated = updated.replace(pattern, `${key} = ${port}`);
  }
  return `${updated}\n[analytics]\nenabled = true\nport = ${portBase + 7}\n`;
}

function createWorkdir(): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-staff-lifecycle-'));
  const destination = path.join(workdir, 'supabase');
  fs.cpSync(path.join(repositoryRoot, 'infra', 'supabase'), destination, { recursive: true });
  const configPath = path.join(destination, 'config.toml');
  fs.writeFileSync(configPath, configurePorts(fs.readFileSync(configPath, 'utf8')), 'utf8');
  return workdir;
}

function supabaseCli(args: string[], workdir: string, networkId = '', capture = false): string {
  const proxy = startDockerLoopbackProxy(repositoryRoot);
  try {
    const output = execFileSync(process.execPath, [
      path.join(repositoryRoot, 'node_modules', 'supabase', 'dist', 'supabase.js'),
      ...args,
      '--workdir', workdir,
      ...(networkId ? ['--network-id', networkId] : []),
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'inherit'],
      timeout: args[0] === 'start' ? 900_000 : 300_000,
      env: {
        ...process.env,
        SUPABASE_TELEMETRY_DISABLED: '1',
        DOCKER_HOST: proxy.dockerHost,
        DOCKER_CUSTOM_HEADERS: dockerProxyCustomHeaders(
          process.env.DOCKER_CUSTOM_HEADERS,
          proxy.authorizationToken,
        ),
      },
    });
    return typeof output === 'string' ? output.trim() : '';
  } finally {
    stopDockerLoopbackProxy(proxy);
  }
}

function removeOwnedDockerResidue(): void {
  const containers = docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${projectId}`])
    .split(/\r?\n/).filter(Boolean);
  if (containers.length > 0) docker(['rm', '-f', ...containers]);
  const volumes = docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${projectId}`])
    .split(/\r?\n/).filter(Boolean);
  if (volumes.length > 0) docker(['volume', 'rm', ...volumes]);
  const networks = docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}'])
    .split(/\r?\n/).filter(Boolean);
  if (networks.includes(networkName)) docker(['network', 'rm', networkName]);
}

interface StaffFixture {
  adminId: string;
  authId: string;
  email: string;
  password: string;
}

async function runScenarios(workdir: string, networkId: string): Promise<void> {
  const environment = parseSupabaseCliEnv(
    supabaseCli(['status', '-o', 'env'], workdir, networkId, true),
  );
  assert(
    environment.API_URL
      && environment.ANON_KEY
      && environment.SERVICE_ROLE_KEY
      && isLoopbackUrl(environment.API_URL),
    'Runtime verifier requires isolated loopback Supabase.',
  );

  const service = createClient(environment.API_URL, environment.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const anon = (): SupabaseClient => createClient(environment.API_URL!, environment.ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const database = () => new SupabaseStaffLifecycleDatabaseGateway(service);
  const realProvider = new SupabaseStaffAccessProviderGateway(service);
  const successfulProvider: StaffAccessProviderGateway = {
    setAccessEnabled: async () => true,
  };
  const failedProvider: StaffAccessProviderGateway = {
    setAccessEnabled: async () => false,
  };
  const adminPermissions = getPermissionsForRoles(['admin']);
  const prefix = `staff-lifecycle-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const psql = (sql: string): string => docker([
    'exec', '-i', `supabase_db_${projectId}`,
    'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ]);
  const scenario = async (number: number, name: string, run: () => Promise<void> | void) => {
    await run();
    console.log(`PASS: Scenario ${number} - ${name}`);
  };
  const createStaff = async (label: string, roles: string[]): Promise<StaffFixture> => {
    const email = `${prefix}.${label}@capstone.test`;
    const password = `Local_${randomBytes(18).toString('hex')}!`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ifError(created.error);
    assert(created.data.user);
    const profile = await service.from('admin_users').insert({
      email,
      full_name: `Local ${label}`,
      auth_user_id: created.data.user.id,
    }).select('id').single();
    assert.ifError(profile.error);
    if (roles.length > 0) {
      assert.ifError((await service.from('user_roles').insert(
        roles.map((role) => ({ user_id: profile.data.id, role })),
      )).error);
    }
    return { adminId: String(profile.data.id), authId: created.data.user.id, email, password };
  };
  const lifecycle = (
    actor: StaffFixture,
    provider: StaffAccessProviderGateway,
    input: unknown,
  ) => manageStaffLifecycle({
    permissions: adminPermissions,
    actorAdminUserId: actor.adminId,
    database: database(),
    provider,
  }, input);

  const adminA = await createStaff('admin-a', ['admin']);
  const adminB = await createStaff('admin-b', ['admin']);
  const target = await createStaff('target', ['reviewer']);
  const failureTarget = await createStaff('provider-failure', ['editor']);
  const orphanProfile = await service.from('admin_users').insert({
    email: `${prefix}.orphan-admin@capstone.test`,
    full_name: 'Local orphan admin',
  }).select('id').single();
  assert.ifError(orphanProfile.error);
  assert.ifError((await service.from('user_roles').insert({
    user_id: orphanProfile.data.id,
    role: 'admin',
  })).error);

  await scenario(1, 'role replacement is atomic, canonical, and immediately authoritative', async () => {
    const outcome = await lifecycle(adminA, successfulProvider, {
      action: 'replace_roles', targetEmail: target.email, expectedVersion: 1,
      roles: ['editor', 'reviewer', 'editor'],
    });
    assert.equal(outcome.code, 'UPDATED');
    assert.deepEqual(outcome.staff?.roles, ['reviewer', 'editor']);
    const context = await resolveAdminContextFromAuthUser(target.authId, service);
    assert.deepEqual(context.roles, ['reviewer', 'editor']);
  });

  await scenario(2, 'unknown roles fail closed without changing the version or role set', async () => {
    const outcome = await database().apply({
      actorAdminUserId: adminA.adminId,
      action: 'replace_roles', targetEmail: target.email, expectedVersion: 2,
      roles: ['owner' as never],
    });
    assert.equal(outcome.resultCode, 'VALIDATION_FAILED');
    const profile = await service.from('admin_users').select('lifecycle_version').eq('id', target.adminId).single();
    assert.ifError(profile.error);
    assert.equal(Number(profile.data.lifecycle_version), 2);
  });

  await scenario(3, 'a repeated current role replacement completes idempotently without an audit transition', async () => {
    const before = await service.from('staff_lifecycle_events').select('id', { count: 'exact', head: true })
      .eq('target_admin_user_id', target.adminId);
    const outcome = await lifecycle(adminA, successfulProvider, {
      action: 'replace_roles', targetEmail: target.email, expectedVersion: 2,
      roles: ['reviewer', 'editor'],
    });
    const after = await service.from('staff_lifecycle_events').select('id', { count: 'exact', head: true })
      .eq('target_admin_user_id', target.adminId);
    assert.equal(outcome.code, 'NO_CHANGE');
    assert.equal(after.count, before.count);
  });

  await scenario(4, 'provider disable is attempted only after authoritative database deactivation', async () => {
    const outcome = await lifecycle(adminA, realProvider, {
      action: 'deactivate', targetEmail: target.email, expectedVersion: 2,
    });
    assert.equal(outcome.code, 'UPDATED');
    assert.equal(outcome.staff?.status, 'deactivated');
    await assert.rejects(
      () => resolveAdminContextFromAuthUser(target.authId, service),
      (error: unknown) => error instanceof AdminAuthError && error.type === 'STAFF_DEACTIVATED',
    );
  });

  await scenario(5, 'deactivation repeats and stale writes complete deterministically', async () => {
    const repeated = await lifecycle(adminA, realProvider, {
      action: 'deactivate', targetEmail: target.email, expectedVersion: 3,
    });
    const stale = await lifecycle(adminA, realProvider, {
      action: 'deactivate', targetEmail: target.email, expectedVersion: 2,
    });
    assert.equal(repeated.code, 'ALREADY_DEACTIVATED');
    assert.equal(stale.code, 'STALE_VERSION');
  });

  await scenario(6, 'reactivation is explicit, role-bounded, and restores provider sign-in', async () => {
    const invalid = await lifecycle(adminA, realProvider, {
      action: 'reactivate', targetEmail: target.email, expectedVersion: 3, roles: [],
    });
    assert.equal(invalid.code, 'VALIDATION_FAILED');
    const outcome = await lifecycle(adminA, realProvider, {
      action: 'reactivate', targetEmail: target.email, expectedVersion: 3, roles: ['reviewer'],
    });
    assert.equal(outcome.code, 'UPDATED');
    const login = await anon().auth.signInWithPassword({ email: target.email, password: target.password });
    assert.ifError(login.error);
    assert(login.data.session);
    const context = await resolveAdminContextFromAuthUser(target.authId, service);
    assert.deepEqual(context.roles, ['reviewer']);
  });

  const failureClient = anon();
  const failureLogin = await failureClient.auth.signInWithPassword({
    email: failureTarget.email,
    password: failureTarget.password,
  });
  assert.ifError(failureLogin.error);
  assert(failureLogin.data.session);
  const retainedAccessToken = failureLogin.data.session.access_token;
  const activePredicate = await failureClient.rpc('staff_session_is_active');
  assert.ifError(activePredicate.error);
  assert.equal(activePredicate.data, true);
  const catalogBeforeDeactivation = await failureClient.from('programs').select('id').limit(1);
  assert.ifError(catalogBeforeDeactivation.error);
  assert.equal(catalogBeforeDeactivation.data.length, 1);

  await scenario(7, 'provider failure never rolls back database/application deactivation', async () => {
    const outcome = await lifecycle(adminA, failedProvider, {
      action: 'deactivate', targetEmail: failureTarget.email, expectedVersion: 1,
    });
    assert.equal(outcome.code, 'UPDATED_PROVIDER_ATTENTION');
    assert.equal(outcome.staff?.status, 'deactivated');
    const claims = parseClaimsResult(await failureClient.auth.getClaims(retainedAccessToken));
    assert.equal(claims.userId, failureTarget.authId);
    assert.equal(await getCurrentPasswordRecoverySessionState(failureClient), 'NOT_REGISTERED');
    await assert.rejects(
      () => resolveAdminContextFromAuthUser(claims.userId, service),
      (error: unknown) => error instanceof AdminAuthError && error.type === 'STAFF_DEACTIVATED',
    );
    const inactivePredicate = await failureClient.rpc('staff_session_is_active');
    assert.ifError(inactivePredicate.error);
    assert.equal(inactivePredicate.data, false);
    for (const table of ['programs', 'disciplines', 'industry_categories']) {
      const directRead = await failureClient.from(table).select('id').limit(1);
      assert.ifError(directRead.error);
      assert.deepEqual(
        directRead.data,
        [],
        `Retained deactivated token still read public.${table} through the Data API.`,
      );
    }
    const providerStillAllowsLogin = await anon().auth.signInWithPassword({
      email: failureTarget.email,
      password: failureTarget.password,
    });
    assert.ifError(providerStillAllowsLogin.error);
    assert(providerStillAllowsLogin.data.session);
  });

  await scenario(8, 'expired claims retry and only the current reconciliation token can complete', async () => {
    const blocked = await lifecycle(adminA, realProvider, {
      action: 'reactivate', targetEmail: failureTarget.email, expectedVersion: 2, roles: ['editor'],
    });
    assert.equal(blocked.code, 'PROVIDER_RECONCILIATION_REQUIRED');
    const gateway = database();
    const firstClaim = await gateway.claimProviderReconciliation({
      actorAdminUserId: adminA.adminId,
      targetEmail: failureTarget.email,
      expectedVersion: 2,
    });
    assert.equal(firstClaim.resultCode, 'CLAIMED');
    assert(firstClaim.eventId && firstClaim.reconciliationToken && firstClaim.authUserId);
    assert.equal(await gateway.completeProviderReconciliation({
      eventId: firstClaim.eventId,
      reconciliationToken: randomUUID(),
      succeeded: true,
      failureCode: null,
    }), 'CLAIM_MISMATCH');
    psql(`
      UPDATE public.staff_lifecycle_events
      SET provider_claim_expires_at = pg_catalog.now() - interval '1 second'
      WHERE id = '${firstClaim.eventId}'::uuid;
    `);
    assert.equal(await gateway.completeProviderReconciliation({
      eventId: firstClaim.eventId,
      reconciliationToken: firstClaim.reconciliationToken,
      succeeded: true,
      failureCode: null,
    }), 'CLAIM_EXPIRED');

    const retryClaim = await gateway.claimProviderReconciliation({
      actorAdminUserId: adminA.adminId,
      targetEmail: failureTarget.email,
      expectedVersion: 2,
    });
    assert.equal(retryClaim.resultCode, 'CLAIMED');
    assert(retryClaim.eventId && retryClaim.reconciliationToken && retryClaim.authUserId);
    assert.notEqual(retryClaim.reconciliationToken, firstClaim.reconciliationToken);
    assert.equal(await gateway.completeProviderReconciliation({
      eventId: retryClaim.eventId,
      reconciliationToken: firstClaim.reconciliationToken,
      succeeded: true,
      failureCode: null,
    }), 'CLAIM_MISMATCH');
    assert.equal(await realProvider.setAccessEnabled(retryClaim.authUserId, false), true);
    assert.equal(await gateway.completeProviderReconciliation({
      eventId: retryClaim.eventId,
      reconciliationToken: retryClaim.reconciliationToken,
      succeeded: true,
      failureCode: null,
    }), 'RECORDED');
    assert.equal(await gateway.completeProviderReconciliation({
      eventId: retryClaim.eventId,
      reconciliationToken: retryClaim.reconciliationToken,
      succeeded: true,
      failureCode: null,
    }), 'CLAIM_MISMATCH');
    const event = await service.from('staff_lifecycle_events')
      .select('provider_status,provider_attempt_count,provider_failure_code,provider_claim_token_hash')
      .eq('target_admin_user_id', failureTarget.adminId)
      .eq('lifecycle_version', 2)
      .single();
    assert.ifError(event.error);
    assert.deepEqual(event.data, {
      provider_status: 'succeeded',
      provider_attempt_count: 3,
      provider_failure_code: null,
      provider_claim_token_hash: null,
    });
  });

  await scenario(9, 'same-version concurrent role replacements produce one winner and one stale result', async () => {
    const outcomes = await Promise.all([
      lifecycle(adminA, successfulProvider, {
        action: 'replace_roles', targetEmail: target.email, expectedVersion: 4, roles: ['editor'],
      }),
      lifecycle(adminB, successfulProvider, {
        action: 'replace_roles', targetEmail: target.email, expectedVersion: 4,
        roles: ['reviewer', 'editor'],
      }),
    ]);
    assert.deepEqual(outcomes.map(({ code }) => code).sort(), ['STALE_VERSION', 'UPDATED']);
    const current = await service.from('admin_users').select('lifecycle_version').eq('id', target.adminId).single();
    assert.ifError(current.error);
    assert.equal(Number(current.data.lifecycle_version), 5);
  });

  await scenario(10, 'self-modification and orphan actor identities are denied at the database boundary', async () => {
    const outcome = await lifecycle(adminA, successfulProvider, {
      action: 'deactivate', targetEmail: adminA.email, expectedVersion: 1,
    });
    assert.equal(outcome.code, 'SELF_MODIFICATION_DENIED');
    const orphanOutcome = await manageStaffLifecycle({
      permissions: adminPermissions,
      actorAdminUserId: String(orphanProfile.data.id),
      database: database(),
      provider: successfulProvider,
    }, {
      action: 'deactivate', targetEmail: adminB.email, expectedVersion: 1,
    });
    assert.equal(orphanOutcome.code, 'PERMISSION_DENIED');
  });

  await scenario(11, 'concurrent cross-offboarding cannot remove the last effective Administrator', async () => {
    const outcomes = await Promise.all([
      lifecycle(adminA, successfulProvider, {
        action: 'deactivate', targetEmail: adminB.email, expectedVersion: 1,
      }),
      lifecycle(adminB, successfulProvider, {
        action: 'deactivate', targetEmail: adminA.email, expectedVersion: 1,
      }),
    ]);
    assert.deepEqual(outcomes.map(({ code }) => code).sort(), ['PERMISSION_DENIED', 'UPDATED']);
    assert.equal(psql(`
      SELECT count(DISTINCT staff.id)
      FROM public.admin_users staff
      JOIN public.user_roles roles ON roles.user_id = staff.id AND roles.role = 'admin'
      WHERE staff.lifecycle_status = 'active' AND staff.auth_user_id IS NOT NULL;
    `), '1');
  });

  await scenario(12, 'audit history is durable and contains every real transition without provider identity data', async () => {
    const events = await service.from('staff_lifecycle_events').select(
      'action,previous_status,next_status,previous_roles,next_roles,lifecycle_version,provider_action,provider_status',
    );
    assert.ifError(events.error);
    assert((events.data?.length ?? 0) >= 6);
    assert(events.data?.some((event) => event.action === 'role_set_replaced'));
    assert(events.data?.some((event) => event.action === 'deactivated'));
    assert(events.data?.some((event) => event.action === 'reactivated'));
    assert(!JSON.stringify(events.data).includes(target.authId));
    assert(!JSON.stringify(events.data).includes(adminA.authId));
    const profiles = await service.from('admin_users').select('id').like('email', `${prefix}.%`);
    assert.ifError(profiles.error);
    assert.equal(profiles.data?.length, 5);
  });

  await scenario(13, 'RLS, grants, and RPC execution remain least-privilege', async () => {
    const unauthenticated = anon();
    const tableRead = await unauthenticated.from('staff_lifecycle_events').select('id').limit(1);
    const rpcCall = await unauthenticated.rpc('manage_staff_lifecycle', {
      p_actor_admin_id: adminA.adminId,
      p_target_email: target.email,
      p_action: 'deactivate',
      p_roles: null,
      p_expected_version: 5,
    });
    const directWrite = await service.from('staff_lifecycle_events').insert({});
    assert(tableRead.error);
    assert(rpcCall.error);
    assert(directWrite.error);
    assert.equal(psql(`
      SELECT relrowsecurity::text || ':' || relforcerowsecurity::text
      FROM pg_catalog.pg_class WHERE oid = 'public.staff_lifecycle_events'::regclass;
    `), 'true:true');
    assert.equal(psql(`
      SELECT has_table_privilege('anon', 'public.staff_lifecycle_events', 'SELECT')::text || ':' ||
             has_table_privilege('authenticated', 'public.staff_lifecycle_events', 'SELECT')::text || ':' ||
             has_table_privilege('service_role', 'public.staff_lifecycle_events', 'SELECT')::text;
    `), 'false:false:true');
    assert.equal(psql(`
      SELECT has_function_privilege('anon', 'public.manage_staff_lifecycle(uuid,text,text,text[],bigint)', 'EXECUTE')::text || ':' ||
             has_function_privilege('authenticated', 'public.manage_staff_lifecycle(uuid,text,text,text[],bigint)', 'EXECUTE')::text || ':' ||
             has_function_privilege('service_role', 'public.manage_staff_lifecycle(uuid,text,text,text[],bigint)', 'EXECUTE')::text;
    `), 'false:false:true');
  });
}

async function main(): Promise<void> {
  console.log('=== Disposable Staff Lifecycle Local Runtime Verification ===');
  const workdir = createWorkdir();
  let networkId = '';
  let startAttempted = false;
  let failure: unknown = null;
  try {
    networkId = docker([
      'network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
      networkName,
    ]);
    startAttempted = true;
    supabaseCli(['start', '--exclude', 'vector'], workdir, networkId);
    await runScenarios(workdir, networkId);
  } catch (error) {
    failure = error;
    console.error(error instanceof Error ? error.message : 'STAFF_LIFECYCLE_RUNTIME_FAILED');
  } finally {
    if (startAttempted) {
      try { supabaseCli(['stop', '--no-backup'], workdir, networkId); }
      catch { failure ??= new Error('Disposable Supabase stop failed.'); }
    }
    try { removeOwnedDockerResidue(); }
    catch { failure ??= new Error('Disposable Docker cleanup failed.'); }
    try { fs.rmSync(workdir, { recursive: true, force: true }); }
    catch { failure ??= new Error('Disposable workdir cleanup failed.'); }
    try {
      const residue = [
        ...docker(['ps', '-aq', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['volume', 'ls', '-q', '--filter', `label=com.supabase.cli.project=${projectId}`]).split(/\r?\n/).filter(Boolean),
        ...docker(['network', 'ls', '--filter', `name=${networkName}`, '--format', '{{.Name}}']).split(/\r?\n/).filter(Boolean),
      ];
      assert.equal(residue.length, 0, 'Disposable Docker residue remains.');
      assert.equal(fs.existsSync(workdir), false, 'Disposable workdir residue remains.');
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    console.error('Disposable staff lifecycle runtime verification failed.');
    process.exitCode = 1;
    return;
  }
  console.log('PASS: Disposable staff lifecycle runtime verification complete with no residue.');
}

void main();
