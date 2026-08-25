import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('bulk project review concurrency migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migration = fs.readFileSync(
    path.join(root, 'infra/supabase/migrations/20260824120000_bulk_project_review_concurrency.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('defines a service-role-only, search-path-hardened wrapper', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.perform_project_workflow_action_if_current');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.perform_project_workflow_action_if_current(text, text, text, uuid, timestamptz)');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.perform_project_workflow_action_if_current(text, text, text, uuid, timestamptz)');
    expect(migration).toContain('TO service_role;');
  });

  it('checks permissions, target convergence, then the expected version before delegation', () => {
    const permission = migration.indexOf("BULK_REVIEW_PERMISSION_DENIED");
    const alreadyComplete = migration.indexOf("'ALREADY_COMPLETE'");
    const stale = migration.indexOf("'STALE_VERSION'");
    const delegation = migration.indexOf('public.perform_project_review_action');
    expect(permission).toBeGreaterThan(-1);
    expect(alreadyComplete).toBeGreaterThan(permission);
    expect(stale).toBeGreaterThan(alreadyComplete);
    expect(delegation).toBeGreaterThan(stale);
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("pg_advisory_xact_lock(pg_catalog.hashtext(v_batch_id::text))");
    expect(migration).toContain("pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id))");
    expect(migration).toContain('pg_catalog.length(v_comments) > 4000');
    expect(migration).toContain("p_action = 'request_changes' AND v_comments IS NULL");
  });

  it('normalizes historical review RPC success and returns authoritative blocked status', () => {
    expect(migration).toContain("'resultCode', 'SUCCESS'");
    expect(migration).toContain("v_result->>'auditRecordId' IS NOT NULL");
    expect(migration).toContain("'resultCode', 'BLOCKED'");
    expect(migration).toContain("'status', v_status");
    expect(migration).toContain("'reasonCode', v_reason_code");
    expect(migration).toContain('get_bulk_project_review_evidence');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_bulk_project_review_evidence(uuid[])');
  });

  it('reports the workflow authority rule code instead of one generic blocked code', () => {
    const handlers = migration.match(/EXCEPTION WHEN OTHERS THEN/g) ?? [];
    expect(handlers).toHaveLength(2);
    // Both delegation handlers derive the reason from the authority's own raised token.
    expect(
      migration.match(/pg_catalog\.split_part\(SQLERRM, ' ', 1\)/g) ?? [],
    ).toHaveLength(2);
    expect(migration.match(/'\[\^A-Z0-9_\]', '', 'g'/g) ?? []).toHaveLength(2);
    expect(migration.match(/, 80\), ''\), 'WORKFLOW_BLOCKED'\)/g) ?? []).toHaveLength(2);
  });

  it('re-raises anything that is not an explicit workflow rule violation', () => {
    // A deadlock, serialization failure, or constraint violation must not be reported to staff as
    // a workflow decision; it has to surface as a failed project instead.
    expect(migration.match(/IF SQLSTATE <> 'P0001' THEN RAISE; END IF;/g) ?? []).toHaveLength(2);
  });

  it('adds no competing definition of the existing workflow authorities', () => {
    // Binh's wrapper delegates rather than redefining, so a later migration that replaces
    // perform_project_review_action (for example the pending multi-image gallery approval gate)
    // composes with bulk review instead of being overwritten by it.
    expect(migration).not.toContain('FUNCTION public.perform_project_review_action(');
    expect(migration).not.toContain('FUNCTION public.submit_import_projects_for_review(');
    expect(migration).toContain('public.perform_project_review_action(');
    expect(migration).toContain('public.submit_import_projects_for_review(');
  });

  it('keeps the wrapper before Tan\'s final gallery submission authority in the fresh-install sequence', () => {
    const migrations = fs.readdirSync(path.join(root, 'infra/supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const wrapperIndex = migrations.indexOf('20260824120000_bulk_project_review_concurrency.sql');
    const finalSubmissionIndex = migrations.indexOf('20260825025000_multi_image_gallery_review_submission.sql');
    const finalSubmission = fs.readFileSync(
      path.join(root, 'infra/supabase/migrations/20260825025000_multi_image_gallery_review_submission.sql'),
      'utf8',
    );

    expect(migrations).toHaveLength(42);
    expect(wrapperIndex).toBeGreaterThan(-1);
    // The deployment-ledger stream lands between the bulk-review wrapper and Tan's final gallery
    // submission authority, so the wrapper still precedes it with exactly those two files between.
    expect(migrations.slice(wrapperIndex + 1, finalSubmissionIndex)).toEqual([
      '20260824180000_public_feed_deployment_ledger.sql',
      '20260824183000_public_feed_writer_protocol.sql',
    ]);
    expect(finalSubmissionIndex).toBe(wrapperIndex + 3);
    expect(finalSubmission).toContain('CREATE OR REPLACE FUNCTION public.submit_import_projects_for_review');
    expect(finalSubmission).toContain('INVALID_SNAPSHOT_GALLERY_STRUCTURE');
  });

  it('does not add a competing audit write or production media/publication behavior', () => {
    expect(migration).not.toContain('INSERT INTO public.approval_records');
    expect(migration).not.toContain('UPDATE public.media_assets');
    expect(migration).not.toContain('published_snapshots');
    expect(migration).not.toContain('http://');
    expect(migration).not.toContain('https://');
  });
});
