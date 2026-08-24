import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('assistive validation persistence migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260820120000_assistive_validation_persistence.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = content
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const compact = executable.replace(/\s+/g, ' ');

  const functionBody = (signatureStart: string): string => {
    const start = executable.indexOf(signatureStart);
    expect(start).toBeGreaterThan(-1);
    const end = executable.indexOf('\n$$;', start);
    expect(end).toBeGreaterThan(start);
    return executable.slice(start, end);
  };

  const persistBody = functionBody('CREATE OR REPLACE FUNCTION public.persist_assistive_validation_run(');
  const dispositionBody = functionBody('CREATE OR REPLACE FUNCTION public.record_assistive_finding_disposition(');
  const readBody = functionBody('CREATE OR REPLACE FUNCTION public.get_latest_assistive_validation_run(');

  it('remains migration 0030 and leaves every pre-Phase-4 migration byte-identical', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(34);
    expect(files[29]).toBe(filename);
    expect(files[30]).toBe('20260820160000_assistive_validation_job_coordination.sql');

    expect(() => execFileSync(
      'git', ['diff', '--exit-code', 'origin/main', '--', `infra/supabase/migrations/${filename}`],
      { cwd: root, stdio: 'pipe' },
    )).not.toThrow();
  });

  it('is additive only and never rewrites, drops, or repurposes inherited schema', () => {
    expect(executable).not.toMatch(/\bDROP\s+(TABLE|CONSTRAINT|POLICY|INDEX|COLUMN|SCHEMA)\b/i);
    expect(executable).not.toMatch(/\bALTER\s+TABLE\s+(?!public\.assistive_validation_)/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    // Existing tables are never written by this migration.
    expect(executable).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE)\s+public\.(projects|approval_records|published_snapshots|media_assets|validation_flags|import_batches|admin_users|user_roles|project_disciplines|project_industry_categories)\b/i,
    );
    expect(compact).toContain('CREATE TABLE public.assistive_validation_runs');
    expect(compact).toContain('CREATE TABLE public.assistive_validation_findings');
  });

  it('binds run ownership with the reasoned foreign-key delete behaviour', () => {
    expect(compact).toContain('REFERENCES public.projects(id) ON DELETE CASCADE');
    expect(compact).toContain('REFERENCES public.assistive_validation_runs(id) ON DELETE CASCADE');
    // Exactly two cascades: project -> run and run -> finding.
    expect(executable.match(/ON DELETE CASCADE/g)).toHaveLength(2);
    // Both staff attributions degrade instead of destroying or blocking.
    expect(executable.match(/REFERENCES public\.admin_users\(id\) ON DELETE SET NULL/g)).toHaveLength(2);
    expect(executable).not.toMatch(/ON DELETE RESTRICT|ON DELETE NO ACTION/i);
    expect(executable).not.toMatch(/REFERENCES\s+auth\./i);
  });

  it('makes a finding unable to disagree with its run about project or content identity', () => {
    const findingTable = executable.slice(
      executable.indexOf('CREATE TABLE public.assistive_validation_findings'),
      executable.indexOf('ALTER TABLE public.assistive_validation_runs ENABLE ROW LEVEL SECURITY'),
    );
    expect(findingTable.length).toBeGreaterThan(0);
    // The run owns these three; duplicating them onto a finding is what would allow disagreement.
    expect(findingTable).not.toMatch(/\bproject_id\b/);
    expect(findingTable).not.toMatch(/\binput_hash\b/);
    expect(findingTable).not.toMatch(/\bpipeline_version\b/);
    expect(findingTable).toContain('run_id uuid NOT NULL');
  });

  it('bounds run identity to lowercase SHA-256 and a versioned pipeline identifier', () => {
    expect(compact).toContain("CHECK (input_hash ~ '^[a-f0-9]{64}$')");
    expect(compact).toContain("CHECK (pipeline_version ~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$' AND pg_catalog.length(pipeline_version) <= 64)");
    expect(compact).toContain("CHECK (status IN ('COMPLETED', 'FAILED'))");
    expect(compact).toContain(
      "CHECK ((status = 'FAILED' AND failure_code IS NOT NULL) OR (status = 'COMPLETED' AND failure_code IS NULL))",
    );
  });

  it('keeps completed-run identity unique while leaving failed attempts retryable', () => {
    expect(compact).toContain(
      'CREATE UNIQUE INDEX uq_assistive_validation_runs_completed_identity ON public.assistive_validation_runs (project_id, input_hash, pipeline_version) WHERE status = \'COMPLETED\'',
    );
    // A total unique constraint over the identity would make any retry after a failure impossible.
    expect(compact).not.toMatch(/UNIQUE\s*\(\s*project_id,\s*input_hash,\s*pipeline_version\s*\)/i);
  });

  it('derives finding order in the database so the durable record keeps the produced sequence', () => {
    expect(compact).toContain('ordinal integer NOT NULL');
    expect(compact).toContain('CHECK (ordinal BETWEEN 1 AND 50)');
    expect(compact).toContain(
      'CONSTRAINT uq_assistive_validation_findings_run_ordinal UNIQUE (run_id, ordinal)',
    );
    // The position comes from the array itself, never from a caller-supplied field.
    expect(persistBody.replace(/\s+/g, ' ')).toContain(
      'FROM pg_catalog.jsonb_array_elements(p_findings) WITH ORDINALITY AS element(value, position)',
    );
    expect(persistBody.replace(/\s+/g, ' ')).toContain('element.position::integer,');
    expect(persistBody).not.toMatch(/element(\.value)?\s*->>\s*'ordinal'/);
    expect(readBody.replace(/\s+/g, ' ')).toContain('ORDER BY f.ordinal');
    // The unique constraint already supplies the only btree these reads need; a second index on
    // the same columns would be pure write cost.
    expect(executable).not.toMatch(/CREATE INDEX[^;]*assistive_validation_findings/i);
  });

  it('makes an authority-bearing classification impossible to store', () => {
    expect(compact).toContain("classification text NOT NULL DEFAULT 'NON_BLOCKING'");
    expect(compact).toContain("CHECK (classification = 'NON_BLOCKING')");
    for (const authority of ['BLOCKING', 'PUBLICATION_READY', 'APPROVED', 'VALID', 'AUTHORITATIVE']) {
      expect(executable).not.toContain(`'${authority}'`);
    }
    // NON_BLOCKING is written from this literal in the insert, never copied from caller input.
    expect(persistBody.replace(/\s+/g, ' ')).toContain(
      "element.value ->> 'checkType', element.value ->> 'outcome', 'NON_BLOCKING', element.value ->> 'reasonCode',",
    );
    expect(persistBody).not.toMatch(/element(\.value)?\s*->>\s*'classification'/);
  });

  it('closes the persisted evidence contract by version, keys, field bounds, geometry, and size', () => {
    expect(compact).toContain("CHECK (evidence ->> 'version' = 'assistive-finding-evidence/v1')");
    expect(compact).toContain("CHECK (pg_catalog.jsonb_typeof(evidence) = 'object')");
    expect(compact).toContain('CHECK (pg_catalog.length(evidence::text) <= 8192)');
    expect(compact).toContain(
      "CHECK (pg_catalog.jsonb_typeof(evidence -> 'explanation') = 'string' AND pg_catalog.length(evidence ->> 'explanation') BETWEEN 1 AND 300",
    );
    expect(compact).toContain('CONSTRAINT check_assistive_finding_evidence_excerpt');
    expect(compact).toContain("pg_catalog.length(evidence ->> 'evidenceExcerpt') <= 500");
    expect(compact).toContain('CONSTRAINT check_assistive_finding_evidence_values');
    for (const field of [
      'metadataValue', 'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue',
    ]) {
      expect(compact).toContain(`pg_catalog.jsonb_typeof(evidence -> '${field}') IN ('null', 'string')`);
      expect(compact).toContain(`pg_catalog.length(evidence ->> '${field}') <= 400`);
    }
    expect(compact).toContain('CONSTRAINT check_assistive_finding_evidence_page_number');
    expect(compact).toContain("(evidence ->> 'pageNumber')::numeric BETWEEN 1 AND 10");
    expect(compact).toContain('CONSTRAINT check_assistive_finding_evidence_bounding_box');
    expect(compact).toContain("ARRAY['left', 'top', 'right', 'bottom', 'unit']");
    expect(compact).toContain("'PDF_POINTS_TOP_LEFT', 'IMAGE_PIXELS_TOP_LEFT'");
    expect(compact).toContain("(evidence -> 'boundingBox' ->> 'right')::numeric >= (evidence -> 'boundingBox' ->> 'left')::numeric");
    expect(compact).toContain("(evidence -> 'boundingBox' ->> 'bottom')::numeric >= (evidence -> 'boundingBox' ->> 'top')::numeric");
    expect(compact).toContain("!~ U&'[\\0001-\\0008\\000B\\000C\\000E-\\001F\\007F]'");
    // Presence of every declared key AND rejection of any other key.
    expect(compact).toMatch(/CHECK \(evidence \?& ARRAY\[/);
    expect(compact).toMatch(/AND \(evidence - ARRAY\[[^\]]+\]\) = '\{\}'::jsonb\)/);
    // Evidence that must never be persisted has no column or key in either table definition.
    const tableDefinitions = executable.slice(
      executable.indexOf('CREATE TABLE public.assistive_validation_runs'),
      executable.indexOf('ALTER TABLE public.assistive_validation_runs ENABLE ROW LEVEL SECURITY'),
    );
    expect(tableDefinitions.length).toBeGreaterThan(0);
    expect(tableDefinitions).not.toMatch(
      /\b(chain_of_thought|reasoning|prompt|raw_response|raw_text|transcript|access_token|refresh_token|service_role|api_key|secret|password|credential|media_bytes|model_output)\b/i,
    );
  });

  it('records the score as an explicit bounded kind and value pair', () => {
    expect(compact).toContain("CHECK (score_kind IS NULL OR score_kind = 'LEXICAL_SIMILARITY')");
    // Exact decimal storage: a float8 loses its last significant digit on the way back into JSON.
    expect(compact).toContain('score_value numeric(19, 18)');
    expect(executable).not.toMatch(/score_value\s+double\s+precision|::double precision/i);
    expect(compact).toContain('CHECK (score_value IS NULL OR (score_value >= 0 AND score_value <= 1))');
    expect(persistBody.replace(/\s+/g, ' ')).toContain(
      "OR pg_catalog.length(v_finding ->> 'scoreValue') > 32",
    );
    expect(compact).toContain('CHECK ((score_kind IS NULL) = (score_value IS NULL))');
    // A bare "confidence" column would invite reading edit-distance evidence as certainty.
    expect(executable).not.toMatch(/\bconfidence\b/i);
  });

  it('anchors disposition coherence on the timestamp so staff deletion is never blocked', () => {
    expect(compact).toContain("CHECK (disposition IN ('UNREVIEWED', 'REVIEWED', 'IGNORED'))");
    expect(compact).toContain(
      "CHECK ((disposition = 'UNREVIEWED' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (disposition <> 'UNREVIEWED' AND reviewed_at IS NOT NULL))",
    );
    // reviewed_by is rewritten by ON DELETE SET NULL, so requiring it here would break that cascade.
    expect(compact).not.toContain("disposition <> 'UNREVIEWED' AND reviewed_by IS NOT NULL");
    // No disposition may imply that authoritative metadata was changed.
    expect(executable).not.toMatch(/'(ACCEPTED|APPLIED|APPLY_TO_DRAFT|RESOLVED_BY_APPLY)'/);
  });

  it('enables fail-closed RLS and revokes every direct privilege on both tables', () => {
    for (const table of ['assistive_validation_runs', 'assistive_validation_findings']) {
      expect(compact).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(compact).toContain(
        `CREATE POLICY deny_${table}_direct_access ON public.${table} AS RESTRICTIVE FOR ALL TO anon, authenticated, service_role USING (false) WITH CHECK (false)`,
      );
      expect(compact).toContain(
        `REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role`,
      );
      expect(compact).not.toMatch(
        new RegExp(`GRANT\\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*${table}`, 'i'),
      );
    }
  });

  it('grants execution on all three functions to service_role alone', () => {
    const signatures = [
      'public.persist_assistive_validation_run(uuid, uuid, text, text, text, text, jsonb)',
      'public.record_assistive_finding_disposition(uuid, uuid, text)',
      'public.get_latest_assistive_validation_run(uuid, text)',
    ];
    for (const signature of signatures) {
      expect(compact).toContain(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role`,
      );
      expect(compact).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
      expect(compact).not.toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
      expect(compact).not.toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO anon`);
    }
    expect(executable).not.toMatch(/GRANT\s+EXECUTE[^;]*TO\s+PUBLIC/i);
    expect(executable.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(3);
  });

  it('hardens every privileged function and uses no dynamic SQL', () => {
    expect(executable.match(/SECURITY DEFINER/g)).toHaveLength(3);
    expect(executable.match(/SET search_path = ''/g)).toHaveLength(3);
    const withoutAcls = executable
      .split('\n')
      .filter((line) => !/^\s*(GRANT|REVOKE)\b/i.test(line))
      .join('\n');
    expect(withoutAcls).not.toMatch(/\bEXECUTE\s+(?!FUNCTION)/i);
    expect(withoutAcls).not.toMatch(/format\s*\(|quote_ident|quote_literal/i);
    expect(executable).not.toMatch(/CREATE\s+TRIGGER|CREATE\s+EVENT\s+TRIGGER/i);
  });

  it('completes every validation before the first durable write', () => {
    const body = persistBody.slice(0, persistBody.indexOf('\nEXCEPTION'));
    expect(body.length).toBeGreaterThan(0);
    const firstInsert = body.indexOf('INSERT INTO public.assistive_validation_runs');
    const validationLoopEnd = body.indexOf('END LOOP;');
    const lastRejection = body.lastIndexOf("'VALIDATION_FAILED'");
    const projectGuard = body.indexOf("'PROJECT_NOT_FOUND'");
    const permissionGuard = body.indexOf("'PERMISSION_DENIED'");
    const idempotencyRead = body.indexOf("'ALREADY_PERSISTED'");

    for (const index of [firstInsert, validationLoopEnd, lastRejection, projectGuard, permissionGuard, idempotencyRead]) {
      expect(index).toBeGreaterThan(-1);
    }
    // A plpgsql RETURN does not undo rows already written, so every rejection must precede writing.
    expect(permissionGuard).toBeLessThan(firstInsert);
    expect(projectGuard).toBeLessThan(firstInsert);
    expect(validationLoopEnd).toBeLessThan(firstInsert);
    expect(lastRejection).toBeLessThan(firstInsert);
    expect(idempotencyRead).toBeLessThan(firstInsert);
    // Findings are only ever written after the run they belong to.
    expect(firstInsert).toBeLessThan(body.indexOf('INSERT INTO public.assistive_validation_findings'));
  });

  it('serializes concurrent attempts and converges only for an exact completed retry', () => {
    const compactPersist = persistBody.replace(/\s+/g, ' ');
    expect(compactPersist).toContain(
      "PERFORM pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtext(p_project_id::text || ':' || v_input_hash || ':' || v_pipeline_version) )",
    );
    const lock = compactPersist.indexOf('pg_advisory_xact_lock');
    const idempotencyRead = compactPersist.indexOf('FROM public.assistive_validation_runs AS r WHERE r.project_id = p_project_id');
    expect(lock).toBeGreaterThan(-1);
    expect(idempotencyRead).toBeGreaterThan(lock);
    expect(compactPersist).toContain('EXCEPTION WHEN unique_violation THEN');
    expect(compactPersist.match(/v_existing_findings IS DISTINCT FROM p_findings/g)).toHaveLength(2);
    expect(compactPersist.match(/v_status <> 'COMPLETED'/g)).toHaveLength(2);
    expect(compactPersist.match(/'resultCode', 'IDENTITY_CONFLICT'/g)).toHaveLength(2);
    expect(compactPersist.match(/'resultCode', 'ALREADY_PERSISTED'/g)).toHaveLength(2);
    const deterministicProjection = "'checkType', f.check_type, 'outcome', f.outcome, 'classification', f.classification, 'reasonCode', f.reason_code, 'affectedField', f.affected_field, 'origin', f.origin, 'scoreKind', f.score_kind, 'scoreValue', f.score_value, 'evidence', f.evidence";
    expect(compactPersist.split(deterministicProjection)).toHaveLength(3);
    for (const durableMetadata of ['findingId', 'createdAt', 'disposition', 'reviewedBy', 'reviewedAt']) {
      expect(compactPersist).not.toContain(`'${durableMetadata}'`);
    }
    expect(compactPersist.match(/ORDER BY f\.ordinal/g)).toHaveLength(2);
  });

  it('re-proves the actor against a recognized staff role inside the database', () => {
    for (const body of [persistBody, dispositionBody]) {
      expect(body.replace(/\s+/g, ' ')).toContain(
        'FROM public.admin_users AS u JOIN public.user_roles AS r ON r.user_id = u.id WHERE u.id = p_actor_admin_id',
      );
    }
    expect(persistBody.replace(/\s+/g, ' ')).toContain("AND r.role IN ('admin', 'reviewer', 'editor')");
    // Reviewing is the projects.review authority, which an editor-only identity does not hold.
    expect(dispositionBody.replace(/\s+/g, ' ')).toContain("AND r.role IN ('admin', 'reviewer')");
  });

  it('permits exactly one narrow mutation and never rewrites persisted evidence', () => {
    const updates = executable.match(/UPDATE\s+public\.[a-z_]+/gi) ?? [];
    expect(updates).toEqual(['UPDATE public.assistive_validation_findings']);
    expect(dispositionBody.replace(/\s+/g, ' ')).toContain(
      'UPDATE public.assistive_validation_findings SET disposition = v_disposition, reviewed_by = p_actor_admin_id, reviewed_at = pg_catalog.now() WHERE id = p_finding_id',
    );
    for (const immutable of ['evidence', 'outcome', 'reason_code', 'run_id', 'check_type', 'origin', 'score_value', 'input_hash', 'pipeline_version']) {
      expect(dispositionBody).not.toMatch(new RegExp(`SET[^;]*\\b${immutable}\\s*=`, 'i'));
    }
    expect(dispositionBody.replace(/\s+/g, ' ')).toContain("v_disposition NOT IN ('REVIEWED', 'IGNORED')");
  });

  it('returns a bounded read shape that carries no project workflow state', () => {
    expect(readBody).toContain("'resultCode', 'FOUND'");
    expect(readBody).toContain("'resultCode', 'NOT_FOUND'");
    expect(readBody).toContain("'resultCode', 'VALIDATION_FAILED'");
    expect(readBody).not.toMatch(/public\.(projects|approval_records|published_snapshots|media_assets)/i);
    for (const workflow of ['status_project', 'is_public_approved', 'published_at', 'archived_at']) {
      expect(readBody).not.toContain(workflow);
    }
  });

  it('adds no Phase 4 job, queue, or worker coordination surface', () => {
    for (const phase4 of [
      'assistive_validation_jobs', 'SKIP LOCKED', 'lease_until', 'worker_id', 'attempt_count',
      'claim_', 'dequeue', 'enqueue', 'NOTIFY', 'LISTEN', 'pg_cron',
    ]) {
      expect(executable).not.toContain(phase4);
    }
    expect(executable).not.toMatch(/\battempts?\b/i);
    expect(executable).not.toMatch(/'(PENDING|QUEUED|RUNNING|CLAIMED|CANCELLED)'/);
  });
});
