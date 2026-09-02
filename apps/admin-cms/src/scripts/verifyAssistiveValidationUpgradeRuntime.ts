import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { runLocalSupabaseCli } from '../local-development/safeSupabaseCli';

const DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const MIGRATION_30_VERSION = '20260820120000';
const PIPELINE = 'assistive-deterministic-checks/v1';
const FINDING = [{
  checkType: 'FORMATTING',
  outcome: 'INFORMATION',
  classification: 'NON_BLOCKING',
  reasonCode: 'REPEATED_WHITESPACE',
  affectedField: 'extraction_text',
  origin: 'DETERMINISTIC_HELPER',
  scoreKind: null,
  scoreValue: null,
  evidence: {
    version: 'assistive-finding-evidence/v1',
    evidenceExcerpt: 'Synthetic  spacing',
    pageNumber: null,
    boundingBox: null,
    metadataValue: null,
    normalizedMetadataValue: null,
    candidateValue: null,
    normalizedCandidateValue: null,
    explanation: 'Synthetic Migration 0030 to 0031 upgrade finding.',
  },
}];

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertCliSuccess(result: ReturnType<typeof runLocalSupabaseCli>, operation: string): void {
  assert.equal(
    result.ok,
    true,
    `${operation} failed (${result.failureCategory ?? 'UNKNOWN'}, exit ${result.exitCode ?? 'null'}).`,
  );
}

async function main(): Promise<void> {
  console.log('=== Assistive Validation Migration 0030 to 0031 Upgrade Verification ===');
  const root = path.resolve(__dirname, '../../../..');
  const psql = (sql: string): string => execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  const assertResetReachedExactMigration = (
    result: ReturnType<typeof runLocalSupabaseCli>,
    operation: string,
    expectedCount: number,
    expectedLatestVersion: string,
  ): void => {
    if (result.ok) return;
    assert.equal(
      psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'),
      String(expectedCount),
      `${operation} failed (${result.failureCategory ?? 'UNKNOWN'}, exit ${result.exitCode ?? 'null'}).`,
    );
    assert.equal(
      psql('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1;'),
      expectedLatestVersion,
      `${operation} did not reach the exact expected migration head.`,
    );
    console.log(`PASS: ${operation} reached the exact database postcondition despite a non-zero CLI result.`);
  };

  let primaryFailure: unknown = null;
  let passed = 0;
  const scenario = (name: string, body: () => void) => {
    body();
    passed += 1;
    console.log(`PASS: ${name}`);
  };

  try {
    assertResetReachedExactMigration(
      runLocalSupabaseCli('reset', root, { resetVersion: MIGRATION_30_VERSION, skipSeed: true }),
      'reset through Migration 0030', 30, MIGRATION_30_VERSION,
    );
    scenario('database is exactly at Migration 0030 before fixture insertion', () => {
      assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '30');
      assert.equal(psql("SELECT to_regclass('public.assistive_validation_jobs') IS NULL;"), 't');
    });

    const actorId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const prefix = `assistive-upgrade-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    psql(`
      INSERT INTO public.admin_users (id, email, full_name)
      VALUES (${sqlLiteral(actorId)}::uuid, ${sqlLiteral(`${prefix}@capstone.test`)}, 'Synthetic Upgrade Actor');
      INSERT INTO public.user_roles (user_id, role)
      VALUES (${sqlLiteral(actorId)}::uuid, 'editor');
      INSERT INTO public.projects (
        id, public_id, title, summary, status, year, program_name, discipline, group_name, team_members
      ) VALUES (
        ${sqlLiteral(projectId)}::uuid, ${sqlLiteral(`2026-${prefix}`)},
        'Synthetic Upgrade Project', 'Disposable Migration 0030 fixture.', 'draft', 2026,
        'Synthetic Software Engineering', 'Software Engineering', 'Synthetic Upgrade Group',
        ARRAY['Synthetic Member']::text[]
      );
      -- Legacy pre-gallery media. At Migration 0030 the gallery_position column
      -- does not exist yet, so this is exactly the shape a real database holds
      -- before the multi-image gallery upgrade.
      INSERT INTO public.media_assets (
        project_id, asset_type, file_name, storage_bucket, storage_path,
        mime_type, file_size_bytes, is_public_approved
      ) VALUES (
        ${sqlLiteral(projectId)}::uuid, 'snapshot_image', 'snapshot-1.png',
        'project-drafts-private',
        ${sqlLiteral(`drafts/2026-${prefix}/snapshot_image/snapshot-1.png`)},
        'image/png', 524288, false
      ), (
        ${sqlLiteral(projectId)}::uuid, 'poster_image', 'poster.png',
        'project-drafts-private',
        ${sqlLiteral(`drafts/2026-${prefix}/poster_image/poster.png`)},
        'image/png', 1048576, false
      );
    `);

    const persist = (status: 'COMPLETED' | 'FAILED', failureCode: string | null, findings: unknown) => {
      const result = JSON.parse(psql(`
        SELECT public.persist_assistive_validation_run(
          ${sqlLiteral(projectId)}::uuid,
          ${sqlLiteral(actorId)}::uuid,
          ${sqlLiteral(hash(`${prefix}:${status}`))},
          ${sqlLiteral(PIPELINE)},
          ${sqlLiteral(status)},
          ${failureCode === null ? 'NULL' : sqlLiteral(failureCode)},
          ${sqlLiteral(JSON.stringify(findings))}::jsonb
        )::text;
      `)) as { resultCode?: unknown; runId?: unknown };
      assert.equal(result.resultCode, 'PERSISTED');
      assert.equal(typeof result.runId, 'string');
      return String(result.runId);
    };

    const completedRunId = persist('COMPLETED', null, FINDING);
    const failedRunId = persist('FAILED', 'EXTRACTION_FAILED', []);
    const runIds = [completedRunId, failedRunId];
    const runList = runIds.map((id) => `${sqlLiteral(id)}::uuid`).join(',');
    const findingsBefore = psql(`
      SELECT COALESCE(pg_catalog.jsonb_agg(to_jsonb(f) ORDER BY f.ordinal), '[]'::jsonb)::text
      FROM public.assistive_validation_findings AS f
      WHERE f.run_id = ${sqlLiteral(completedRunId)}::uuid;
    `);
    const projectBefore = psql(`SELECT to_jsonb(p)::text FROM public.projects AS p WHERE p.id = ${sqlLiteral(projectId)}::uuid;`);
    const workflowBefore = psql(`
      SELECT pg_catalog.jsonb_build_object(
        'approvalRecords', (SELECT pg_catalog.count(*) FROM public.approval_records WHERE project_id = ${sqlLiteral(projectId)}::uuid),
        'validationFlags', (SELECT pg_catalog.count(*) FROM public.validation_flags WHERE project_id = ${sqlLiteral(projectId)}::uuid),
        'publishedSnapshots', (SELECT pg_catalog.count(*) FROM public.published_snapshots)
      )::text;
    `);

    scenario('existing completed and failed Phase 3 runs plus findings are seeded', () => {
      assert.equal(psql(`SELECT count(*) FROM public.assistive_validation_runs WHERE id IN (${runList});`), '2');
      assert.equal(JSON.parse(findingsBefore).length, 1);
    });

    assertCliSuccess(runLocalSupabaseCli('migration-up', root), 'apply pending Migrations 0031 through 0049');
    scenario('Migrations 0031 through 0049 apply as the only pending migrations', () => {
      assert.equal(psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), '49');
      assert.equal(psql("SELECT to_regclass('public.assistive_validation_jobs') IS NOT NULL;"), 't');
    });

    scenario('the legacy pre-gallery snapshot is backfilled to gallery position 1', () => {
      // Migration 0034 must give every pre-existing snapshot an authoritative
      // position BEFORE it installs the gallery-position constraint. If the
      // backfill were dropped or reordered, adding the constraint would fail
      // validation against this row and the upgrade would abort here.
      assert.equal(
        psql(`
          SELECT ma.gallery_position
          FROM public.media_assets AS ma
          WHERE ma.project_id = ${sqlLiteral(projectId)}::uuid
            AND ma.asset_type = 'snapshot_image';
        `),
        '1',
      );

      // Fixed single-role media must stay position-free across the upgrade.
      assert.equal(
        psql(`
          SELECT COALESCE(ma.gallery_position::text, 'null')
          FROM public.media_assets AS ma
          WHERE ma.project_id = ${sqlLiteral(projectId)}::uuid
            AND ma.asset_type = 'poster_image';
        `),
        'null',
      );
    });

    scenario('the upgraded schema refuses a snapshot with no gallery position', () => {
      // A CHECK constraint accepts NULL as well as TRUE, so the bound alone was
      // not enough: an unpositioned snapshot made the expression NULL and was
      // accepted. Prove the upgraded database now rejects it outright.
      const rejected = psql(`
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint AS c
          WHERE c.conname = 'media_assets_gallery_position_check'
            AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%gallery_position IS NOT NULL%'
        ) THEN 't' ELSE 'f' END;
      `);

      assert.equal(rejected, 't');
    });

    const job = (runId: string) => JSON.parse(psql(`
      SELECT pg_catalog.jsonb_build_object(
        'status', j.status,
        'attemptCount', j.attempt_count,
        'availableAtMatches', j.available_at = r.created_at,
        'lastErrorCode', j.last_error_code,
        'claimStateClear', j.claimed_at IS NULL AND j.lease_until IS NULL
          AND j.worker_id IS NULL AND j.claim_token IS NULL,
        'cancellationStateClear', j.cancellation_requested_at IS NULL AND j.cancelled_at IS NULL
      )::text
      FROM public.assistive_validation_runs AS r
      JOIN public.assistive_validation_jobs AS j ON j.run_id = r.id
      WHERE r.id = ${sqlLiteral(runId)}::uuid;
    `)) as Record<string, unknown>;

    scenario('completed and failed runs each receive one coherent attempt-zero terminal job', () => {
      assert.deepEqual(job(completedRunId), {
        status: 'COMPLETED',
        attemptCount: 0,
        availableAtMatches: true,
        lastErrorCode: null,
        claimStateClear: true,
        cancellationStateClear: true,
      });
      assert.deepEqual(job(failedRunId), {
        status: 'FAILED',
        attemptCount: 0,
        availableAtMatches: true,
        lastErrorCode: 'EXTRACTION_FAILED',
        claimStateClear: true,
        cancellationStateClear: true,
      });
      assert.equal(psql(`
        SELECT count(*) FROM (
          SELECT r.id FROM public.assistive_validation_runs AS r
          LEFT JOIN public.assistive_validation_jobs AS j ON j.run_id = r.id
          GROUP BY r.id HAVING count(j.id) <> 1
        ) AS incoherent;
      `), '0');
      assert.equal(psql('SELECT count(*) - count(DISTINCT run_id) FROM public.assistive_validation_jobs;'), '0');
    });

    scenario('run IDs and Phase 3 findings remain byte-for-byte stable', () => {
      assert.equal(
        psql(`SELECT string_agg(id::text, ',' ORDER BY id) FROM public.assistive_validation_runs WHERE id IN (${runList});`),
        [...runIds].sort().join(','),
      );
      assert.equal(psql(`
        SELECT COALESCE(pg_catalog.jsonb_agg(to_jsonb(f) ORDER BY f.ordinal), '[]'::jsonb)::text
        FROM public.assistive_validation_findings AS f
        WHERE f.run_id = ${sqlLiteral(completedRunId)}::uuid;
      `), findingsBefore);
    });

    scenario('the Phase 4 status reader resolves both migrated runs', () => {
      for (const [runId, expectedStatus] of [
        [completedRunId, 'COMPLETED'],
        [failedRunId, 'FAILED'],
      ] as const) {
        const status = JSON.parse(psql(`
          SELECT public.get_assistive_validation_run_status(${sqlLiteral(runId)}::uuid)::text;
        `)) as Record<string, unknown>;
        assert.equal(status.resultCode, 'FOUND');
        assert.equal(status.runId, runId);
        assert.equal(status.runStatus, expectedStatus);
        assert.equal(status.jobStatus, expectedStatus);
        assert.equal(status.attemptCount, 0);
      }
    });

    scenario('project and authoritative workflow data remain unchanged', () => {
      assert.equal(
        psql(`SELECT to_jsonb(p)::text FROM public.projects AS p WHERE p.id = ${sqlLiteral(projectId)}::uuid;`),
        projectBefore,
      );
      assert.equal(psql(`
        SELECT pg_catalog.jsonb_build_object(
          'approvalRecords', (SELECT pg_catalog.count(*) FROM public.approval_records WHERE project_id = ${sqlLiteral(projectId)}::uuid),
          'validationFlags', (SELECT pg_catalog.count(*) FROM public.validation_flags WHERE project_id = ${sqlLiteral(projectId)}::uuid),
          'publishedSnapshots', (SELECT pg_catalog.count(*) FROM public.published_snapshots)
        )::text;
      `), workflowBefore);
    });

    console.log(`Assistive Migration 0030 to 0031 upgrade verification passed (${passed} scenarios).`);
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      assertResetReachedExactMigration(
        runLocalSupabaseCli('reset', root),
        'restore fresh Migration 0048 database', 48, '20260831090000',
      );
      assertCliSuccess(
        runLocalSupabaseCli('stop', root),
        'stop Local services after restoring Migration 0049',
      );
      assertCliSuccess(
        runLocalSupabaseCli('start', root),
        'restart Local services after restoring Migration 0049',
      );
      assert.equal(
        psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'),
        '49',
        'restarted Local stack did not retain all 49 migrations',
      );
      assert.equal(
        psql('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1;'),
        '20260902010606',
        'restarted Local stack did not retain the Migration 0049 head',
      );
      console.log('PASS: fresh Migration 0049 database and Local service stack restored.');
    } catch (restoreError) {
      if (primaryFailure) throw new AggregateError([primaryFailure, restoreError], 'Upgrade verification and database restoration failed.');
      throw restoreError;
    }
  }

  if (primaryFailure) throw primaryFailure;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Assistive upgrade verification failed.');
  process.exitCode = 1;
});
