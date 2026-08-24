-- Public Feed Version History, Immutable Backup, and Controlled Local Rollback
--
-- Guarantees:
--   * Historical feed versions are immutable evidence.
--   * Every version carries exact artifact bytes + SHA-256 + record count.
--   * Rollback never rewrites historical versions.
--   * Rollback produces a NEW feed version.
--   * Rollback does not mutate project lifecycle state.
--   * Publication, removal and rollback share controlled_publication_global.
--   * Rollback execution is recoverable through durable lease ownership.
--   * Zero-record feeds are supported.
--
-- NOTE:
-- Publication/removal finalization integration is added separately so history
-- creation can be made atomic with their existing finalization transactions.

BEGIN;

-- ============================================================
-- 1. IMMUTABLE PUBLIC FEED VERSION HISTORY
-- ============================================================

CREATE TABLE public.public_feed_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Staff-facing stable sequence number. The UI should show this
  -- instead of the internal UUID.
  version_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,

  operation_type text NOT NULL
    CHECK (operation_type IN ('publication', 'removal', 'rollback')),

  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),

  actor_admin_id uuid NOT NULL
    REFERENCES public.admin_users(id)
    ON DELETE RESTRICT,

  -- Optional affected project for publication/removal.
  -- Rollback is a feed-level operation and deliberately does not
  -- pretend that a project lifecycle transition occurred.
  affected_project_id uuid
    REFERENCES public.projects(id)
    ON DELETE RESTRICT,

  affected_public_id text
    CHECK (
      affected_public_id IS NULL
      OR (
        pg_catalog.length(affected_public_id) BETWEEN 1 AND 100
        AND affected_public_id ~ '^[A-Za-z0-9_-]+$'
      )
    ),

  record_count integer NOT NULL
    CHECK (record_count >= 0),

  feed_hash text NOT NULL
    CHECK (feed_hash ~ '^[0-9a-f]{64}$'),

  -- Exact canonical serialized artifact used for verification/restoration.
  artifact_content text NOT NULL
    CHECK (pg_catalog.octet_length(artifact_content) <= 10485760),

  -- Historical chain.
  previous_version_id uuid
    REFERENCES public.public_feed_versions(id)
    ON DELETE RESTRICT,

  -- Set only when this version was produced by rollback.
  restored_from_version_id uuid
    REFERENCES public.public_feed_versions(id)
    ON DELETE RESTRICT,

  -- Origin evidence.
  origin_publication_attempt_id uuid
    REFERENCES public.publication_attempts(id)
    ON DELETE RESTRICT,

  origin_public_removal_attempt_id uuid
    REFERENCES public.public_removal_attempts(id)
    ON DELETE RESTRICT,

  -- Added FK after rollback_attempts exists.
  origin_rollback_attempt_id uuid,

  CONSTRAINT public_feed_version_operation_evidence CHECK (
    (
      operation_type = 'publication'
      AND origin_publication_attempt_id IS NOT NULL
      AND origin_public_removal_attempt_id IS NULL
      AND origin_rollback_attempt_id IS NULL
      AND restored_from_version_id IS NULL
      AND affected_project_id IS NOT NULL
      AND affected_public_id IS NOT NULL
    )
    OR
    (
      operation_type = 'removal'
      AND origin_publication_attempt_id IS NULL
      AND origin_public_removal_attempt_id IS NOT NULL
      AND origin_rollback_attempt_id IS NULL
      AND restored_from_version_id IS NULL
      AND affected_project_id IS NOT NULL
      AND affected_public_id IS NOT NULL
    )
    OR
    (
      operation_type = 'rollback'
      AND origin_publication_attempt_id IS NULL
      AND origin_public_removal_attempt_id IS NULL
      AND origin_rollback_attempt_id IS NOT NULL
      AND restored_from_version_id IS NOT NULL
      AND affected_project_id IS NULL
      AND affected_public_id IS NULL
    )
  )
);

CREATE UNIQUE INDEX public_feed_versions_publication_origin_uidx
  ON public.public_feed_versions(origin_publication_attempt_id)
  WHERE origin_publication_attempt_id IS NOT NULL;

CREATE UNIQUE INDEX public_feed_versions_removal_origin_uidx
  ON public.public_feed_versions(origin_public_removal_attempt_id)
  WHERE origin_public_removal_attempt_id IS NOT NULL;

CREATE INDEX public_feed_versions_created_at_idx
  ON public.public_feed_versions(created_at DESC);

CREATE INDEX public_feed_versions_previous_idx
  ON public.public_feed_versions(previous_version_id);

CREATE INDEX public_feed_versions_restored_from_idx
  ON public.public_feed_versions(restored_from_version_id);


-- ============================================================
-- 2. CURRENT FEED HEAD
-- ============================================================

-- History itself is immutable.
-- Currentness therefore lives in a separate pointer table.

CREATE TABLE public.public_feed_head (
  singleton boolean PRIMARY KEY DEFAULT true
    CHECK (singleton = true),

  version_id uuid NOT NULL
    REFERENCES public.public_feed_versions(id)
    ON DELETE RESTRICT,

  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);


-- ============================================================
-- 3. IMMUTABILITY GUARD
-- ============================================================

CREATE OR REPLACE FUNCTION public.reject_public_feed_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'PUBLIC_FEED_HISTORY_IMMUTABLE';
END;
$$;

CREATE TRIGGER public_feed_versions_reject_update
BEFORE UPDATE ON public.public_feed_versions
FOR EACH ROW
EXECUTE FUNCTION public.reject_public_feed_version_mutation();

CREATE TRIGGER public_feed_versions_reject_delete
BEFORE DELETE ON public.public_feed_versions
FOR EACH ROW
EXECUTE FUNCTION public.reject_public_feed_version_mutation();


-- ============================================================
-- 4. ROLLBACK ATTEMPTS
-- ============================================================

CREATE TABLE public.feed_rollback_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Generated during read-only preparation.
  -- Repeated execution of the same prepared operation is idempotent.
  operation_key uuid NOT NULL UNIQUE,

  target_version_id uuid NOT NULL
    REFERENCES public.public_feed_versions(id)
    ON DELETE RESTRICT,

  admin_id uuid NOT NULL
    REFERENCES public.admin_users(id)
    ON DELETE RESTRICT,

  state text NOT NULL CHECK (
    state IN (
      'reserved',
      'prepared',
      'storage_written',
      'completed',
      'failed',
      'compensation_failed'
    )
  ),

  execution_token uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at timestamptz NOT NULL,

  -- Current authoritative canonical feed captured AFTER reservation.
  baseline_record_count integer
    CHECK (baseline_record_count IS NULL OR baseline_record_count >= 0),

  baseline_feed_hash text
    CHECK (
      baseline_feed_hash IS NULL
      OR baseline_feed_hash ~ '^[0-9a-f]{64}$'
    ),

  baseline_feed_content text
    CHECK (
      baseline_feed_content IS NULL
      OR pg_catalog.octet_length(baseline_feed_content) <= 10485760
    ),

  -- Exact historical artifact bound to this attempt.
  target_record_count integer
    CHECK (target_record_count IS NULL OR target_record_count >= 0),

  target_feed_hash text
    CHECK (
      target_feed_hash IS NULL
      OR target_feed_hash ~ '^[0-9a-f]{64}$'
    ),

  target_feed_content text
    CHECK (
      target_feed_content IS NULL
      OR pg_catalog.octet_length(target_feed_content) <= 10485760
    ),

  artifact_bound_at timestamptz,
  storage_verified_at timestamptz,

  completed_history_version_id uuid
    REFERENCES public.public_feed_versions(id)
    ON DELETE RESTRICT,

  failure_code text
    CHECK (
      failure_code IS NULL
      OR failure_code ~ '^[A-Z0-9_]{1,64}$'
    ),

  compensation_failure_code text
    CHECK (
      compensation_failure_code IS NULL
      OR compensation_failure_code ~ '^[A-Z0-9_]{1,64}$'
    ),

  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  failed_at timestamptz,

  CONSTRAINT feed_rollback_artifact_binding_coherent CHECK (
    (
      artifact_bound_at IS NULL
      AND baseline_record_count IS NULL
      AND baseline_feed_hash IS NULL
      AND baseline_feed_content IS NULL
      AND target_record_count IS NULL
      AND target_feed_hash IS NULL
      AND target_feed_content IS NULL
    )
    OR
    (
      artifact_bound_at IS NOT NULL
      AND baseline_record_count IS NOT NULL
      AND baseline_feed_hash IS NOT NULL
      AND baseline_feed_content IS NOT NULL
      AND target_record_count IS NOT NULL
      AND target_feed_hash IS NOT NULL
      AND target_feed_content IS NOT NULL
    )
  ),

  CONSTRAINT feed_rollback_state_binding_coherent CHECK (
    (state = 'reserved' AND artifact_bound_at IS NULL)
    OR
    (
      state IN ('prepared', 'storage_written', 'completed')
      AND artifact_bound_at IS NOT NULL
    )
    OR
    state IN ('failed', 'compensation_failed')
  ),

  CONSTRAINT feed_rollback_storage_evidence_coherent CHECK (
    (
      state IN ('storage_written', 'completed')
      AND storage_verified_at IS NOT NULL
    )
    OR
    state IN ('reserved', 'prepared', 'failed', 'compensation_failed')
  ),

  CONSTRAINT feed_rollback_terminal_state_coherent CHECK (
    (
      state = 'completed'
      AND completed_at IS NOT NULL
      AND completed_history_version_id IS NOT NULL
      AND failure_code IS NULL
    )
    OR
    (
      state IN ('failed', 'compensation_failed')
      AND failed_at IS NOT NULL
      AND failure_code IS NOT NULL
      AND completed_at IS NULL
      AND completed_history_version_id IS NULL
    )
    OR
    (
      state IN ('reserved', 'prepared', 'storage_written')
      AND completed_at IS NULL
      AND failed_at IS NULL
      AND completed_history_version_id IS NULL
      AND failure_code IS NULL
    )
  )
);

CREATE UNIQUE INDEX feed_rollback_one_active_global_idx
  ON public.feed_rollback_attempts ((true))
  WHERE state IN (
    'reserved',
    'prepared',
    'storage_written',
    'compensation_failed'
  );

CREATE INDEX feed_rollback_target_version_idx
  ON public.feed_rollback_attempts(target_version_id);

CREATE INDEX feed_rollback_created_at_idx
  ON public.feed_rollback_attempts(created_at DESC);


-- Complete circular relationship only after rollback table exists.

ALTER TABLE public.public_feed_versions
  ADD CONSTRAINT public_feed_versions_rollback_origin_fk
  FOREIGN KEY (origin_rollback_attempt_id)
  REFERENCES public.feed_rollback_attempts(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX public_feed_versions_rollback_origin_uidx
  ON public.public_feed_versions(origin_rollback_attempt_id)
  WHERE origin_rollback_attempt_id IS NOT NULL;


-- ============================================================
-- 5. RLS / DIRECT ACCESS HARDENING
-- ============================================================

ALTER TABLE public.public_feed_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_rollback_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY deny_authenticated_public_feed_versions
ON public.public_feed_versions
FOR ALL TO authenticated
USING (false)
WITH CHECK (false);

CREATE POLICY deny_authenticated_public_feed_head
ON public.public_feed_head
FOR ALL TO authenticated
USING (false)
WITH CHECK (false);

CREATE POLICY deny_authenticated_feed_rollback_attempts
ON public.feed_rollback_attempts
FOR ALL TO authenticated
USING (false)
WITH CHECK (false);

REVOKE ALL PRIVILEGES
ON TABLE public.public_feed_versions
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL PRIVILEGES
ON TABLE public.public_feed_head
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL PRIVILEGES
ON TABLE public.feed_rollback_attempts
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT
ON TABLE public.public_feed_versions
TO service_role;

GRANT SELECT
ON TABLE public.public_feed_head
TO service_role;

GRANT SELECT
ON TABLE public.feed_rollback_attempts
TO service_role;


-- ============================================================
-- 6. RESERVE ROLLBACK EXECUTION
-- ============================================================

CREATE OR REPLACE FUNCTION public.reserve_feed_rollback_attempt(
  p_operation_key uuid,
  p_target_version_id uuid,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_roles text[];
  v_existing public.feed_rollback_attempts%ROWTYPE;
  v_attempt public.feed_rollback_attempts%ROWTYPE;
  v_state text;
  v_target_exists boolean;
BEGIN
  IF p_operation_key IS NULL
     OR p_target_version_id IS NULL
     OR p_admin_id IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_INPUT'
    );
  END IF;

  SELECT pg_catalog.array_agg(ur.role)
    INTO v_roles
    FROM public.user_roles ur
   WHERE ur.user_id = p_admin_id;

  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'PERMISSION_DENIED'
    );
  END IF;

  -- Same canonical feed concurrency domain as publication/removal.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('controlled_publication_global')
  );

  -- Idempotent retry of one prepared operation.
  SELECT *
    INTO v_existing
    FROM public.feed_rollback_attempts
   WHERE operation_key = p_operation_key
   LIMIT 1
   FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.admin_id IS DISTINCT FROM p_admin_id
       OR v_existing.target_version_id IS DISTINCT FROM p_target_version_id
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'OPERATION_KEY_MISMATCH'
      );
    END IF;

    IF v_existing.state = 'completed' THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'ALREADY_COMPLETED',
        'attemptId', v_existing.id::text,
        'historyVersionId',
          v_existing.completed_history_version_id::text
      );
    END IF;

    IF v_existing.state = 'compensation_failed' THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'COMPENSATION_INCOMPLETE'
      );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ROLLBACK_IN_PROGRESS',
      'attemptId', v_existing.id::text
    );
  END IF;

  -- Publication may already hold the durable feed slot.
  SELECT pa.state
    INTO v_state
    FROM public.publication_attempts pa
   WHERE pa.state IN (
     'reserved',
     'prepared',
     'storage_written',
     'compensation_failed'
   )
   ORDER BY pa.created_at
   LIMIT 1
   FOR UPDATE;

  IF v_state IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      CASE
        WHEN v_state = 'compensation_failed'
          THEN 'COMPENSATION_INCOMPLETE'
        ELSE 'PUBLICATION_IN_PROGRESS'
      END
    );
  END IF;

  -- Removal may already hold the durable feed slot.
  SELECT pra.state
    INTO v_state
    FROM public.public_removal_attempts pra
   WHERE pra.state IN (
     'reserved',
     'prepared',
     'storage_written',
     'compensation_failed'
   )
   ORDER BY pra.created_at
   LIMIT 1
   FOR UPDATE;

  IF v_state IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      CASE
        WHEN v_state = 'compensation_failed'
          THEN 'COMPENSATION_INCOMPLETE'
        ELSE 'PUBLICATION_IN_PROGRESS'
      END
    );
  END IF;

  -- Another rollback may already own the global slot.
  SELECT *
    INTO v_existing
    FROM public.feed_rollback_attempts
   WHERE state IN (
     'reserved',
     'prepared',
     'storage_written',
     'compensation_failed'
   )
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      CASE
        WHEN v_existing.state = 'compensation_failed'
          THEN 'COMPENSATION_INCOMPLETE'
        ELSE 'ROLLBACK_IN_PROGRESS'
      END
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.public_feed_versions v
     WHERE v.id = p_target_version_id
  )
  INTO v_target_exists;

  IF NOT v_target_exists THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'HISTORICAL_VERSION_NOT_FOUND'
    );
  END IF;

  INSERT INTO public.feed_rollback_attempts (
    operation_key,
    target_version_id,
    admin_id,
    state,
    lease_expires_at
  )
  VALUES (
    p_operation_key,
    p_target_version_id,
    p_admin_id,
    'reserved',
    pg_catalog.now() + interval '5 minutes'
  )
  RETURNING *
  INTO v_attempt;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'ATTEMPT_RESERVED',
    'attemptId', v_attempt.id::text,
    'executionToken', v_attempt.execution_token::text
  );
END;
$$;


-- ============================================================
-- 7. BIND CURRENT BASELINE + VERIFIED HISTORICAL TARGET
-- ============================================================

CREATE OR REPLACE FUNCTION public.prepare_feed_rollback_attempt(
  p_attempt_id uuid,
  p_execution_token uuid,

  p_baseline_record_count integer,
  p_baseline_feed_hash text,
  p_baseline_feed_content text,

  p_target_record_count integer,
  p_target_feed_hash text,
  p_target_feed_content text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.feed_rollback_attempts%ROWTYPE;
  v_target public.public_feed_versions%ROWTYPE;
  v_baseline_json jsonb;
  v_target_json jsonb;
BEGIN
  IF p_attempt_id IS NULL
     OR p_execution_token IS NULL
     OR p_baseline_record_count IS NULL
     OR p_baseline_record_count < 0
     OR p_target_record_count IS NULL
     OR p_target_record_count < 0
     OR p_baseline_feed_hash IS NULL
     OR p_baseline_feed_hash !~ '^[0-9a-f]{64}$'
     OR p_target_feed_hash IS NULL
     OR p_target_feed_hash !~ '^[0-9a-f]{64}$'
     OR p_baseline_feed_content IS NULL
     OR p_target_feed_content IS NULL
     OR pg_catalog.octet_length(p_baseline_feed_content) > 10485760
     OR pg_catalog.octet_length(p_target_feed_content) > 10485760
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_INPUT'
    );
  END IF;

  BEGIN
    v_baseline_json := p_baseline_feed_content::jsonb;
    v_target_json := p_target_feed_content::jsonb;
  EXCEPTION WHEN others THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_ARTIFACT'
    );
  END;

  IF pg_catalog.jsonb_typeof(v_baseline_json) <> 'array'
     OR pg_catalog.jsonb_typeof(v_target_json) <> 'array'
     OR pg_catalog.jsonb_array_length(v_baseline_json)
          <> p_baseline_record_count
     OR pg_catalog.jsonb_array_length(v_target_json)
          <> p_target_record_count
     OR pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(
              p_baseline_feed_content,
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) <> p_baseline_feed_hash
     OR pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(
              p_target_feed_content,
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) <> p_target_feed_hash
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_ARTIFACT'
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('controlled_publication_global')
  );

  SELECT *
    INTO v_attempt
    FROM public.feed_rollback_attempts
   WHERE id = p_attempt_id
   FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_NOT_FOUND'
    );
  END IF;

  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_TOKEN_MISMATCH'
    );
  END IF;

  IF v_attempt.state <> 'reserved'
     OR v_attempt.artifact_bound_at IS NOT NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_ATTEMPT_STATE'
    );
  END IF;

  SELECT *
    INTO v_target
    FROM public.public_feed_versions
   WHERE id = v_attempt.target_version_id;

  IF v_target.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'HISTORICAL_VERSION_NOT_FOUND'
    );
  END IF;

  -- Historical backup must still be exactly the immutable evidence
  -- selected by the administrator.
  IF v_target.record_count IS DISTINCT FROM p_target_record_count
     OR v_target.feed_hash IS DISTINCT FROM p_target_feed_hash
     OR v_target.artifact_content IS DISTINCT FROM p_target_feed_content
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'HISTORICAL_ARTIFACT_MISMATCH'
    );
  END IF;

  UPDATE public.feed_rollback_attempts
     SET baseline_record_count = p_baseline_record_count,
         baseline_feed_hash = p_baseline_feed_hash,
         baseline_feed_content = p_baseline_feed_content,

         target_record_count = p_target_record_count,
         target_feed_hash = p_target_feed_hash,
         target_feed_content = p_target_feed_content,

         artifact_bound_at = pg_catalog.now(),
         state = 'prepared',
         updated_at = pg_catalog.now(),
         lease_expires_at =
           pg_catalog.now() + interval '5 minutes'
   WHERE id = v_attempt.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'ARTIFACT_BOUND',
    'attemptId', v_attempt.id::text
  );
END;
$$;


-- ============================================================
-- 8. RECOVER EXPIRED EXECUTION OWNERSHIP
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_feed_rollback_attempt(
  p_operation_key uuid,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_roles text[];
  v_attempt public.feed_rollback_attempts%ROWTYPE;
BEGIN
  SELECT pg_catalog.array_agg(ur.role)
    INTO v_roles
    FROM public.user_roles ur
   WHERE ur.user_id = p_admin_id;

  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'PERMISSION_DENIED'
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('controlled_publication_global')
  );

  SELECT *
    INTO v_attempt
    FROM public.feed_rollback_attempts
   WHERE operation_key = p_operation_key
     AND state IN (
       'reserved',
       'prepared',
       'storage_written',
       'compensation_failed'
     )
   LIMIT 1
   FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_NOT_FOUND'
    );
  END IF;

  IF v_attempt.state = 'compensation_failed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'COMPENSATION_INCOMPLETE'
    );
  END IF;

  IF v_attempt.admin_id IS DISTINCT FROM p_admin_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_OWNER_MISMATCH'
    );
  END IF;

  IF v_attempt.lease_expires_at > pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ROLLBACK_IN_PROGRESS'
    );
  END IF;

  UPDATE public.feed_rollback_attempts
     SET execution_token = gen_random_uuid(),
         lease_expires_at =
           pg_catalog.now() + interval '5 minutes',
         updated_at = pg_catalog.now()
   WHERE id = v_attempt.id
  RETURNING *
  INTO v_attempt;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'ATTEMPT_CLAIMED',
    'attemptId', v_attempt.id::text,
    'executionToken', v_attempt.execution_token::text,
    'state', v_attempt.state
  );
END;
$$;


-- ============================================================
-- 9. MARK EXACT STORAGE WRITE VERIFIED
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_feed_rollback_storage_written(
  p_attempt_id uuid,
  p_execution_token uuid,
  p_verified_feed_hash text,
  p_verified_record_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.feed_rollback_attempts%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('controlled_publication_global')
  );

  SELECT *
    INTO v_attempt
    FROM public.feed_rollback_attempts
   WHERE id = p_attempt_id
   FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_NOT_FOUND'
    );
  END IF;

  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_TOKEN_MISMATCH'
    );
  END IF;

  IF v_attempt.state NOT IN ('prepared', 'storage_written') THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_ATTEMPT_STATE'
    );
  END IF;

  IF v_attempt.target_feed_hash
       IS DISTINCT FROM p_verified_feed_hash
     OR v_attempt.target_record_count
       IS DISTINCT FROM p_verified_record_count
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ARTIFACT_MISMATCH'
    );
  END IF;

  UPDATE public.feed_rollback_attempts
     SET state = 'storage_written',
         storage_verified_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE id = v_attempt.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'STORAGE_WRITTEN',
    'attemptId', v_attempt.id::text
  );
END;
$$;


-- ============================================================
-- 10. FINALIZE ROLLBACK
-- ============================================================

CREATE OR REPLACE FUNCTION public.finalize_feed_rollback_attempt(
  p_attempt_id uuid,
  p_execution_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.feed_rollback_attempts%ROWTYPE;
  v_previous_version_id uuid;
  v_history_version_id uuid;
  v_existing_history_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('controlled_publication_global')
  );

  SELECT *
    INTO v_attempt
    FROM public.feed_rollback_attempts
   WHERE id = p_attempt_id
   FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_NOT_FOUND'
    );
  END IF;

  IF v_attempt.state = 'completed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_COMPLETED',
      'attemptId', v_attempt.id::text,
      'historyVersionId',
        v_attempt.completed_history_version_id::text
    );
  END IF;

  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_TOKEN_MISMATCH'
    );
  END IF;

  IF v_attempt.state <> 'storage_written'
     OR v_attempt.storage_verified_at IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_ATTEMPT_STATE'
    );
  END IF;

  -- Idempotency defense in case history was inserted but attempt finalization
  -- was interrupted.
  SELECT v.id
    INTO v_existing_history_id
    FROM public.public_feed_versions v
   WHERE v.origin_rollback_attempt_id = v_attempt.id
   LIMIT 1;

  IF v_existing_history_id IS NOT NULL THEN
    UPDATE public.feed_rollback_attempts
       SET state = 'completed',
           completed_history_version_id =
             v_existing_history_id,
           completed_at = COALESCE(
             completed_at,
             pg_catalog.now()
           ),
           updated_at = pg_catalog.now(),
           lease_expires_at = pg_catalog.now()
     WHERE id = v_attempt.id;

    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_COMPLETED',
      'attemptId', v_attempt.id::text,
      'historyVersionId',
        v_existing_history_id::text
    );
  END IF;

  SELECT h.version_id
    INTO v_previous_version_id
    FROM public.public_feed_head h
   WHERE h.singleton = true
   FOR UPDATE;

  INSERT INTO public.public_feed_versions (
    operation_type,
    actor_admin_id,
    affected_project_id,
    affected_public_id,

    record_count,
    feed_hash,
    artifact_content,

    previous_version_id,
    restored_from_version_id,

    origin_publication_attempt_id,
    origin_public_removal_attempt_id,
    origin_rollback_attempt_id
  )
  VALUES (
    'rollback',
    v_attempt.admin_id,
    NULL,
    NULL,

    v_attempt.target_record_count,
    v_attempt.target_feed_hash,
    v_attempt.target_feed_content,

    v_previous_version_id,
    v_attempt.target_version_id,

    NULL,
    NULL,
    v_attempt.id
  )
  RETURNING id
  INTO v_history_version_id;

  INSERT INTO public.public_feed_head (
    singleton,
    version_id,
    updated_at
  )
  VALUES (
    true,
    v_history_version_id,
    pg_catalog.now()
  )
  ON CONFLICT (singleton)
  DO UPDATE SET
    version_id = EXCLUDED.version_id,
    updated_at = EXCLUDED.updated_at;

  UPDATE public.feed_rollback_attempts
     SET state = 'completed',
         completed_history_version_id =
           v_history_version_id,
         completed_at = pg_catalog.now(),
         updated_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now()
   WHERE id = v_attempt.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'COMPLETED',
    'attemptId', v_attempt.id::text,
    'historyVersionId',
      v_history_version_id::text
  );
END;
$$;


-- ============================================================
-- 11. FAILURE / COMPENSATION EVIDENCE
-- ============================================================

CREATE OR REPLACE FUNCTION public.fail_feed_rollback_attempt(
  p_attempt_id uuid,
  p_execution_token uuid,
  p_failure_code text,
  p_compensation_failure_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt public.feed_rollback_attempts%ROWTYPE;

  v_failure text :=
    pg_catalog.btrim(COALESCE(p_failure_code, ''));

  v_compensation text :=
    NULLIF(
      pg_catalog.btrim(
        COALESCE(p_compensation_failure_code, '')
      ),
      ''
    );
BEGIN
  IF v_failure !~ '^[A-Z0-9_]{1,64}$'
     OR (
       v_compensation IS NOT NULL
       AND v_compensation !~ '^[A-Z0-9_]{1,64}$'
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'INVALID_INPUT'
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('controlled_publication_global')
  );

  SELECT *
    INTO v_attempt
    FROM public.feed_rollback_attempts
   WHERE id = p_attempt_id
   FOR UPDATE;

  IF v_attempt.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_NOT_FOUND'
    );
  END IF;

  IF v_attempt.execution_token IS DISTINCT FROM p_execution_token THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ATTEMPT_TOKEN_MISMATCH'
    );
  END IF;

  IF v_attempt.state = 'completed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_COMPLETED'
    );
  END IF;

  UPDATE public.feed_rollback_attempts
     SET state =
           CASE
             WHEN v_compensation IS NULL
               THEN 'failed'
             ELSE 'compensation_failed'
           END,
         failure_code = v_failure,
         compensation_failure_code =
           v_compensation,
         failed_at = pg_catalog.now(),
         updated_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now()
   WHERE id = v_attempt.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode',
    CASE
      WHEN v_compensation IS NULL
        THEN 'FAILED'
      ELSE 'COMPENSATION_INCOMPLETE'
    END
  );
END;
$$;


-- ============================================================
-- 12. FUNCTION PRIVILEGES
-- ============================================================

REVOKE ALL ON FUNCTION
  public.reserve_feed_rollback_attempt(uuid,uuid,uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.prepare_feed_rollback_attempt(
    uuid,uuid,integer,text,text,integer,text,text
  )
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.claim_feed_rollback_attempt(uuid,uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.mark_feed_rollback_storage_written(
    uuid,uuid,text,integer
  )
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.finalize_feed_rollback_attempt(uuid,uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.fail_feed_rollback_attempt(uuid,uuid,text,text)
FROM PUBLIC, anon, authenticated;


GRANT EXECUTE ON FUNCTION
  public.reserve_feed_rollback_attempt(uuid,uuid,uuid)
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.prepare_feed_rollback_attempt(
    uuid,uuid,integer,text,text,integer,text,text
  )
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.claim_feed_rollback_attempt(uuid,uuid)
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.mark_feed_rollback_storage_written(
    uuid,uuid,text,integer
  )
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.finalize_feed_rollback_attempt(uuid,uuid)
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.fail_feed_rollback_attempt(uuid,uuid,text,text)
TO service_role;


COMMIT;