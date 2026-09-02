import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { isLoopbackUrl, parseSupabaseCliEnv } from '../local-development/localEnvironmentFile';
import { runLocalSupabaseCli } from '../local-development/safeSupabaseCli';
import {
  LAUNCH_LIMIT_PER_ROLLING_WINDOW,
  LAUNCH_WINDOW_DAYS,
} from '../assistive-validation/domain/executionControlContract';
import { SupabaseAssistiveExecutionControlRepository } from '../assistive-validation/repositories/assistiveExecutionControlRepository';
import { runOnDemandAssistiveWorker } from '../assistive-validation/services/onDemandAssistiveWorkerLoop';

/**
 * Migration 0047 execution-control runtime verification.
 *
 * Proves against a real PostgreSQL instance that the launch ceiling is enforced by the database,
 * that a unit is reserved before any start can be requested and is never released afterwards, that
 * the dedicated dispatcher role reaches nothing beyond its four routines, and that none of it can
 * touch project, approval, publication, or public-feed state.
 */

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PIPELINE = 'assistive-deterministic-checks/v3';
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'c'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'d'.repeat(64)}`;
const DISPATCHER_ROLE = 'capstone_assistive_dispatcher';
const DISPATCHER_ID = 'runtime-dispatcher-01';
const WORKER_ID = 'runtime-worker-01';
const JOB_WORKER_ID = '20000000-0000-4000-8000-000000000001';
const LEASE_SECONDS = 900;
const PREVIOUS_MIGRATION_VERSION = '20260828120000';


function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main(): Promise<void> {
  console.log('=== Assistive Execution Control Local Runtime Verification ===');
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

  const psql = (sql: string, options: { role?: string; timezone?: string } = {}): string => {
    const prelude = [
      options.timezone ? `SET TIME ZONE '${options.timezone}';` : '',
      options.role ? `SET ROLE ${options.role};` : '',
    ].join(' ');
    return execFileSync(
      'docker',
      ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1',
        '-c', `${prelude} ${sql}`],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  };
  /**
   * Runs SQL over a real authenticated connection as the dedicated dispatcher role, which is the
   * exact path the deployed dispatcher uses. A temporary password is granted for the duration of
   * this disposable Local verification and cleared in the cleanup block.
   */
  const dispatcherPassword = `probe_${crypto.randomBytes(12).toString('hex')}`;
  const dispatcherSql = (sql: string): { ok: boolean; value: string } => {
    try {
      return {
        ok: true,
        value: execFileSync(
          'docker',
          ['exec', '-i', '-e', `PGPASSWORD=${dispatcherPassword}`, DB_CONTAINER, 'psql',
            '-U', DISPATCHER_ROLE, '-h', '127.0.0.1', '-d', 'postgres', '-At',
            '-v', 'ON_ERROR_STOP=1', '-c', sql],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim(),
      };
    } catch (error) {
      return { ok: false, value: error instanceof Error ? error.message : 'FAILED' };
    }
  };

  const service = createClient(cliEnv.API_URL, cliEnv.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonymous = createClient(cliEnv.API_URL, cliEnv.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rpc = async (name: string, parameters: Record<string, unknown> = {}) => {
    const result = await service.rpc(name, parameters);
    assert.ifError(result.error);
    return result.data as Record<string, unknown>;
  };

  const reserve = (dispatcherId = DISPATCHER_ID, deployment = COMMIT, digest = DIGEST) =>
    JSON.parse(psql(
      `SELECT assistive_execution_control.reserve_assistive_launch(`
      + `'${dispatcherId}', '${deployment}', '${digest}', ${LEASE_SECONDS})::text;`,
    )) as Record<string, unknown>;
  const probe = () => JSON.parse(psql(
    'SELECT assistive_execution_control.inspect_assistive_launch_eligibility()::text;',
  )) as Record<string, unknown>;
  const markRequested = (token: string, generation: number) => JSON.parse(psql(
    `SELECT assistive_execution_control.mark_assistive_launch_requested('${token}', ${generation})::text;`,
  )) as Record<string, unknown>;
  const recordOutcome = (token: string, generation: number, outcome: string, reference: string | null) =>
    JSON.parse(psql(
      `SELECT assistive_execution_control.record_assistive_launch_outcome('${token}', ${generation}, `
      + `'${outcome}', ${reference === null ? 'NULL' : `'${reference}'`})::text;`,
    )) as Record<string, unknown>;
  const consumedInWindow = (timezone?: string) => Number(psql(
    'SELECT count(*) FROM assistive_execution_control.launch_reservations '
    + `WHERE counts_against_budget AND reserved_at > pg_catalog.now() - interval '${LAUNCH_WINDOW_DAYS} days';`,
    timezone ? { timezone } : {},
  ));
  const resetReservations = () => psql('DELETE FROM assistive_execution_control.launch_reservations;');
  /** Seeds reservations that already consumed budget, aged by the given offset. */
  const seedConsumed = (count: number, ageExpression: string) => psql(
    `INSERT INTO assistive_execution_control.launch_reservations (
       environment, execution_mode, generation, dispatcher_instance_id, deployment_version,
       image_digest, state, counts_against_budget, reserved_at, expires_at, settled_at, outcome_code
     )
     SELECT 'staging', 'ON_DEMAND', 1000 + g, '${DISPATCHER_ID}', '${COMMIT}', '${DIGEST}',
            'COMPLETED', true,
            pg_catalog.now() - (${ageExpression}),
            pg_catalog.now() - (${ageExpression}) + interval '900 seconds',
            pg_catalog.now(), 'COMPLETED'
       FROM pg_catalog.generate_series(1, ${count}) AS g;`,
  );

  const prefix = `execution-control-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const upgradeProjectId = crypto.randomUUID();
  let actorId = '';
  let projectId = '';
  let passed = 0;
  let primaryFailure: unknown = null;
  const scenario = async (number: number, name: string, body: () => Promise<void> | void) => {
    await body();
    passed += 1;
    console.log(`PASS: Scenario ${number} - ${name}`);
  };

  const authorityBefore = () => psql(`SELECT pg_catalog.jsonb_build_object(
    'projects', (SELECT pg_catalog.count(*) FROM public.projects),
    'approvals', (SELECT pg_catalog.count(*) FROM public.approval_records),
    'flags', (SELECT pg_catalog.count(*) FROM public.validation_flags),
    'snapshots', (SELECT pg_catalog.count(*) FROM public.published_snapshots),
    'feedOperations', (SELECT pg_catalog.count(*) FROM public.public_feed_operations),
    'feedHead', (SELECT pg_catalog.count(*) FROM public.public_feed_head)
  )::text;`);

  try {
    const resetToPrevious = runLocalSupabaseCli('reset', root, {
      resetVersion: PREVIOUS_MIGRATION_VERSION,
    });
    assert.equal(
      resetToPrevious.ok,
      true,
      `Reset through Migration 0046 failed (${resetToPrevious.failureCategory ?? 'UNKNOWN'}).`,
    );
    assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '46');
    assert.equal(psql("SELECT to_regnamespace('assistive_execution_control') IS NULL;"), 't');
    psql(`INSERT INTO public.projects (
      id, public_id, title, summary, status, year, program_name, discipline, group_name, team_members
    ) VALUES (
      '${upgradeProjectId}'::uuid, '2026-${prefix}-upgrade', 'Synthetic 0046 Upgrade Project',
      'Proves Migration 0047 preserves existing project data.', 'draft', 2026,
      'Synthetic Software Engineering', 'Software Engineering', 'Synthetic Upgrade Group',
      ARRAY['Synthetic Member']::text[]
    );`);
    const upgradeProjectBefore = psql(`SELECT to_jsonb(p)::text FROM public.projects AS p WHERE p.id = '${upgradeProjectId}'::uuid;`);
    const migrationUp = runLocalSupabaseCli('migration-up', root);
    assert.equal(
      migrationUp.ok,
      true,
      `Migration 0046 to 0049 failed (${migrationUp.failureCategory ?? 'UNKNOWN'}).`,
    );

    const actor = await service.from('admin_users').insert({
      email: `${prefix}@capstone.test`,
      full_name: 'Synthetic Execution Control Operator',
    }).select('id').single();
    assert.ifError(actor.error);
    actorId = String(actor.data!.id);
    assert.ifError((await service.from('user_roles').insert({ user_id: actorId, role: 'editor' })).error);
    const project = await service.from('projects').insert({
      public_id: `2026-${prefix}`,
      title: 'Synthetic Execution Control Project',
      summary: 'Disposable local Migration 0047 runtime fixture.',
      status: 'draft',
      year: 2026,
      program_name: 'Synthetic Software Engineering',
      discipline: 'Software Engineering',
      group_name: `Group ${prefix}`,
      team_members: ['Synthetic Member'],
    }).select('id').single();
    assert.ifError(project.error);
    projectId = String(project.data!.id);
    const beforeAuthority = authorityBefore();

    resetReservations();
    psql("DELETE FROM assistive_execution_control.executor_registrations WHERE environment = 'staging';");
    // The migration leaves the LOGIN role without a password. Grant a disposable password so the
    // privilege checks below exercise the real authenticated connection path.
    psql(`ALTER ROLE ${DISPATCHER_ROLE} WITH PASSWORD '${dispatcherPassword}';`);

    await scenario(1, 'Migration 0046 to 0049 preserves project data and installs the control schema', () => {
      assert.equal(
        psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'),
        '49',
      );
      assert.equal(
        psql(`SELECT to_jsonb(p)::text FROM public.projects AS p WHERE p.id = '${upgradeProjectId}'::uuid;`),
        upgradeProjectBefore,
      );
      assert.equal(
        psql("SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'assistive_execution_control';"),
        '1',
      );
      for (const relation of ['launch_budget_guard', 'launch_reservations', 'executor_registrations']) {
        assert.equal(
          psql(`SELECT to_regclass('assistive_execution_control.${relation}') IS NOT NULL;`),
          't',
          `${relation} is missing`,
        );
      }
    });

    await scenario(2, 'the hard ceiling is a database constraint, not configuration', () => {
      assert.equal(
        psql("SELECT launch_limit || ':' || window_days || ':' || max_active_executions "
          + "FROM assistive_execution_control.launch_budget_guard WHERE environment = 'staging';"),
        `${LAUNCH_LIMIT_PER_ROLLING_WINDOW}:${LAUNCH_WINDOW_DAYS}:1`,
      );
      assert.throws(() => psql(
        'UPDATE assistive_execution_control.launch_budget_guard SET launch_limit = 500;',
      ), /check_execution_control_launch_limit/);
      assert.throws(() => psql(
        'UPDATE assistive_execution_control.launch_budget_guard SET window_days = 1;',
      ), /check_execution_control_window_days/);
      assert.throws(() => psql(
        'UPDATE assistive_execution_control.launch_budget_guard SET max_active_executions = 4;',
      ), /check_execution_control_max_active/);
    });

    await scenario(3, 'row-level security is forced and no application role holds table privileges', async () => {
      for (const relation of ['launch_budget_guard', 'launch_reservations', 'executor_registrations']) {
        assert.equal(
          psql("SELECT relrowsecurity::text || ':' || relforcerowsecurity::text FROM pg_catalog.pg_class c "
            + "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
            + `WHERE n.nspname = 'assistive_execution_control' AND c.relname = '${relation}';`),
          'true:true',
        );
        assert.equal(
          psql('SELECT count(*) FROM information_schema.role_table_grants '
            + `WHERE table_schema = 'assistive_execution_control' AND table_name = '${relation}' `
            + `AND grantee IN ('PUBLIC','anon','authenticated','service_role','${DISPATCHER_ROLE}');`),
          '0',
        );
      }
      // The control schema is not exposed through the Data API at all.
      assert((await service.from('launch_reservations').select('*')).error);
      assert((await anonymous.from('launch_reservations').select('*')).error);
    });

    await scenario(4, 'anonymous callers cannot reach any execution-control routine', async () => {
      for (const name of [
        'register_assistive_executor', 'claim_assistive_execution_reservation',
        'settle_assistive_execution_reservation', 'get_assistive_executor_availability',
      ]) {
        assert((await anonymous.rpc(name, {})).error, `anonymous caller executed ${name}`);
      }
    });

    await scenario(5, 'the dispatcher role reaches its four routines and nothing else in PP1', () => {
      // Granted: exactly the dispatcher surface.
      assert.equal(
        dispatcherSql('SELECT assistive_execution_control.inspect_assistive_launch_eligibility() IS NOT NULL;').ok,
        true,
      );
      // Refused: every PP1 table, including the control tables it fences.
      for (const relation of [
        'public.projects', 'public.admin_users', 'public.assistive_validation_jobs',
        'public.assistive_validation_runs', 'public.assistive_validation_findings',
        'public.published_snapshots', 'public.public_feed_operations',
        'assistive_execution_control.launch_reservations',
        'assistive_execution_control.launch_budget_guard',
      ]) {
        const result = dispatcherSql(`SELECT count(*) FROM ${relation};`);
        assert.equal(result.ok, false, `dispatcher role read ${relation}`);
        assert.match(result.value, /permission denied/i);
      }
      // Refused: every privileged PP1 workflow, publication, and assistive-queue routine.
      for (const call of [
        'public.enqueue_assistive_validation_run(NULL, NULL, NULL, NULL)',
        'public.claim_next_assistive_validation_job(NULL, 120)',
        'public.get_assistive_validation_job_health()',
        'public.claim_assistive_execution_reservation(NULL, 1, NULL, NULL, NULL, NULL)',
        'public.register_assistive_executor(NULL, NULL, NULL, 30)',
        'public.get_assistive_executor_availability(NULL, NULL, NULL, NULL, NULL)',
      ]) {
        const result = dispatcherSql(`SELECT ${call};`);
        assert.equal(result.ok, false, `dispatcher role executed ${call}`);
        assert.match(result.value, /permission denied/i);
      }
      assert.equal(
        psql(`SELECT rolsuper::text || ':' || rolbypassrls::text || ':' || rolcreaterole::text
              FROM pg_catalog.pg_roles WHERE rolname = '${DISPATCHER_ROLE}';`),
        'false:false:false',
      );
    });

    await scenario(6, 'reservation is refused until an executor is registered', () => {
      assert.equal(reserve().resultCode, 'EXECUTOR_UNREGISTERED');
      assert.equal(probe().resultCode, 'EXECUTOR_UNREGISTERED');
    });

    await scenario(7, 'operator registration establishes the expected deployment identity', async () => {
      const registered = await rpc('register_assistive_executor', {
        p_deployment_version: COMMIT,
        p_image_digest: DIGEST,
        p_configuration_version: 'zero-cost-executor/v1',
        p_registration_days: 30,
      });
      assert.equal(registered.resultCode, 'REGISTERED');
      assert.equal(
        (await rpc('register_assistive_executor', {
          p_deployment_version: 'not-a-commit', p_image_digest: DIGEST,
          p_configuration_version: 'zero-cost-executor/v1', p_registration_days: 30,
        })).resultCode,
        'VALIDATION_FAILED',
      );
    });

    await scenario(8, 'with no eligible queue work no launch is reserved', () => {
      assert.equal(probe().resultCode, 'NO_WORK');
      assert.equal(reserve().resultCode, 'NO_WORK');
      assert.equal(consumedInWindow(), 0);
    });

    // Queue one real assistive job so eligibility is genuine rather than simulated.
    const inputHash = hash(`${prefix}:input`);
    const enqueued = await rpc('enqueue_assistive_validation_run', {
      p_project_id: projectId, p_actor_admin_id: actorId,
      p_input_hash: inputHash, p_pipeline_version: PIPELINE,
    });
    assert.equal(enqueued.resultCode, 'ENQUEUED');

    await scenario(9, 'the probe reports availability without exposing project content', () => {
      const result = probe();
      assert.equal(result.resultCode, 'WORK_AVAILABLE');
      assert.deepEqual(Object.keys(result).sort(), [
        'activeExecutions', 'consumedInWindow', 'launchLimit', 'resultCode', 'windowDays',
      ]);
      assert.equal(consumedInWindow(), 0, 'the probe must not reserve anything');
    });

    let token = '';
    let generation = 0;
    await scenario(10, 'a reservation consumes one unit before any start can be requested', () => {
      const reserved = reserve();
      assert.equal(reserved.resultCode, 'RESERVED');
      token = String(reserved.reservationToken);
      generation = Number(reserved.generation);
      assert.match(token, /^[0-9a-f-]{36}$/);
      assert.equal(reserved.launchLimit, LAUNCH_LIMIT_PER_ROLLING_WINDOW);
      assert.equal(reserved.windowDays, LAUNCH_WINDOW_DAYS);
      assert.equal(consumedInWindow(), 1);
      assert.equal(
        psql(`SELECT state FROM assistive_execution_control.launch_reservations WHERE reservation_token = '${token}';`),
        'RESERVED',
      );
    });

    await scenario(11, 'a second concurrent launch is refused while one is active', () => {
      assert.equal(reserve('runtime-dispatcher-02').resultCode, 'ACTIVE_LAUNCH');
      assert.equal(probe().resultCode, 'ACTIVE_LAUNCH');
      assert.equal(consumedInWindow(), 1);
    });

    await scenario(12, 'a pre-transmission failure is the only path that releases a unit', () => {
      assert.equal(recordOutcome(token, generation, 'PRESTART_FAILED', null).resultCode, 'OUTCOME_RECORDED');
      assert.equal(consumedInWindow(), 0);
      assert.equal(
        psql(`SELECT state || ':' || counts_against_budget::text
              FROM assistive_execution_control.launch_reservations WHERE reservation_token = '${token}';`),
        'PRESTART_FAILED:false',
      );
    });

    await scenario(13, 'the durable requested mark closes the refund path permanently', () => {
      const reserved = reserve();
      assert.equal(reserved.resultCode, 'RESERVED');
      token = String(reserved.reservationToken);
      generation = Number(reserved.generation);
      assert.equal(markRequested(token, generation).resultCode, 'START_REQUESTED');
      assert.equal(consumedInWindow(), 1);
      // After transmission may have occurred, no outcome can release the unit.
      assert.equal(recordOutcome(token, generation, 'PRESTART_FAILED', null).resultCode, 'FENCED');
      assert.equal(consumedInWindow(), 1);
    });

    await scenario(14, 'every post-transmission outcome keeps the unit consumed', () => {
      assert.equal(
        recordOutcome(token, generation, 'START_RESPONSE_ERROR', null).resultCode,
        'OUTCOME_RECORDED',
      );
      assert.equal(consumedInWindow(), 1);
      assert.equal(
        psql(`SELECT counts_against_budget::text FROM assistive_execution_control.launch_reservations
              WHERE reservation_token = '${token}';`),
        'true',
      );
      assert.throws(() => psql(
        `UPDATE assistive_execution_control.launch_reservations SET counts_against_budget = false
         WHERE reservation_token = '${token}';`,
      ), /check_execution_control_refund_only_before_transmission/);
    });

    await scenario(15, 'generation fencing rejects stale tokens and replays', () => {
      assert.equal(markRequested(token, generation + 1).resultCode, 'FENCED');
      assert.equal(recordOutcome(token, generation + 1, 'START_ACCEPTED', null).resultCode, 'FENCED');
      assert.equal(
        recordOutcome(crypto.randomUUID(), generation, 'START_ACCEPTED', null).resultCode,
        'FENCED',
      );
      assert.equal(recordOutcome(token, generation, 'START_ACCEPTED', null).resultCode, 'FENCED');
    });

    await scenario(16, 'a worker claim requires the exact reservation, deployment, digest, and mode', async () => {
      resetReservations();
      const reserved = reserve();
      token = String(reserved.reservationToken);
      generation = Number(reserved.generation);
      markRequested(token, generation);
      recordOutcome(token, generation, 'START_ACCEPTED', 'capstone-assistive-worker-abc123');

      const claim = (overrides: Record<string, unknown> = {}) => rpc('claim_assistive_execution_reservation', {
        p_reservation_token: token, p_generation: generation, p_worker_instance_id: WORKER_ID,
        p_deployment_version: COMMIT, p_image_digest: DIGEST, p_execution_mode: 'ON_DEMAND',
        ...overrides,
      });
      assert.equal((await claim({ p_generation: generation + 1 })).resultCode, 'CLAIM_REFUSED');
      assert.equal((await claim({ p_deployment_version: OTHER_COMMIT })).resultCode, 'CLAIM_REFUSED');
      assert.equal((await claim({ p_image_digest: OTHER_DIGEST })).resultCode, 'CLAIM_REFUSED');
      assert.equal((await claim({ p_execution_mode: 'CONTINUOUS' })).resultCode, 'VALIDATION_FAILED');
      assert.equal((await claim({ p_reservation_token: crypto.randomUUID() })).resultCode, 'CLAIM_REFUSED');
      assert.equal((await claim()).resultCode, 'CLAIMED');
      assert.equal((await claim()).resultCode, 'CLAIM_REFUSED', 'a reservation was claimed twice');
    });

    await scenario(17, 'settlement is fenced and never returns a unit to the ceiling', async () => {
      assert.equal((await rpc('settle_assistive_execution_reservation', {
        p_reservation_token: token, p_generation: generation + 1,
        p_outcome: 'COMPLETED', p_processed_job_count: 2,
      })).resultCode, 'FENCED');
      assert.equal((await rpc('settle_assistive_execution_reservation', {
        p_reservation_token: token, p_generation: generation,
        p_outcome: 'COMPLETED', p_processed_job_count: 2,
      })).resultCode, 'SETTLED');
      assert.equal(consumedInWindow(), 1);
      assert.equal((await rpc('settle_assistive_execution_reservation', {
        p_reservation_token: token, p_generation: generation,
        p_outcome: 'COMPLETED', p_processed_job_count: 2,
      })).resultCode, 'FENCED');
    });

    await scenario(18, 'the on-demand loop drains multiple Local jobs, settles once, and exits', async () => {
      resetReservations();
      const eligibilityQueuedJobs = Number(psql(
        "SELECT count(*) FROM public.assistive_validation_jobs WHERE status = 'QUEUED';",
      ));
      assert.equal(eligibilityQueuedJobs, 1, 'the earlier eligibility queue fixture is missing');
      for (const [ownedProjectId, suffix] of [[projectId, 'primary'], [upgradeProjectId, 'upgrade']] as const) {
        assert.equal((await rpc('enqueue_assistive_validation_run', {
          p_project_id: ownedProjectId,
          p_actor_admin_id: actorId,
          p_input_hash: hash(`${prefix}:on-demand:${suffix}`),
          p_pipeline_version: PIPELINE,
        })).resultCode, 'ENQUEUED');
      }

      const reserved = reserve();
      const drainToken = String(reserved.reservationToken);
      const drainGeneration = Number(reserved.generation);
      assert.equal(markRequested(drainToken, drainGeneration).resultCode, 'START_REQUESTED');
      assert.equal(
        recordOutcome(drainToken, drainGeneration, 'START_ACCEPTED', 'local-on-demand-drain').resultCode,
        'OUTCOME_RECORDED',
      );

      const result = await runOnDemandAssistiveWorker({
        signal: new AbortController().signal,
        reservation: { token: drainToken, generation: drainGeneration },
        identity: {
          workerInstanceId: WORKER_ID,
          deploymentVersion: COMMIT,
          imageDigest: DIGEST,
        },
        control: new SupabaseAssistiveExecutionControlRepository(service),
        createRuntime: () => ({
          health: async () => true,
          heartbeat: { publish: async () => undefined },
          runOnce: async () => {
            const claimed = await rpc('claim_next_assistive_validation_job', {
              p_worker_id: JOB_WORKER_ID,
              p_lease_seconds: 180,
            });
            if (claimed.resultCode === 'EMPTY') return { outcome: 'EMPTY' as const };
            assert.equal(claimed.resultCode, 'CLAIMED');
            assert.equal((await rpc('record_assistive_validation_job_failure', {
              p_job_id: claimed.jobId,
              p_claim_token: claimed.claimToken,
              p_failure_code: 'MEDIA_INVALID',
            })).resultCode, 'FAILED');
            return { outcome: 'FAILED' as const, runId: String(claimed.runId) };
          },
        }),
      });

      assert.deepEqual(result, { outcome: 'DRAINED', processedJobCount: eligibilityQueuedJobs + 2 });
      assert.equal(
        psql("SELECT count(*) FROM public.assistive_validation_jobs WHERE status = 'QUEUED';"),
        '0',
      );
      assert.equal(
        psql(`SELECT count(*) FROM public.assistive_validation_jobs AS j
               JOIN public.assistive_validation_runs AS r ON r.id = j.run_id
              WHERE r.project_id IN ('${projectId}'::uuid, '${upgradeProjectId}'::uuid)
                AND j.status = 'FAILED';`),
        String(eligibilityQueuedJobs + 2),
      );
      assert.equal(
        psql(`SELECT state || ':' || processed_job_count::text
                FROM assistive_execution_control.launch_reservations
               WHERE reservation_token = '${drainToken}'::uuid;`),
        `COMPLETED:${eligibilityQueuedJobs + 2}`,
      );
    });

    assert.equal((await rpc('enqueue_assistive_validation_run', {
      p_project_id: projectId,
      p_actor_admin_id: actorId,
      p_input_hash: hash(`${prefix}:post-drain-budget-fixture`),
      p_pipeline_version: PIPELINE,
    })).resultCode, 'ENQUEUED');

    await scenario(19, 'an expired launch clears the active fence without refunding', () => {
      resetReservations();
      const reserved = reserve();
      const expiredToken = String(reserved.reservationToken);
      markRequested(expiredToken, Number(reserved.generation));
      // The window constraint forbids moving expiry behind its own reservation, so the whole
      // reservation is aged instead. That is also what genuinely happens over time.
      psql(`UPDATE assistive_execution_control.launch_reservations
               SET reserved_at = pg_catalog.now() - interval '2 hours',
                   expires_at = pg_catalog.now() - interval '1 second'
             WHERE reservation_token = '${expiredToken}';`);
      const next = reserve();
      assert.equal(next.resultCode, 'RESERVED', 'the stale fence did not clear');
      assert.equal(
        psql(`SELECT state FROM assistive_execution_control.launch_reservations WHERE reservation_token = '${expiredToken}';`),
        'EXPIRED',
      );
      assert.equal(consumedInWindow(), 2, 'an expired launch must not be refunded');
      resetReservations();
    });

    await scenario(20, 'the rolling window admits the 40th start and refuses the 41st', () => {
      seedConsumed(LAUNCH_LIMIT_PER_ROLLING_WINDOW - 1, "interval '1 day'");
      assert.equal(consumedInWindow(), 39);
      const allowed = reserve();
      assert.equal(allowed.resultCode, 'RESERVED', 'the 40th start inside the window was refused');
      assert.equal(consumedInWindow(), 40);
      recordOutcome(String(allowed.reservationToken), Number(allowed.generation), 'PRESTART_FAILED', null);
      // Restore the row as a consumed start so the window sits exactly on the ceiling.
      psql(`UPDATE assistive_execution_control.launch_reservations
            SET state = 'COMPLETED', counts_against_budget = true, outcome_code = 'COMPLETED'
            WHERE reservation_token = '${String(allowed.reservationToken)}';`);
      assert.equal(consumedInWindow(), 40);
      assert.equal(reserve().resultCode, 'BUDGET_EXHAUSTED');
      assert.equal(probe().resultCode, 'BUDGET_EXHAUSTED');
    });

    await scenario(21, 'a start ageing past the window boundary releases capacity again', () => {
      // Exactly on the boundary the oldest start is still inside the window.
      psql(`UPDATE assistive_execution_control.launch_reservations
            SET reserved_at = pg_catalog.now() - interval '${LAUNCH_WINDOW_DAYS} days' + interval '1 second'
            WHERE reservation_token IN (
              SELECT reservation_token FROM assistive_execution_control.launch_reservations
               ORDER BY reserved_at ASC LIMIT 1);`);
      assert.equal(consumedInWindow(), 40);
      assert.equal(reserve().resultCode, 'BUDGET_EXHAUSTED');

      psql(`UPDATE assistive_execution_control.launch_reservations
            SET reserved_at = pg_catalog.now() - interval '${LAUNCH_WINDOW_DAYS} days' - interval '1 second'
            WHERE reservation_token IN (
              SELECT reservation_token FROM assistive_execution_control.launch_reservations
               ORDER BY reserved_at ASC LIMIT 1);`);
      assert.equal(consumedInWindow(), 39);
      const allowed = reserve();
      assert.equal(allowed.resultCode, 'RESERVED');
      recordOutcome(String(allowed.reservationToken), Number(allowed.generation), 'PRESTART_FAILED', null);
    });

    await scenario(22, 'the rolling window is independent of the PostgreSQL session timezone', () => {
      const utc = consumedInWindow('UTC');
      assert.equal(consumedInWindow('Pacific/Kiritimati'), utc);
      assert.equal(consumedInWindow('Pacific/Niue'), utc);
      assert.equal(consumedInWindow('Australia/Melbourne'), utc);
    });

    await scenario(23, 'concurrent reservations at the ceiling yield at most one launch', () => {
      resetReservations();
      seedConsumed(LAUNCH_LIMIT_PER_ROLLING_WINDOW - 1, "interval '2 days'");
      const attempts = Array.from({ length: 8 }, (_, index) => `runtime-race-${index}`)
        .map((id) => reserve(id));
      assert.equal(attempts.filter((result) => result.resultCode === 'RESERVED').length, 1);
      assert(attempts.every((result) =>
        ['RESERVED', 'ACTIVE_LAUNCH', 'BUDGET_EXHAUSTED'].includes(String(result.resultCode))));
      assert.equal(consumedInWindow(), LAUNCH_LIMIT_PER_ROLLING_WINDOW);
    });

    await scenario(24, 'availability reports the rolling window as authority and the month as display', async () => {
      const availability = await rpc('get_assistive_executor_availability', {
        p_pipeline_version: PIPELINE, p_deployment_version: COMMIT, p_image_digest: DIGEST,
        p_ocr_capability: 'paddle-title/pp-ocrv6-small@3.7.0',
        p_language_capability: 'languagetool/en-au@6.6',
      });
      assert.equal(availability.resultCode, 'BUDGET_EXHAUSTED');
      assert.equal(availability.launchLimit, LAUNCH_LIMIT_PER_ROLLING_WINDOW);
      assert.equal(availability.windowDays, LAUNCH_WINDOW_DAYS);
      assert.equal(availability.remainingInWindow, 0);
      assert.equal(typeof availability.utcCalendarMonthStarts, 'number');
      assert(
        Number(availability.utcCalendarMonthStarts) <= Number(availability.consumedInWindow),
        'the reporting month count must never exceed the authoritative window count',
      );
      assert.equal((await rpc('get_assistive_executor_availability', {
        p_pipeline_version: PIPELINE, p_deployment_version: OTHER_COMMIT, p_image_digest: DIGEST,
        p_ocr_capability: 'paddle-title/pp-ocrv6-small@3.7.0',
        p_language_capability: 'languagetool/en-au@6.6',
      })).resultCode, 'UNAVAILABLE');
    });

    await scenario(25, 'reservation retention is bounded beyond the rolling window', () => {
      resetReservations();
      seedConsumed(1, "interval '91 days'");
      seedConsumed(1, "interval '40 days'");
      assert.equal(psql('SELECT count(*) FROM assistive_execution_control.launch_reservations;'), '2');
      reserve();
      assert.equal(
        psql("SELECT count(*) FROM assistive_execution_control.launch_reservations "
          + "WHERE reserved_at < pg_catalog.now() - interval '90 days';"),
        '0',
      );
      assert.equal(
        psql("SELECT count(*) FROM assistive_execution_control.launch_reservations "
          + "WHERE reserved_at > pg_catalog.now() - interval '41 days';"),
        '2',
        'retention must not delete evidence inside the operational window',
      );
    });

    await scenario(26, 'malformed execution-control input fails closed', () => {
      for (const call of [
        `'../dispatcher', '${COMMIT}', '${DIGEST}', ${LEASE_SECONDS}`,
        `'${DISPATCHER_ID}', 'latest', '${DIGEST}', ${LEASE_SECONDS}`,
        `'${DISPATCHER_ID}', '${COMMIT}', 'latest', ${LEASE_SECONDS}`,
        `'${DISPATCHER_ID}', '${COMMIT}', '${DIGEST}', 30`,
        `'${DISPATCHER_ID}', '${COMMIT}', '${DIGEST}', 100000`,
      ]) {
        assert.equal(
          JSON.parse(psql(`SELECT assistive_execution_control.reserve_assistive_launch(${call})::text;`)).resultCode,
          'VALIDATION_FAILED',
        );
      }
      assert.equal(
        JSON.parse(psql(
          `SELECT assistive_execution_control.record_assistive_launch_outcome('${crypto.randomUUID()}', 1, 'ANYTHING', NULL)::text;`,
        )).resultCode,
        'VALIDATION_FAILED',
      );
    });

    await scenario(27, 'no execution-control operation changed project or publication authority', () => {
      assert.equal(authorityBefore(), beforeAuthority);
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      const restored = runLocalSupabaseCli('reset', root);
      if (!restored.ok) {
        throw new Error(`Final Local reset failed (${restored.failureCategory ?? 'UNKNOWN'}).`);
      }
    } catch (cleanupError) {
      if (!primaryFailure) primaryFailure = cleanupError;
    }
  }

  if (primaryFailure) throw primaryFailure;
  console.log(`PASS: Assistive execution control Local runtime verification complete (${passed} scenarios).`);
}

void main().catch((error) => {
  console.error('Assistive execution control runtime verification failed.');
  console.error(error);
  process.exitCode = 1;
});
