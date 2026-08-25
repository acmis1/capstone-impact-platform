import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migration = (name: string) => fs.readFileSync(path.join(root, 'infra/supabase/migrations', name), 'utf8');
const ledger = migration('20260824180000_public_feed_deployment_ledger.sql');
const protocol = migration('20260824183000_public_feed_writer_protocol.sql');

describe('public deployment ledger migration security contract', () => {
  it('adds the six explicit ledger relations without migration-time Storage I/O', () => {
    for (const table of [
      'public_feed_operations', 'public_feed_versions', 'public_feed_version_members',
      'public_feed_head', 'feed_rollback_preparations', 'public_feed_operation_events',
    ]) {
      expect(ledger).toContain(`CREATE TABLE public.${table}`);
      expect(ledger).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(ledger).not.toMatch(/storage\.objects|storage\.buckets|http_|net\.|supabase\.storage/i);
    expect(ledger).toContain('rollback_enabled boolean NOT NULL DEFAULT false');
  });

  it('stores token hashes only and fences one global writer through recovery', () => {
    expect(ledger).toContain('owner_token_hash text NOT NULL');
    expect(ledger).not.toMatch(/\b(owner_token|execution_token)\s+(?:text|uuid)/);
    expect(ledger).toContain('public_feed_operations_one_blocking_writer_idx');
    expect(ledger).toContain("'RECOVERY_REQUIRED'");
    expect(ledger).toContain('recovery_from_state text');
    expect(protocol).toContain("interval '2 minutes'");
    expect(protocol).toContain("interval '45 seconds'");
    expect(protocol).toContain("interval '120 seconds'");
  });

  it('makes versions, members, and events immutable and table mutation RPC-only', () => {
    for (const table of ['public_feed_versions', 'public_feed_version_members', 'public_feed_operation_events']) {
      expect(ledger).toMatch(new RegExp(`CREATE TRIGGER reject_public_feed_[\\s\\S]*?ON public\\.${table}`));
    }
    expect(ledger.match(/REVOKE ALL PRIVILEGES ON TABLE public\./g)).toHaveLength(6);
    expect(ledger).toContain('GRANT SELECT ON TABLE public.public_feed_operations');
    expect(ledger).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)/);
  });

  it('binds exact canonical bytes and verifier-produced member hashes before write intent', () => {
    expect(protocol).toContain('p_candidate_members jsonb');
    expect(protocol).toContain("'INVALID_MEMBER_MANIFEST'");
    expect(protocol).toContain("member.value->>'recordHash'");
    expect(protocol).toContain('candidate_byte_count = pg_catalog.octet_length(p_candidate_feed_content)');
    expect(protocol).toContain("extensions.digest(pg_catalog.convert_to(p_candidate_feed_content, 'UTF8'), 'sha256')");
  });

  it('sets the exact operation marker before its own publication-side mutations', () => {
    const finalizer = protocol.slice(
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.finalize_public_feed_operation('),
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.complete_public_feed_operation('),
    );
    const marker = finalizer.indexOf("set_config('app.public_feed_operation_id', v_operation.id::text, true)");
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(finalizer.indexOf('UPDATE public.media_assets'));
    expect(marker).toBeLessThan(finalizer.indexOf("UPDATE public.projects SET status = 'published'"));
    expect(protocol).toContain("COALESCE(v_marker, '') <> v_operation_id::text");
  });

  it('proves deployment reconciliation at both the reservation and the durable write-intent boundary', () => {
    const reservation = protocol.slice(
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.reserve_public_feed_operation('),
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.bind_public_feed_operation('),
    );
    const writeIntent = protocol.slice(
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.mark_public_feed_write_started('),
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.mark_public_feed_candidate_observed('),
    );

    // The temporary integration hold is gone, and nothing may reintroduce it.
    expect(protocol).not.toContain('RECONCILIATION_READINESS_REQUIRED');
    expect(protocol).not.toContain('fail-closed integration gate');

    // Both boundaries derive authority from the dedicated reconciliation gate, and each does so
    // strictly before the state it guards.
    for (const boundary of [reservation, writeIntent]) {
      expect(boundary).toContain('public.get_project_reconciliation_readiness(');
      expect(boundary).toContain("v_readiness->>'confirmedPreviewId'");
      expect(boundary).toContain("(v_readiness->>'confirmedAt')::timestamptz");
    }
    expect(reservation.indexOf('public.get_project_reconciliation_readiness('))
      .toBeLessThan(reservation.indexOf('INSERT INTO public.public_feed_operations'));
    expect(writeIntent.indexOf('public.get_project_reconciliation_readiness('))
      .toBeLessThan(writeIntent.indexOf("SET state = 'WRITE_STARTED'"));

    // Reservation binds the exact confirmation evidence into the immutable operation intent, the
    // same way normal publication binds it.
    expect(reservation).toContain("v_project.status <> 'published'");
    expect(reservation).toContain('p_confirmed_preview_id IS NULL');
    expect(reservation).toContain('p_confirmed_at IS NULL');

    // The final boundary independently re-establishes deployment absence and actor authority
    // rather than trusting an earlier TypeScript preflight.
    expect(writeIntent).toContain('public.public_feed_actor_is_admin(p_actor_id)');
    expect(writeIntent).toContain('public.public_feed_owner_valid(');
    expect(writeIntent).toContain('FROM public.public_feed_version_members m');
    expect(writeIntent).toContain("'ALREADY_DEPLOYED'");
    // Once write intent is durable, the mutable drift gate deliberately does not run again.
    expect(writeIntent).toContain('v_operation.storage_request_generation = 0');
  });

  it('keeps normal publication readiness strictly approved-only and separate from reconciliation', () => {
    const reconciliation = protocol.slice(
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.get_project_reconciliation_readiness('),
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.mark_public_feed_write_started('),
    );

    // A separate authority, not a relaxed one: the normal gate is never redefined here.
    expect(protocol).not.toContain('CREATE OR REPLACE FUNCTION public.get_project_publication_readiness(');
    expect(reconciliation).toContain("v_project.status <> 'published'");
    expect(reconciliation).toContain("SET search_path = ''");
    expect(reconciliation).toContain('SECURITY DEFINER');

    // Participant confirmation is proved from stored preview evidence, never from project.status,
    // the old public feed, or current public URLs.
    expect(reconciliation).toContain('public.participant_preview_confirmations');
    expect(reconciliation).toContain("pp.status = 'active'");
    expect(reconciliation).toContain("r.status IN ('open', 'in_progress')");
    expect(reconciliation).toContain('v_active_preview.snapshot');
    expect(reconciliation).toContain('v_active_preview.media_snapshot');
    expect(reconciliation).toContain("'PROJECT_SNAPSHOT_STALE'");
    expect(reconciliation).toContain("'MEDIA_SNAPSHOT_STALE'");

    // Gallery identity is authoritative: position and per-image alt text are part of the compared
    // immutable evidence, so add, remove, reorder and alt-text drift are all visible.
    expect(reconciliation).toContain("'galleryPosition',");
    expect(reconciliation).toContain("'altText', ma.alt_text_public");
    expect(reconciliation).toContain('ma.gallery_position BETWEEN 1 AND 10');
    expect(reconciliation).toContain('v_snapshot_total_count > 10');

    // Expected publication mappings are proved coherent rather than treated as content drift.
    expect(reconciliation).toContain("'PUBLISHED_MEDIA_MAPPING_INVALID'");
    expect(reconciliation).toContain("'published/' || v_project.public_id || '/' || ma.asset_type || '/' || ma.file_name");

    expect(protocol).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_project_reconciliation_readiness\(text, uuid, text\) TO service_role;/,
    );
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(protocol).toContain(
        `REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM ${role};`,
      );
    }
  });

  it('re-asserts an already-promoted reconciliation media mapping idempotently and never overwrites a different one', () => {
    const finalizer = protocol.slice(
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.finalize_public_feed_operation('),
      protocol.indexOf('CREATE OR REPLACE FUNCTION public.complete_public_feed_operation('),
    );
    expect(finalizer).toContain("v_operation.publication_mode = 'deployment_reconciliation'");
    expect(finalizer).toContain("public_storage_bucket IS NOT DISTINCT FROM v_manifest_item->>'publicBucket'");
    expect(finalizer).toContain("public_storage_path IS NOT DISTINCT FROM v_manifest_item->>'publicPath'");
    expect(finalizer).toContain("public_url IS NOT DISTINCT FROM v_manifest_item->>'publicUrl'");
    expect(finalizer).toContain("'MEDIA_MANIFEST_STALE'");

    // Reconciliation changes no lifecycle state and writes no publish audit.
    expect(finalizer).toContain("IF v_operation.publication_mode = 'normal' THEN");
    expect(finalizer.indexOf("IF v_operation.publication_mode = 'normal' THEN"))
      .toBeLessThan(finalizer.indexOf("UPDATE public.projects SET status = 'published'"));
    expect(finalizer.indexOf("IF v_operation.publication_mode = 'normal' THEN"))
      .toBeLessThan(finalizer.indexOf('INSERT INTO public.approval_records'));
  });

  it('keeps every application RPC service-role-only with pinned search paths', () => {
    const functions = [...protocol.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\([\s\S]*?\$\$;/g)];
    expect(functions.length).toBeGreaterThanOrEqual(16);
    for (const match of functions) expect(match[0]).toContain("SET search_path = ''");
    for (const name of [
      'reserve_public_feed_operation', 'bind_public_feed_operation',
      'mark_public_feed_write_started', 'mark_public_feed_candidate_observed',
      'claim_public_feed_operation', 'finalize_public_feed_operation',
      'complete_public_feed_operation', 'require_public_feed_recovery',
      'prepare_public_feed_rollback',
    ]) {
      expect(protocol).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*? FROM PUBLIC, anon, authenticated;`));
      expect(protocol).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*? TO service_role;`));
    }
  });

  it('fails the legacy writer family closed and never introduces baseline compensation', () => {
    expect(protocol.match(/'LEDGER_PROTOCOL_REQUIRED'/g)).toHaveLength(12);
    expect(protocol).not.toContain('UPDATE public.publication_attempts');
    expect(protocol).not.toContain('UPDATE public.public_removal_attempts');
    expect(protocol).toContain("WHEN v_operation.recovery_from_state = 'DB_FINALIZED' THEN 'DB_FINALIZED'");
  });
});
