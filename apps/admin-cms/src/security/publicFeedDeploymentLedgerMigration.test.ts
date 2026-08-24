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
