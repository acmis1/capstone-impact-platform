-- Integrate immutable public-feed history with the existing controlled
-- publication/removal state machines.
--
-- Goals:
--   1. Successful publication/removal finalization creates exactly one
--      immutable feed-history version in the SAME database transaction.
--   2. public_feed_head advances atomically with the history insert.
--   3. Existing publication/removal workflows cannot start while a
--      rollback owns the global feed-operation slot.
--   4. Existing publication/removal lifecycle semantics are unchanged.

BEGIN;


-- ============================================================
-- 1. GLOBAL FEED-OPERATION GUARD
-- ============================================================

CREATE OR REPLACE FUNCTION public.reject_feed_operation_when_rollback_active()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rollback_state text;
BEGIN
  -- Same ordering used by controlled publication/removal.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('controlled_publication_global')
  );

  SELECT r.state
    INTO v_rollback_state
    FROM public.feed_rollback_attempts r
   WHERE r.state IN (
     'reserved',
     'prepared',
     'storage_written',
     'compensation_failed'
   )
   ORDER BY r.created_at
   LIMIT 1
   FOR UPDATE;

  IF v_rollback_state IS NOT NULL THEN
    IF v_rollback_state = 'compensation_failed' THEN
      RAISE EXCEPTION 'COMPENSATION_INCOMPLETE';
    END IF;

    -- Reuse the existing bounded concurrency result understood by
    -- controlled publication. Removal repository mapping is updated
    -- separately to preserve the same public result contract.
    RAISE EXCEPTION 'PUBLICATION_IN_PROGRESS';
  END IF;

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS publication_attempts_reject_during_rollback
ON public.publication_attempts;

CREATE TRIGGER publication_attempts_reject_during_rollback
BEFORE INSERT ON public.publication_attempts
FOR EACH ROW
EXECUTE FUNCTION public.reject_feed_operation_when_rollback_active();


DROP TRIGGER IF EXISTS public_removal_attempts_reject_during_rollback
ON public.public_removal_attempts;

CREATE TRIGGER public_removal_attempts_reject_during_rollback
BEFORE INSERT ON public.public_removal_attempts
FOR EACH ROW
EXECUTE FUNCTION public.reject_feed_operation_when_rollback_active();


-- ============================================================
-- 2. COMMON HISTORY HEAD HELPER
-- ============================================================

CREATE OR REPLACE FUNCTION public.advance_public_feed_head(
  p_version_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_version_id IS NULL THEN
    RAISE EXCEPTION 'PUBLIC_FEED_VERSION_ID_REQUIRED';
  END IF;

  INSERT INTO public.public_feed_head (
    singleton,
    version_id,
    updated_at
  )
  VALUES (
    true,
    p_version_id,
    pg_catalog.now()
  )
  ON CONFLICT (singleton)
  DO UPDATE SET
    version_id = EXCLUDED.version_id,
    updated_at = EXCLUDED.updated_at;
END;
$$;


-- ============================================================
-- 3. PUBLICATION -> IMMUTABLE FEED VERSION
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_completed_publication_feed_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous_version_id uuid;
  v_version_id uuid;
  v_existing_version_id uuid;
  v_candidate jsonb;
BEGIN
  -- Only react to the exact transition into completed.
  IF NEW.state <> 'completed'
     OR OLD.state = 'completed'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.candidate_record_count IS NULL
     OR NEW.candidate_feed_hash IS NULL
     OR NEW.candidate_feed_content IS NULL
     OR NEW.admin_id IS NULL
     OR NEW.project_id IS NULL
     OR NEW.public_id IS NULL
  THEN
    RAISE EXCEPTION 'PUBLICATION_HISTORY_EVIDENCE_INCOMPLETE';
  END IF;

  -- Defensive verification. Finalization already verified storage,
  -- but history must independently fail closed if bound evidence
  -- is malformed.
  BEGIN
    v_candidate := NEW.candidate_feed_content::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'PUBLICATION_HISTORY_ARTIFACT_INVALID';
  END;

  IF pg_catalog.jsonb_typeof(v_candidate) <> 'array'
     OR pg_catalog.jsonb_array_length(v_candidate)
          <> NEW.candidate_record_count
     OR pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(
              NEW.candidate_feed_content,
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) <> NEW.candidate_feed_hash
  THEN
    RAISE EXCEPTION 'PUBLICATION_HISTORY_ARTIFACT_INVALID';
  END IF;

  -- Idempotency defense.
  SELECT v.id
    INTO v_existing_version_id
    FROM public.public_feed_versions v
   WHERE v.origin_publication_attempt_id = NEW.id
   LIMIT 1;

  IF v_existing_version_id IS NOT NULL THEN
    PERFORM public.advance_public_feed_head(
      v_existing_version_id
    );

    RETURN NEW;
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
    'publication',
    NEW.admin_id,

    NEW.project_id,
    NEW.public_id,

    NEW.candidate_record_count,
    NEW.candidate_feed_hash,
    NEW.candidate_feed_content,

    v_previous_version_id,
    NULL,

    NEW.id,
    NULL,
    NULL
  )
  RETURNING id
  INTO v_version_id;

  PERFORM public.advance_public_feed_head(
    v_version_id
  );

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS publication_attempt_completed_feed_history
ON public.publication_attempts;

CREATE TRIGGER publication_attempt_completed_feed_history
AFTER UPDATE OF state
ON public.publication_attempts
FOR EACH ROW
EXECUTE FUNCTION public.record_completed_publication_feed_version();


-- ============================================================
-- 4. PUBLIC REMOVAL -> IMMUTABLE FEED VERSION
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_completed_public_removal_feed_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous_version_id uuid;
  v_version_id uuid;
  v_existing_version_id uuid;
  v_candidate jsonb;
BEGIN
  IF NEW.state <> 'completed'
     OR OLD.state = 'completed'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.candidate_record_count IS NULL
     OR NEW.candidate_feed_hash IS NULL
     OR NEW.candidate_feed_content IS NULL
     OR NEW.admin_id IS NULL
     OR NEW.project_id IS NULL
     OR NEW.public_id IS NULL
  THEN
    RAISE EXCEPTION 'REMOVAL_HISTORY_EVIDENCE_INCOMPLETE';
  END IF;

  BEGIN
    v_candidate := NEW.candidate_feed_content::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'REMOVAL_HISTORY_ARTIFACT_INVALID';
  END;

  IF pg_catalog.jsonb_typeof(v_candidate) <> 'array'
     OR pg_catalog.jsonb_array_length(v_candidate)
          <> NEW.candidate_record_count
     OR pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(
              NEW.candidate_feed_content,
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) <> NEW.candidate_feed_hash
  THEN
    RAISE EXCEPTION 'REMOVAL_HISTORY_ARTIFACT_INVALID';
  END IF;

  SELECT v.id
    INTO v_existing_version_id
    FROM public.public_feed_versions v
   WHERE v.origin_public_removal_attempt_id = NEW.id
   LIMIT 1;

  IF v_existing_version_id IS NOT NULL THEN
    PERFORM public.advance_public_feed_head(
      v_existing_version_id
    );

    RETURN NEW;
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
    'removal',
    NEW.admin_id,

    NEW.project_id,
    NEW.public_id,

    NEW.candidate_record_count,
    NEW.candidate_feed_hash,
    NEW.candidate_feed_content,

    v_previous_version_id,
    NULL,

    NULL,
    NEW.id,
    NULL
  )
  RETURNING id
  INTO v_version_id;

  PERFORM public.advance_public_feed_head(
    v_version_id
  );

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS public_removal_attempt_completed_feed_history
ON public.public_removal_attempts;

CREATE TRIGGER public_removal_attempt_completed_feed_history
AFTER UPDATE OF state
ON public.public_removal_attempts
FOR EACH ROW
EXECUTE FUNCTION public.record_completed_public_removal_feed_version();


-- ============================================================
-- 5. HARDEN HELPER FUNCTION PRIVILEGES
-- ============================================================

REVOKE ALL ON FUNCTION
  public.reject_feed_operation_when_rollback_active()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.advance_public_feed_head(uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.record_completed_publication_feed_version()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.record_completed_public_removal_feed_version()
FROM PUBLIC, anon, authenticated;


COMMIT;