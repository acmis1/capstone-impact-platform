-- Migration 0048: PostgreSQL 17 MAINTAIN privilege alignment.
--
-- This migration changes no schema, no policy, no routine, no ownership and no role membership.
-- It corrects exactly one cross-engine privilege drift and nothing else.
--
-- PostgreSQL 17 introduced the per-table MAINTAIN privilege (VACUUM, ANALYZE, CLUSTER, REINDEX,
-- REFRESH MATERIALIZED VIEW, LOCK TABLE). MAINTAIN is included in ALL. Five historical migrations
-- were authored and reviewed against PostgreSQL 15, where "GRANT ALL ... TO service_role" meant
-- exactly SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER:
--
--   20260810090000_atomic_browser_import_metadata_stage.sql  public.browser_import_commits
--   20260810120000_atomic_browser_import_media_stage.sql     public.browser_import_media_commits
--   20260810180000_participant_preview_links.sql             public.participant_previews
--   20260811090000_participant_preview_confirmations.sql     public.participant_preview_confirmations
--   20260811120000_participant_preview_correction_requests.sql
--                                                            public.participant_preview_correction_requests
--
-- Replaying those same statements on a PostgreSQL 17 server silently widens the reviewed contract
-- by one privilege the application never asked for. No repository code path issues VACUUM, ANALYZE,
-- REINDEX, CLUSTER, REFRESH MATERIALIZED VIEW or an explicit LOCK TABLE against these relations,
-- and service_role is not a member of pg_maintain, so the widened privilege is unused reach.
--
-- The intended invariant is therefore engine-independent:
--
--   PostgreSQL 17+ result == the PostgreSQL 15 meaning of the historical GRANT ALL statements
--
-- Deliberately out of scope: whether TRUNCATE, REFERENCES or TRIGGER should themselves be narrowed
-- is a separate least-privilege audit. Combining that policy change with this compatibility fix
-- would make the diff impossible to review as a version-alignment correction.
--
-- Cross-version safety: PostgreSQL 15 and 16 cannot parse the MAINTAIN privilege keyword, so the
-- REVOKE is held in a string that is only ever parsed when a server that understands it executes
-- it. server_version_num is a deterministic integer set by the server itself, so the branch is not
-- configuration. There is no exception handler: on a PostgreSQL 17+ server a missing role or a
-- missing table must fail the migration rather than let it report an alignment it did not perform.

BEGIN;

DO $postgres17_maintain_alignment$
DECLARE
  aligned_table text;
  aligned_tables constant text[] := ARRAY[
    'browser_import_commits',
    'browser_import_media_commits',
    'participant_previews',
    'participant_preview_confirmations',
    'participant_preview_correction_requests'
  ];
BEGIN
  -- PostgreSQL 15 and 16 never granted MAINTAIN, so there is nothing to align and nothing below
  -- may be parsed. Existing privileges on those servers are left exactly as the historical
  -- migrations established them.
  IF pg_catalog.current_setting('server_version_num')::integer >= 170000 THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS grantee WHERE grantee.rolname = 'service_role'
    ) THEN
      RAISE EXCEPTION
        'PostgreSQL 17 MAINTAIN alignment refused: expected role service_role does not exist.';
    END IF;

    FOREACH aligned_table IN ARRAY aligned_tables LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = aligned_table
          AND relation.relkind = 'r'
      ) THEN
        RAISE EXCEPTION
          'PostgreSQL 17 MAINTAIN alignment refused: expected table public.% does not exist.',
          aligned_table;
      END IF;
    END LOOP;

    -- Exactly one privilege, exactly one role, exactly these five tables. REVOKE is naturally
    -- convergent, so re-running this migration body on an already-aligned server is a no-op.
    EXECUTE 'REVOKE MAINTAIN ON TABLE '
      || 'public.browser_import_commits, '
      || 'public.browser_import_media_commits, '
      || 'public.participant_previews, '
      || 'public.participant_preview_confirmations, '
      || 'public.participant_preview_correction_requests '
      || 'FROM service_role';
  END IF;
END;
$postgres17_maintain_alignment$;

COMMIT;
