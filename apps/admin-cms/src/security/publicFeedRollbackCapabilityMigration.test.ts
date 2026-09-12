import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const filename = '20260910120000_public_feed_rollback_capability.sql';
const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../../infra/supabase/migrations', filename),
  'utf8',
);
const sharedWriterSql = [
  '20260824183000_public_feed_writer_protocol.sql',
  '20260906120000_public_removal_completion_reconciliation.sql',
  filename,
].map((migration) => fs.readFileSync(
  path.resolve(__dirname, '../../../../infra/supabase/migrations', migration),
  'utf8',
)).join('\n');
const actorGuard = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.public_feed_actor_is_admin('),
  sql.indexOf('-- The raw head bit preserves'),
);
const transition = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.transition_public_feed_rollback_capability('),
  sql.indexOf('-- Staging preparation is atomic'),
);
const stagingPreparation = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.prepare_verified_staging_public_feed_rollback('),
  sql.indexOf('-- Staging execution accepts'),
);
const stagingReservation = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.reserve_verified_staging_public_feed_rollback('),
  sql.indexOf('-- Readiness can now distinguish'),
);

describe(filename, () => {
  it('is additive and leaves every existing application row unchanged on apply', () => {
    expect(sql).toContain('CREATE TABLE public.public_feed_rollback_capability_events');
    expect(sql).toContain('sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE');
    expect(sql).toContain('CREATE TABLE public.public_feed_rollback_preparation_capabilities');
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|CONSTRAINT)/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION')))
      .not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\./i);
    expect(sql).not.toMatch(/storage\.objects|storage\.buckets|http_|net\.|supabase\.storage/i);
  });

  it('serializes exact-head transitions against every active or recovery writer family', () => {
    expect(transition).toContain('public.public_feed_actor_is_admin(p_admin_id)');
    expect(transition).toContain("pg_catalog.hashtext('public_feed_canonical_writer')");
    expect(transition.indexOf('public.public_feed_actor_is_admin(p_admin_id)'))
      .toBeLessThan(transition.indexOf("pg_catalog.hashtext('public_feed_canonical_writer')"));
    expect(transition).toContain('FROM public.public_feed_head');
    expect(transition).toContain('FOR UPDATE;');
    expect(transition).toContain('v_version.version_number IS DISTINCT FROM p_expected_version_number');
    expect(transition).toContain('v_head.generation IS DISTINCT FROM p_expected_generation');
    expect(transition).toContain('v_version.feed_hash IS DISTINCT FROM p_expected_feed_hash');
    expect(transition).toContain('v_version.record_count IS DISTINCT FROM p_expected_record_count');
    for (const state of [
      'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED',
    ]) expect(transition).toContain(`'${state}'`);
    expect(transition).toContain("o.state = 'RECOVERY_REQUIRED'");
    expect(transition.match(/a\.state = 'compensation_failed'/g)).toHaveLength(2);
  });

  it('requires an active lifecycle administrator under a row lock', () => {
    expect(actorGuard).toContain("pg_catalog.hashtextextended('capstone.staff_lifecycle_admin_invariant', 0)");
    expect(actorGuard).toContain("au.lifecycle_status = 'active'");
    expect(actorGuard).toContain('au.auth_user_id IS NOT NULL');
    expect(actorGuard).toContain("ur.role = 'admin'");
    expect(actorGuard).toContain("request.status = 'pending_activation'");
    expect(actorGuard).toMatch(/FROM public\.admin_users au[\s\S]*?FOR SHARE;/);
  });

  it('keeps lifecycle authorization before the canonical lock in every shared writer entry point', () => {
    const guardedWriters = [...sharedWriterSql.matchAll(
      /CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\([\s\S]*?\n\$\$;/g,
    )].filter((match) => match[0].includes('public_feed_actor_is_admin')
      && match[0].includes("hashtext('public_feed_canonical_writer')"));
    expect(guardedWriters.length).toBeGreaterThan(5);
    for (const writer of guardedWriters) {
      expect(
        writer[0].indexOf('public_feed_actor_is_admin'),
        `${writer[1]} takes the canonical writer lock before lifecycle authority`,
      ).toBeLessThan(writer[0].indexOf("hashtext('public_feed_canonical_writer')"));
    }
  });

  it('expires staging authority when the exact head event is absent or superseded', () => {
    expect(transition).toContain('p_require_exact_head_event boolean');
    expect(transition).toContain('public.current_public_feed_rollback_capability_event() IS NOT NULL');
    expect(sql).toContain('ORDER BY candidate.sequence DESC');
    expect(stagingPreparation).toContain('public.current_public_feed_rollback_capability_event()');
    expect(stagingPreparation).toContain('INSERT INTO public.public_feed_rollback_preparation_capabilities');
    expect(stagingReservation).toContain('binding.capability_event_id');
    expect(stagingReservation).toContain(
      'v_current_capability_event_id IS DISTINCT FROM v_bound_capability_event_id',
    );
    expect(stagingReservation).toContain('public.reserve_public_feed_operation(');
  });

  it('requires the exact typed transition confirmation and records only a truthful real change', () => {
    expect(transition).toContain("CASE WHEN p_enabled THEN 'ENABLE' ELSE 'DISABLE' END");
    expect(transition).toContain("' PUBLIC FEED ROLLBACK FOR VERSION '");
    expect(transition).toContain("' GENERATION '");
    expect(transition).toContain("' HASH '");
    expect(transition).toContain("' COUNT '");
    expect(transition.indexOf("'CONFIRMATION_MISMATCH'"))
      .toBeLessThan(transition.indexOf('UPDATE public.public_feed_head'));
    expect(transition.indexOf("'NO_CHANGE'"))
      .toBeLessThan(transition.indexOf('UPDATE public.public_feed_head'));
    expect(transition).toContain('previous_enabled');
    expect(transition).toContain('confirmation_digest');
    expect(transition.indexOf('UPDATE public.public_feed_head'))
      .toBeLessThan(transition.indexOf('INSERT INTO public.public_feed_rollback_capability_events'));
  });

  it('makes the audit append-only and exposes mutation only through the service role RPC', () => {
    expect(sql).toContain('ALTER TABLE public.public_feed_rollback_capability_events ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE public.public_feed_rollback_capability_events FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE TRIGGER reject_public_feed_rollback_capability_event_mutation');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain('CREATE INDEX public_feed_rollback_capability_events_actor_idx');
    expect(sql).toContain('CREATE INDEX public_feed_rollback_capability_events_head_version_idx');
    expect(sql).toContain('CREATE INDEX public_feed_rollback_preparation_capabilities_event_idx');
    expect(sql).toContain('CREATE TRIGGER reject_public_feed_rollback_preparation_capability_mutation');
    expect(sql).toContain('ALTER TABLE public.public_feed_rollback_preparation_capabilities FORCE ROW LEVEL SECURITY;');
    expect(sql).toMatch(/REVOKE ALL PRIVILEGES ON TABLE public\.public_feed_rollback_capability_events[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.public_feed_rollback_capability_events,[\s\S]*?public\.public_feed_rollback_preparation_capabilities TO service_role;/);
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|ALL).*public_feed_rollback_capability_events/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.transition_public_feed_rollback_capability\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.transition_public_feed_rollback_capability\([\s\S]*?TO service_role;/);
    for (const rpc of [
      'prepare_verified_staging_public_feed_rollback',
      'reserve_verified_staging_public_feed_rollback',
    ]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([\\s\\S]*?TO service_role;`));
    }
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.current_public_feed_rollback_capability_event\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/);
    expect(transition).toContain('SECURITY DEFINER');
    expect(transition).toContain("SET search_path = ''");
  });
});
