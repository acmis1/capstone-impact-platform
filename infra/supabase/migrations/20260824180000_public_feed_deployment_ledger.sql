-- Issue #186: immutable public deployment ledger foundation.
-- Storage I/O is deliberately absent from this migration. Activation is a separately invoked,
-- governed operation after the application has verified exact canonical Storage bytes.

BEGIN;

CREATE TABLE public.public_feed_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('activation', 'publication', 'removal', 'rollback')),
  publication_mode text CHECK (publication_mode IS NULL OR publication_mode IN ('normal', 'deployment_reconciliation')),
  authorizing_actor_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  completion_actor_id uuid REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  public_id text CHECK (public_id IS NULL OR (pg_catalog.length(public_id) BETWEEN 1 AND 100 AND public_id ~ '^[A-Za-z0-9_-]+$')),
  rollback_preparation_id uuid,
  legacy_publication_attempt_id uuid REFERENCES public.publication_attempts(id) ON DELETE SET NULL,
  legacy_removal_attempt_id uuid REFERENCES public.public_removal_attempts(id) ON DELETE SET NULL,
  baseline_version_id uuid,
  baseline_storage_existed boolean,
  baseline_feed_hash text CHECK (baseline_feed_hash IS NULL OR baseline_feed_hash ~ '^[0-9a-f]{64}$'),
  baseline_record_count integer CHECK (baseline_record_count IS NULL OR baseline_record_count >= 0),
  baseline_feed_content text CHECK (baseline_feed_content IS NULL OR pg_catalog.octet_length(baseline_feed_content) <= 10485760),
  candidate_feed_hash text CHECK (candidate_feed_hash IS NULL OR candidate_feed_hash ~ '^[0-9a-f]{64}$'),
  candidate_record_count integer CHECK (candidate_record_count IS NULL OR candidate_record_count >= 0),
  candidate_byte_count integer CHECK (candidate_byte_count IS NULL OR candidate_byte_count BETWEEN 0 AND 10485760),
  candidate_feed_content text CHECK (candidate_feed_content IS NULL OR pg_catalog.octet_length(candidate_feed_content) <= 10485760),
  candidate_members jsonb CHECK (candidate_members IS NULL OR pg_catalog.jsonb_typeof(candidate_members) = 'array'),
  storage_bucket text CHECK (storage_bucket IS NULL OR pg_catalog.btrim(storage_bucket) <> ''),
  storage_path text CHECK (storage_path IS NULL OR pg_catalog.btrim(storage_path) <> ''),
  feed_public_url text CHECK (feed_public_url IS NULL OR pg_catalog.btrim(feed_public_url) <> ''),
  private_media_bucket text,
  confirmed_preview_id uuid REFERENCES public.participant_previews(id) ON DELETE RESTRICT,
  confirmed_at timestamptz,
  archive_reason text CHECK (archive_reason IS NULL OR pg_catalog.length(archive_reason) BETWEEN 1 AND 4000),
  media_manifest jsonb CHECK (media_manifest IS NULL OR pg_catalog.jsonb_typeof(media_manifest) = 'array'),
  rollback_capability_requested boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN (
    'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED',
    'DB_FINALIZED', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'
  )),
  owner_epoch bigint NOT NULL DEFAULT 1 CHECK (owner_epoch > 0),
  owner_token_hash text NOT NULL CHECK (owner_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz NOT NULL,
  storage_request_generation integer NOT NULL DEFAULT 0 CHECK (storage_request_generation >= 0),
  storage_request_started_at timestamptz,
  storage_request_deadline_at timestamptz,
  storage_uncertainty_until timestamptz,
  observed_storage_hash text CHECK (observed_storage_hash IS NULL OR observed_storage_hash ~ '^[0-9a-f]{64}$'),
  observed_storage_record_count integer CHECK (observed_storage_record_count IS NULL OR observed_storage_record_count >= 0),
  recovery_from_state text CHECK (recovery_from_state IS NULL OR recovery_from_state IN (
    'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED'
  )),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  finalized_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT public_feed_operation_mode_coherent CHECK (
    (kind = 'publication' AND publication_mode IS NOT NULL)
    OR (kind <> 'publication' AND publication_mode IS NULL)
  ),
  CONSTRAINT public_feed_operation_candidate_binding_coherent CHECK (
    (candidate_feed_content IS NULL AND candidate_feed_hash IS NULL AND candidate_record_count IS NULL AND candidate_byte_count IS NULL AND candidate_members IS NULL)
    OR (candidate_feed_content IS NOT NULL AND candidate_feed_hash IS NOT NULL AND candidate_record_count IS NOT NULL AND candidate_byte_count IS NOT NULL AND candidate_members IS NOT NULL)
  ),
  CONSTRAINT public_feed_operation_baseline_binding_coherent CHECK (
    (baseline_storage_existed IS NULL AND baseline_feed_content IS NULL AND baseline_feed_hash IS NULL AND baseline_record_count IS NULL)
    OR (baseline_storage_existed = false AND baseline_feed_content IS NULL AND baseline_feed_hash IS NULL AND baseline_record_count IS NULL)
    OR (baseline_storage_existed = true AND baseline_feed_content IS NOT NULL AND baseline_feed_hash IS NOT NULL AND baseline_record_count IS NOT NULL)
  ),
  CONSTRAINT public_feed_operation_terminal_coherent CHECK (
    (state = 'COMPLETED' AND completed_at IS NOT NULL AND failed_at IS NULL)
    OR (state = 'FAILED' AND failed_at IS NOT NULL AND failure_code IS NOT NULL AND completed_at IS NULL)
    OR (state = 'RECOVERY_REQUIRED' AND failure_code IS NOT NULL AND completed_at IS NULL)
    OR state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED')
  )
);

CREATE UNIQUE INDEX public_feed_operations_one_blocking_writer_idx
  ON public.public_feed_operations ((true))
  WHERE state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED');
CREATE INDEX public_feed_operations_project_idx ON public.public_feed_operations(project_id, created_at DESC);

CREATE TABLE public.public_feed_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  operation text NOT NULL CHECK (operation IN ('baseline', 'publication', 'removal', 'rollback')),
  publication_mode text CHECK (publication_mode IS NULL OR publication_mode IN ('normal', 'deployment_reconciliation')),
  operation_id uuid NOT NULL UNIQUE REFERENCES public.public_feed_operations(id) ON DELETE RESTRICT,
  previous_version_id uuid REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT,
  restored_from_version_id uuid REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  affected_public_id text CHECK (affected_public_id IS NULL OR (pg_catalog.length(affected_public_id) BETWEEN 1 AND 100 AND affected_public_id ~ '^[A-Za-z0-9_-]+$')),
  authorizing_actor_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  completion_actor_id uuid REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  artifact_content text NOT NULL CHECK (pg_catalog.octet_length(artifact_content) <= 10485760),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 0 AND 10485760),
  feed_hash text NOT NULL CHECK (feed_hash ~ '^[0-9a-f]{64}$'),
  record_count integer NOT NULL CHECK (record_count >= 0),
  published_snapshot_id uuid REFERENCES public.published_snapshots(id) ON DELETE SET NULL,
  audit_record_id uuid REFERENCES public.approval_records(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT public_feed_version_mode_coherent CHECK (
    (operation = 'publication' AND publication_mode IS NOT NULL)
    OR (operation <> 'publication' AND publication_mode IS NULL)
  ),
  CONSTRAINT public_feed_version_bytes_coherent CHECK (byte_count = pg_catalog.octet_length(artifact_content))
);

CREATE TABLE public.public_feed_version_members (
  version_id uuid NOT NULL REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  public_id text NOT NULL CHECK (pg_catalog.length(public_id) BETWEEN 1 AND 100 AND public_id ~ '^[A-Za-z0-9_-]+$'),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (version_id, ordinal),
  UNIQUE (version_id, public_id)
);

CREATE TABLE public.public_feed_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  current_version_id uuid NOT NULL UNIQUE REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  activated_by_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  transitioned_by_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  transitioned_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  rollback_enabled boolean NOT NULL DEFAULT false,
  last_operation_id uuid NOT NULL UNIQUE REFERENCES public.public_feed_operations(id) ON DELETE RESTRICT
);

CREATE TABLE public.feed_rollback_preparations (
  handle uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  target_version_id uuid NOT NULL REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT,
  target_feed_hash text NOT NULL CHECK (target_feed_hash ~ '^[0-9a-f]{64}$'),
  target_record_count integer NOT NULL CHECK (target_record_count >= 0),
  baseline_version_id uuid NOT NULL REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT,
  baseline_feed_hash text NOT NULL CHECK (baseline_feed_hash ~ '^[0-9a-f]{64}$'),
  baseline_record_count integer NOT NULL CHECK (baseline_record_count >= 0),
  diff_evidence jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(diff_evidence) = 'object'),
  lifecycle_drift jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(lifecycle_drift) = 'object'),
  acknowledgement_digest text NOT NULL CHECK (acknowledgement_digest ~ '^[0-9a-f]{64}$'),
  operation_key uuid NOT NULL UNIQUE,
  operation_id uuid UNIQUE REFERENCES public.public_feed_operations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT feed_rollback_preparation_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

ALTER TABLE public.public_feed_operations
  ADD CONSTRAINT public_feed_operations_rollback_preparation_fkey
  FOREIGN KEY (rollback_preparation_id) REFERENCES public.feed_rollback_preparations(handle) ON DELETE RESTRICT,
  ADD CONSTRAINT public_feed_operations_baseline_version_fkey
  FOREIGN KEY (baseline_version_id) REFERENCES public.public_feed_versions(id) ON DELETE RESTRICT;

CREATE TABLE public.public_feed_operation_events (
  operation_id uuid NOT NULL REFERENCES public.public_feed_operations(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  from_state text,
  to_state text NOT NULL CHECK (to_state IN (
    'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED',
    'DB_FINALIZED', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'
  )),
  actor_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  observed_storage_hash text CHECK (observed_storage_hash IS NULL OR observed_storage_hash ~ '^[0-9a-f]{64}$'),
  observed_storage_record_count integer CHECK (observed_storage_record_count IS NULL OR observed_storage_record_count >= 0),
  code text CHECK (code IS NULL OR code ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (operation_id, sequence)
);

CREATE OR REPLACE FUNCTION public.reject_public_feed_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'PUBLIC_FEED_IMMUTABLE_HISTORY';
END;
$$;

CREATE TRIGGER reject_public_feed_version_mutation
  BEFORE UPDATE OR DELETE ON public.public_feed_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_public_feed_immutable_mutation();
CREATE TRIGGER reject_public_feed_member_mutation
  BEFORE UPDATE OR DELETE ON public.public_feed_version_members
  FOR EACH ROW EXECUTE FUNCTION public.reject_public_feed_immutable_mutation();
CREATE TRIGGER reject_public_feed_event_mutation
  BEFORE UPDATE OR DELETE ON public.public_feed_operation_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_public_feed_immutable_mutation();

ALTER TABLE public.public_feed_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_version_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_rollback_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_operation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_all_public_feed_operations ON public.public_feed_operations FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY admin_all_public_feed_versions ON public.public_feed_versions FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY admin_all_public_feed_version_members ON public.public_feed_version_members FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY admin_all_public_feed_head ON public.public_feed_head FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY admin_all_feed_rollback_preparations ON public.feed_rollback_preparations FOR ALL TO authenticated USING (false) WITH CHECK (false);
CREATE POLICY admin_all_public_feed_operation_events ON public.public_feed_operation_events FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.public_feed_operations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.public_feed_versions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.public_feed_version_members FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.public_feed_head FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.feed_rollback_preparations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.public_feed_operation_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.public_feed_operations, public.public_feed_versions,
  public.public_feed_version_members, public.public_feed_head,
  public.feed_rollback_preparations, public.public_feed_operation_events TO service_role;

REVOKE ALL ON FUNCTION public.reject_public_feed_immutable_mutation() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
