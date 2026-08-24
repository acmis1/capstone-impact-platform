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
    expect(migration).toContain("'reasonCode', 'WORKFLOW_BLOCKED'");
    expect(migration).toContain('get_bulk_project_review_evidence');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.get_bulk_project_review_evidence(uuid[])');
  });

  it('does not add a competing audit write or production media/publication behavior', () => {
    expect(migration).not.toContain('INSERT INTO public.approval_records');
    expect(migration).not.toContain('UPDATE public.media_assets');
    expect(migration).not.toContain('published_snapshots');
    expect(migration).not.toContain('http://');
    expect(migration).not.toContain('https://');
  });
});
