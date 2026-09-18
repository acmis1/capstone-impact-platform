-- Migration 0061: governed project soft delete.
--
-- Soft delete is deliberately a lifecycle transition, not row or object deletion. The authority
-- serializes with every canonical feed writer, fails closed on incomplete publication evidence,
-- fences stale callers by projects.updated_at, and records the state change in the same transaction.

BEGIN;

-- Existing databases may contain legacy rows where deleted_at was used only as a read filter.
-- Do not rewrite that history in this migration. New inserts and every future update must keep the
-- lifecycle status and tombstone timestamp authoritative together; legacy mismatches fail closed
-- in the decision authority below until independently reconciled.
ALTER TABLE public.projects
  ADD CONSTRAINT projects_soft_delete_state_coherent
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)) NOT VALID;

-- PostgreSQL versions used by disposable and hosted Supabase do not all expose
-- pg_input_is_valid. Keep malformed historical artifact text behind a revoked parser so one
-- corrupt project cannot abort a mixed preflight.
CREATE FUNCTION public.parse_project_soft_delete_evidence_json(p_content text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN p_content::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.parse_project_soft_delete_evidence_json(text)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.project_soft_delete_decision(
  p_project_id uuid,
  p_public_id text,
  p_status text,
  p_deleted_at timestamptz,
  p_pending_removal boolean,
  p_public_removal_completed_at timestamptz,
  p_archived_at timestamptz,
  p_archived_from_status text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previously_published boolean;
  v_completed_removal_count integer;
  v_operation public.public_feed_operations%ROWTYPE;
  v_baseline_version public.public_feed_versions%ROWTYPE;
  v_removal_version public.public_feed_versions%ROWTYPE;
  v_head_version public.public_feed_versions%ROWTYPE;
  v_archive_audit public.approval_records%ROWTYPE;
  v_candidate jsonb;
  v_baseline jsonb;
  v_head_artifact jsonb;
  v_expected_candidate jsonb;
  v_no_feed_change boolean;
  v_target_baseline_count integer;
  v_operation_version_count integer;
  v_event_count integer;
  v_archive_audit_count integer;
  v_archive_audit_time timestamptz;
  v_finalized_sequence integer;
  v_completed_sequence integer;
  v_finalization_actor_id uuid;
  v_finalization_owner_epoch bigint;
  v_anchor_version_id uuid;
BEGIN
  IF p_status = 'deleted' AND p_deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_DELETED',
      'reason', 'This project is already soft-deleted. No new audit event was created.',
      'previouslyPublished', false
    );
  END IF;

  IF (p_status = 'deleted') IS DISTINCT FROM (p_deleted_at IS NOT NULL) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'DELETE_STATE_AMBIGUOUS',
      'reason', 'The project deletion state is inconsistent and requires administrator investigation.',
      'previouslyPublished', false
    );
  END IF;

  IF p_status = 'published' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'PUBLISHED_REQUIRES_ARCHIVE',
      'reason', 'Published projects must complete the normal archive and public-removal workflow first.',
      'previouslyPublished', true
    );
  END IF;

  IF p_pending_removal IS DISTINCT FROM false THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_PENDING',
      'reason', 'Public removal is pending or ambiguous. Complete and verify removal before deletion.',
      'previouslyPublished', true
    );
  END IF;

  IF p_status NOT IN ('draft', 'submitted', 'in_review', 'changes_requested', 'approved', 'archived') THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'STATUS_INELIGIBLE',
      'reason', 'The current project lifecycle state cannot be soft-deleted.',
      'previouslyPublished', false
    );
  END IF;

  -- The writer protocol can be between short database transactions while an external storage
  -- write is in flight. Persisted active states therefore block deletion even after this caller
  -- owns the transaction-scoped canonical writer lock.
  IF EXISTS (
    SELECT 1
      FROM public.public_feed_operations operation
     WHERE operation.state IN (
       'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED',
       'DB_FINALIZED', 'RECOVERY_REQUIRED'
     )
  ) OR EXISTS (
    SELECT 1 FROM public.publication_attempts attempt
     WHERE attempt.state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
  ) OR EXISTS (
    SELECT 1 FROM public.public_removal_attempts attempt
     WHERE attempt.state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'PUBLICATION_OR_REMOVAL_PENDING',
      'reason', 'A publication, public-removal, or recovery operation is still in progress.',
      'previouslyPublished', false
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.public_feed_head head
      JOIN public.public_feed_version_members member
        ON member.version_id = head.current_version_id
     WHERE head.singleton = true
       AND member.public_id = p_public_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'CURRENTLY_PUBLIC',
      'reason', 'The canonical public feed still contains this project.',
      'previouslyPublished', true
    );
  END IF;

  SELECT
    p_archived_from_status = 'published'
    OR p_public_removal_completed_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.approval_records audit
       WHERE audit.project_id = p_project_id
         AND (
           audit.action_taken = 'publish'
           OR audit.from_status = 'published'
           OR audit.to_status = 'published'
         )
    )
    OR EXISTS (
      SELECT 1 FROM public.publication_attempts attempt
       WHERE attempt.project_id = p_project_id
         AND attempt.state = 'completed'
    )
    OR EXISTS (
      SELECT 1 FROM public.public_feed_operations operation
       WHERE operation.project_id = p_project_id
         AND operation.public_id = p_public_id
         AND (
           (operation.kind = 'publication' AND operation.state IN ('DB_FINALIZED', 'COMPLETED'))
           OR operation.kind = 'removal'
         )
    )
    OR EXISTS (
      SELECT 1 FROM public.public_feed_versions version
       WHERE version.project_id = p_project_id
         AND version.affected_public_id = p_public_id
         AND version.operation IN ('publication', 'removal')
    )
  INTO v_previously_published;

  IF v_previously_published IS DISTINCT FROM true THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ELIGIBLE',
      'reason', 'This never-published private project can be soft-deleted.',
      'previouslyPublished', false
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.public_feed_head head WHERE head.singleton = true) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'CANONICAL_FEED_UNAVAILABLE',
      'reason', 'Canonical feed state is unavailable, so prior public removal cannot be verified.',
      'previouslyPublished', true
    );
  END IF;

  IF p_public_removal_completed_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_REQUIRED',
      'reason', 'This project was previously public, but verified public-removal evidence is missing.',
      'previouslyPublished', true
    );
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_completed_removal_count
    FROM public.public_feed_operations operation
   WHERE operation.project_id = p_project_id
     AND operation.public_id = p_public_id
     AND operation.kind = 'removal'
     AND operation.state = 'COMPLETED'
     AND operation.completed_at IS NOT DISTINCT FROM p_public_removal_completed_at;

  IF v_completed_removal_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  SELECT * INTO v_operation
    FROM public.public_feed_operations operation
   WHERE operation.project_id = p_project_id
     AND operation.public_id = p_public_id
     AND operation.kind = 'removal'
     AND operation.state = 'COMPLETED'
     AND operation.completed_at IS NOT DISTINCT FROM p_public_removal_completed_at;

  IF v_operation.finalized_at IS NULL
     OR v_operation.completed_at < v_operation.finalized_at
     OR v_operation.finalized_at < v_operation.created_at
     OR v_operation.failure_code IS NOT NULL
     OR v_operation.completion_actor_id IS NULL
     OR v_operation.baseline_version_id IS NULL
     OR v_operation.baseline_storage_existed IS DISTINCT FROM true
     OR v_operation.baseline_feed_content IS NULL
     OR v_operation.baseline_feed_hash IS NULL
     OR v_operation.baseline_record_count IS NULL
     OR v_operation.candidate_feed_content IS NULL
     OR v_operation.candidate_feed_hash IS NULL
     OR v_operation.candidate_record_count IS NULL
     OR v_operation.candidate_byte_count IS DISTINCT FROM
        pg_catalog.octet_length(v_operation.candidate_feed_content)
     OR v_operation.candidate_feed_hash IS DISTINCT FROM pg_catalog.encode(
       extensions.digest(
         pg_catalog.convert_to(v_operation.candidate_feed_content, 'UTF8'),
         'sha256'
       ),
       'hex'
     )
     OR v_operation.baseline_feed_hash IS DISTINCT FROM pg_catalog.encode(
       extensions.digest(
         pg_catalog.convert_to(v_operation.baseline_feed_content, 'UTF8'),
         'sha256'
       ),
       'hex'
     )
     OR v_operation.observed_storage_hash IS DISTINCT FROM v_operation.candidate_feed_hash
     OR v_operation.observed_storage_record_count IS DISTINCT FROM
        v_operation.candidate_record_count
     OR pg_catalog.jsonb_typeof(v_operation.candidate_members) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_operation.media_manifest) IS DISTINCT FROM 'array'
     OR pg_catalog.btrim(COALESCE(v_operation.storage_bucket, '')) = ''
     OR pg_catalog.btrim(COALESCE(v_operation.storage_path, '')) = ''
     OR pg_catalog.btrim(COALESCE(v_operation.feed_public_url, '')) = ''
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  v_candidate := public.parse_project_soft_delete_evidence_json(
    v_operation.candidate_feed_content
  );
  v_baseline := public.parse_project_soft_delete_evidence_json(
    v_operation.baseline_feed_content
  );
  IF pg_catalog.jsonb_typeof(v_candidate) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'array'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  IF pg_catalog.jsonb_array_length(v_candidate) <> v_operation.candidate_record_count
     OR pg_catalog.jsonb_array_length(v_baseline) <> v_operation.baseline_record_count
     OR pg_catalog.jsonb_array_length(v_operation.candidate_members) <>
        v_operation.candidate_record_count
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) item
        WHERE pg_catalog.jsonb_typeof(item) <> 'object'
           OR COALESCE(item->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_baseline) item
        WHERE pg_catalog.jsonb_typeof(item) <> 'object'
           OR COALESCE(item->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
     )
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_candidate)) <>
        (SELECT pg_catalog.count(DISTINCT item->>'publicId')
           FROM pg_catalog.jsonb_array_elements(v_candidate) item)
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_baseline)) <>
        (SELECT pg_catalog.count(DISTINCT item->>'publicId')
           FROM pg_catalog.jsonb_array_elements(v_baseline) item)
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_operation.candidate_members)
           WITH ORDINALITY member(value, ordinality)
        WHERE pg_catalog.jsonb_typeof(member.value) <> 'object'
           OR COALESCE(member.value->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
           OR COALESCE(member.value->>'recordHash', '') !~ '^[0-9a-f]{64}$'
           OR CASE
             WHEN COALESCE(member.value->>'ordinal', '') ~ '^[0-9]{1,10}$'
             THEN (member.value->>'ordinal')::bigint > 2147483647
               OR (member.value->>'ordinal')::bigint <> member.ordinality - 1
             ELSE true
           END
           OR NOT EXISTS (
             SELECT 1
               FROM pg_catalog.jsonb_array_elements(v_candidate)
                 WITH ORDINALITY candidate_item(value, ordinality)
              WHERE candidate_item.ordinality = member.ordinality
                AND candidate_item.value->>'publicId' = member.value->>'publicId'
           )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  SELECT pg_catalog.count(*) INTO v_target_baseline_count
    FROM pg_catalog.jsonb_array_elements(v_baseline) item
   WHERE item->>'publicId' = p_public_id;
  SELECT COALESCE(
    pg_catalog.jsonb_agg(item.value ORDER BY item.ordinality),
    '[]'::jsonb
  ) INTO v_expected_candidate
    FROM pg_catalog.jsonb_array_elements(v_baseline)
      WITH ORDINALITY item(value, ordinality)
   WHERE item.value->>'publicId' <> p_public_id;

  IF v_target_baseline_count NOT IN (0, 1)
     OR v_candidate IS DISTINCT FROM v_expected_candidate
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;
  v_no_feed_change := v_target_baseline_count = 0;

  SELECT * INTO v_baseline_version
    FROM public.public_feed_versions version
   WHERE version.id = v_operation.baseline_version_id;
  IF v_baseline_version.id IS NULL
     OR v_baseline_version.artifact_content IS DISTINCT FROM
        v_operation.baseline_feed_content
     OR v_baseline_version.feed_hash IS DISTINCT FROM v_operation.baseline_feed_hash
     OR v_baseline_version.record_count IS DISTINCT FROM v_operation.baseline_record_count
     OR v_baseline_version.byte_count IS DISTINCT FROM
        pg_catalog.octet_length(v_baseline_version.artifact_content)
     OR v_baseline_version.feed_hash IS DISTINCT FROM pg_catalog.encode(
       extensions.digest(
         pg_catalog.convert_to(v_baseline_version.artifact_content, 'UTF8'),
         'sha256'
       ),
       'hex'
     )
     OR (SELECT pg_catalog.count(*) FROM public.public_feed_version_members member
          WHERE member.version_id = v_baseline_version.id) <>
        v_baseline_version.record_count
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_baseline)
           WITH ORDINALITY item(value, ordinality)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.public_feed_version_members member
           WHERE member.version_id = v_baseline_version.id
             AND member.ordinal = item.ordinality - 1
             AND member.public_id = item.value->>'publicId'
        )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_operation.candidate_members)
           WITH ORDINALITY manifest(value, ordinality)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.public_feed_version_members member
           WHERE member.version_id = v_baseline_version.id
             AND member.public_id = manifest.value->>'publicId'
             AND member.record_hash = manifest.value->>'recordHash'
        )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  -- The current head may have advanced for unrelated projects, but it must be a complete canonical
  -- artifact in the selected removal's lineage and must prove target absence in both representations.
  SELECT version.* INTO v_head_version
    FROM public.public_feed_head head
    JOIN public.public_feed_versions version ON version.id = head.current_version_id
   WHERE head.singleton = true;
  v_head_artifact := public.parse_project_soft_delete_evidence_json(
    v_head_version.artifact_content
  );
  IF v_head_version.id IS NULL
     OR pg_catalog.jsonb_typeof(v_head_artifact) IS DISTINCT FROM 'array'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;
  IF pg_catalog.jsonb_array_length(v_head_artifact) <> v_head_version.record_count
     OR v_head_version.byte_count IS DISTINCT FROM
        pg_catalog.octet_length(v_head_version.artifact_content)
     OR v_head_version.feed_hash IS DISTINCT FROM pg_catalog.encode(
       extensions.digest(
         pg_catalog.convert_to(v_head_version.artifact_content, 'UTF8'),
         'sha256'
       ),
       'hex'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_head_artifact) item
        WHERE pg_catalog.jsonb_typeof(item) <> 'object'
           OR COALESCE(item->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
     )
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_head_artifact)) <>
        (SELECT pg_catalog.count(DISTINCT item->>'publicId')
           FROM pg_catalog.jsonb_array_elements(v_head_artifact) item)
     OR (SELECT pg_catalog.count(*) FROM public.public_feed_version_members member
          WHERE member.version_id = v_head_version.id) <> v_head_version.record_count
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_head_artifact)
           WITH ORDINALITY item(value, ordinality)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.public_feed_version_members member
           WHERE member.version_id = v_head_version.id
             AND member.ordinal = item.ordinality - 1
             AND member.public_id = item.value->>'publicId'
        )
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_head_artifact) item
        WHERE item->>'publicId' = p_public_id
     )
     OR EXISTS (
       SELECT 1 FROM public.public_feed_version_members member
        WHERE member.version_id = v_head_version.id
          AND member.public_id = p_public_id
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  -- Validate every immutable event, rather than accepting one matching terminal row from a
  -- contradictory history. Owner claims and recovery transitions remain valid when their epochs,
  -- actors, observations, and state continuity match the canonical protocol.
  SELECT pg_catalog.count(*) INTO v_event_count
    FROM public.public_feed_operation_events event
   WHERE event.operation_id = v_operation.id;
  IF v_event_count = 0
     OR v_event_count <> (
       SELECT pg_catalog.max(event.sequence)
         FROM public.public_feed_operation_events event
        WHERE event.operation_id = v_operation.id
     )
     OR EXISTS (
       SELECT 1
         FROM (
           SELECT
             event.*,
             pg_catalog.lag(event.to_state) OVER (ORDER BY event.sequence) AS prior_to_state,
             pg_catalog.lag(event.actor_id) OVER (ORDER BY event.sequence) AS prior_actor_id,
             pg_catalog.lag(event.owner_epoch) OVER (ORDER BY event.sequence) AS prior_owner_epoch,
             pg_catalog.lag(event.observed_storage_hash)
               OVER (ORDER BY event.sequence) AS prior_observed_hash,
             pg_catalog.lag(event.observed_storage_record_count)
               OVER (ORDER BY event.sequence) AS prior_observed_count,
             pg_catalog.lag(event.created_at) OVER (ORDER BY event.sequence) AS prior_created_at
           FROM public.public_feed_operation_events event
           WHERE event.operation_id = v_operation.id
         ) chain
        WHERE (chain.sequence = 1 AND (
                 chain.from_state IS NOT NULL
                 OR chain.to_state <> 'RESERVED'
                 OR chain.actor_id IS DISTINCT FROM v_operation.authorizing_actor_id
                 OR chain.owner_epoch <> 1
                 OR chain.observed_storage_hash IS NOT NULL
                 OR chain.observed_storage_record_count IS NOT NULL
                 OR chain.code IS NOT NULL
                 OR chain.created_at IS DISTINCT FROM v_operation.created_at
               ))
           OR (chain.sequence > 1 AND (
                 chain.from_state IS DISTINCT FROM chain.prior_to_state
                 OR chain.created_at < chain.prior_created_at
                 OR chain.owner_epoch > v_operation.owner_epoch
                 OR (
                   chain.code = 'OWNER_CLAIMED'
                   AND (
                     chain.from_state IS DISTINCT FROM chain.to_state
                     OR chain.owner_epoch <> chain.prior_owner_epoch + 1
                     OR chain.observed_storage_hash IS DISTINCT FROM chain.prior_observed_hash
                     OR chain.observed_storage_record_count IS DISTINCT FROM
                        chain.prior_observed_count
                   )
                 )
                 OR (
                   chain.code IS DISTINCT FROM 'OWNER_CLAIMED'
                   AND (
                     chain.owner_epoch IS DISTINCT FROM chain.prior_owner_epoch
                     OR chain.actor_id IS DISTINCT FROM chain.prior_actor_id
                   )
                 )
               ))
     )
     OR EXISTS (
       SELECT 1
         FROM public.public_feed_operation_events event
        WHERE event.operation_id = v_operation.id
          AND NOT (
            (event.sequence = 1 AND event.from_state IS NULL
              AND event.to_state = 'RESERVED' AND event.code IS NULL)
            OR (event.code = 'OWNER_CLAIMED' AND event.from_state = event.to_state)
            OR (event.from_state = 'RESERVED' AND event.to_state = 'PREPARED'
              AND event.code IS NULL AND event.observed_storage_hash IS NULL
              AND event.observed_storage_record_count IS NULL)
            OR (event.from_state = 'PREPARED' AND event.to_state = 'WRITE_STARTED'
              AND event.code IS NULL AND event.observed_storage_hash IS NULL
              AND event.observed_storage_record_count IS NULL)
            OR (v_no_feed_change AND event.from_state = 'PREPARED'
              AND event.to_state = 'CANDIDATE_OBSERVED' AND event.code IS NULL
              AND event.observed_storage_hash = v_operation.candidate_feed_hash
              AND event.observed_storage_record_count = v_operation.candidate_record_count)
            OR (event.from_state = 'WRITE_STARTED' AND event.to_state = 'WRITE_STARTED'
              AND event.code = 'SAME_CANDIDATE_RETRY'
              AND event.observed_storage_hash IS NULL
              AND event.observed_storage_record_count IS NULL)
            OR (event.from_state = 'WRITE_STARTED' AND event.to_state = 'CANDIDATE_OBSERVED'
              AND event.code IS NULL
              AND event.observed_storage_hash = v_operation.candidate_feed_hash
              AND event.observed_storage_record_count = v_operation.candidate_record_count)
            OR (event.to_state = 'RECOVERY_REQUIRED'
              AND event.from_state IN (
                'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED',
                'DB_FINALIZED', 'RECOVERY_REQUIRED'
              )
              AND event.code IS NOT NULL
              AND event.code NOT IN ('OWNER_CLAIMED', 'SAME_CANDIDATE_RETRY'))
            OR (event.from_state = 'RECOVERY_REQUIRED' AND event.to_state = 'WRITE_STARTED'
              AND event.code = 'RECOVERY_WRITE_RETRY'
              AND event.observed_storage_hash IS NULL
              AND event.observed_storage_record_count IS NULL)
            OR (event.from_state = 'RECOVERY_REQUIRED'
              AND event.to_state IN ('CANDIDATE_OBSERVED', 'DB_FINALIZED')
              AND event.code = 'RECOVERY_CANDIDATE_OBSERVED'
              AND event.observed_storage_hash = v_operation.candidate_feed_hash
              AND event.observed_storage_record_count = v_operation.candidate_record_count)
            OR (event.from_state = 'CANDIDATE_OBSERVED' AND event.to_state = 'DB_FINALIZED'
              AND event.code IS NOT DISTINCT FROM
                  CASE WHEN v_no_feed_change THEN 'NO_FEED_CHANGE' ELSE NULL END
              AND event.observed_storage_hash = v_operation.candidate_feed_hash
              AND event.observed_storage_record_count = v_operation.candidate_record_count)
            OR (event.from_state = 'DB_FINALIZED' AND event.to_state = 'COMPLETED'
              AND event.code IS NULL
              AND event.observed_storage_hash = v_operation.candidate_feed_hash
              AND event.observed_storage_record_count = v_operation.candidate_record_count)
          )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  SELECT event.sequence, event.actor_id, event.owner_epoch
    INTO v_finalized_sequence, v_finalization_actor_id, v_finalization_owner_epoch
    FROM public.public_feed_operation_events event
   WHERE event.operation_id = v_operation.id
     AND event.from_state = 'CANDIDATE_OBSERVED'
     AND event.to_state = 'DB_FINALIZED'
     AND event.observed_storage_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
     AND event.observed_storage_record_count IS NOT DISTINCT FROM
         v_operation.candidate_record_count
     AND event.code IS NOT DISTINCT FROM
         CASE WHEN v_no_feed_change THEN 'NO_FEED_CHANGE' ELSE NULL END
     AND event.created_at IS NOT DISTINCT FROM v_operation.finalized_at;
  IF NOT FOUND OR (
    SELECT pg_catalog.count(*)
      FROM public.public_feed_operation_events event
     WHERE event.operation_id = v_operation.id
       AND event.from_state = 'CANDIDATE_OBSERVED'
       AND event.to_state = 'DB_FINALIZED'
  ) <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  SELECT event.sequence INTO v_completed_sequence
    FROM public.public_feed_operation_events event
   WHERE event.operation_id = v_operation.id
     AND event.from_state = 'DB_FINALIZED'
     AND event.to_state = 'COMPLETED'
     AND event.actor_id = v_operation.completion_actor_id
     AND event.owner_epoch = v_operation.owner_epoch
     AND event.observed_storage_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
     AND event.observed_storage_record_count IS NOT DISTINCT FROM
         v_operation.candidate_record_count
     AND event.code IS NULL
     AND event.created_at IS NOT DISTINCT FROM v_operation.completed_at;
  IF NOT FOUND
     OR v_completed_sequence <= v_finalized_sequence
     OR v_completed_sequence <> v_event_count
     OR (SELECT pg_catalog.count(*) FROM public.public_feed_operation_events event
          WHERE event.operation_id = v_operation.id
            AND event.to_state = 'COMPLETED') <> 1
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  -- Bind the selected removal to the latest real published-origin archive that existed when it
  -- finalized. A no-change removal of an already archived project legitimately creates no new audit.
  SELECT pg_catalog.max(audit.created_at) INTO v_archive_audit_time
    FROM public.approval_records audit
   WHERE audit.project_id = p_project_id
     AND audit.action_taken = 'archive'
     AND audit.from_status = 'published'
     AND audit.to_status = 'archived'
     AND audit.created_at <= v_operation.finalized_at;
  SELECT pg_catalog.count(*) INTO v_archive_audit_count
    FROM public.approval_records audit
   WHERE audit.project_id = p_project_id
     AND audit.action_taken = 'archive'
     AND audit.from_status = 'published'
     AND audit.to_status = 'archived'
     AND audit.created_at IS NOT DISTINCT FROM v_archive_audit_time;
  IF v_archive_audit_time IS NULL OR v_archive_audit_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;
  SELECT * INTO v_archive_audit
    FROM public.approval_records audit
   WHERE audit.project_id = p_project_id
     AND audit.action_taken = 'archive'
     AND audit.from_status = 'published'
     AND audit.to_status = 'archived'
     AND audit.created_at IS NOT DISTINCT FROM v_archive_audit_time;
  IF p_archived_from_status = 'published'
     AND p_archived_at IS DISTINCT FROM v_archive_audit.created_at
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  SELECT pg_catalog.count(*) INTO v_operation_version_count
    FROM public.public_feed_versions version
   WHERE version.operation_id = v_operation.id;
  IF (v_no_feed_change AND v_operation_version_count <> 0)
     OR (NOT v_no_feed_change AND v_operation_version_count <> 1)
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  IF v_no_feed_change THEN
    IF v_operation.candidate_feed_content IS DISTINCT FROM v_operation.baseline_feed_content
       OR v_operation.candidate_feed_hash IS DISTINCT FROM v_operation.baseline_feed_hash
       OR v_operation.candidate_record_count IS DISTINCT FROM v_operation.baseline_record_count
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
        'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
        'previouslyPublished', true
      );
    END IF;
    v_anchor_version_id := v_baseline_version.id;
  ELSE
    SELECT * INTO v_removal_version
      FROM public.public_feed_versions version
     WHERE version.operation_id = v_operation.id;
    IF v_removal_version.operation IS DISTINCT FROM 'removal'
       OR v_removal_version.publication_mode IS NOT NULL
       OR v_removal_version.previous_version_id IS DISTINCT FROM v_baseline_version.id
       OR v_removal_version.restored_from_version_id IS NOT NULL
       OR v_removal_version.project_id IS DISTINCT FROM p_project_id
       OR v_removal_version.affected_public_id IS DISTINCT FROM p_public_id
       OR v_removal_version.authorizing_actor_id IS DISTINCT FROM
          v_operation.authorizing_actor_id
       OR v_removal_version.completion_actor_id IS DISTINCT FROM v_finalization_actor_id
       OR v_removal_version.artifact_content IS DISTINCT FROM
          v_operation.candidate_feed_content
       OR v_removal_version.feed_hash IS DISTINCT FROM v_operation.candidate_feed_hash
       OR v_removal_version.record_count IS DISTINCT FROM v_operation.candidate_record_count
       OR v_removal_version.byte_count IS DISTINCT FROM
          pg_catalog.octet_length(v_removal_version.artifact_content)
       OR v_removal_version.feed_hash IS DISTINCT FROM pg_catalog.encode(
         extensions.digest(
           pg_catalog.convert_to(v_removal_version.artifact_content, 'UTF8'),
           'sha256'
         ),
         'hex'
       )
       OR v_removal_version.created_at IS DISTINCT FROM v_operation.finalized_at
       OR (SELECT pg_catalog.count(*) FROM public.public_feed_version_members member
            WHERE member.version_id = v_removal_version.id) <>
          v_removal_version.record_count
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(v_operation.candidate_members)
             WITH ORDINALITY manifest(value, ordinality)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.public_feed_version_members member
             WHERE member.version_id = v_removal_version.id
               AND member.ordinal = manifest.ordinality - 1
               AND member.public_id = manifest.value->>'publicId'
               AND member.record_hash = manifest.value->>'recordHash'
          )
       )
       OR (
         v_removal_version.audit_record_id IS NOT NULL
         AND (
           v_removal_version.audit_record_id IS DISTINCT FROM v_archive_audit.id
           OR v_archive_audit.created_at IS DISTINCT FROM v_operation.finalized_at
           OR v_archive_audit.admin_id IS DISTINCT FROM v_operation.authorizing_actor_id
         )
       )
       OR (
         v_removal_version.audit_record_id IS NULL
         AND v_archive_audit.created_at >= v_operation.finalized_at
       )
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
        'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
        'previouslyPublished', true
      );
    END IF;
    v_anchor_version_id := v_removal_version.id;
  END IF;

  IF NOT EXISTS (
    WITH RECURSIVE lineage(id, previous_version_id) AS (
      SELECT version.id, version.previous_version_id
        FROM public.public_feed_versions version
       WHERE version.id = v_head_version.id
      UNION
      SELECT previous.id, previous.previous_version_id
        FROM lineage current_version
        JOIN public.public_feed_versions previous
          ON previous.id = current_version.previous_version_id
    )
    SELECT 1 FROM lineage WHERE lineage.id = v_anchor_version_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.public_feed_operations later_operation
     WHERE later_operation.id <> v_operation.id
       AND later_operation.project_id = p_project_id
       AND later_operation.public_id = p_public_id
       AND later_operation.kind IN ('publication', 'removal')
       AND later_operation.state = 'COMPLETED'
       AND later_operation.completed_at >= v_operation.completed_at
  ) OR EXISTS (
    SELECT 1
      FROM public.public_feed_versions later_version
     WHERE (
       (NOT v_no_feed_change
         AND later_version.version_number > v_removal_version.version_number)
       OR (v_no_feed_change
         AND later_version.id <> v_baseline_version.id
         AND later_version.created_at >= v_operation.completed_at)
     )
       AND (
         (
           later_version.operation IN ('publication', 'removal')
           AND later_version.project_id = p_project_id
           AND later_version.affected_public_id = p_public_id
         )
         OR EXISTS (
           SELECT 1 FROM public.public_feed_version_members member
            WHERE member.version_id = later_version.id
              AND member.public_id = p_public_id
         )
       )
  ) OR EXISTS (
    SELECT 1 FROM public.approval_records audit
     WHERE audit.project_id = p_project_id
       AND audit.action_taken = 'publish'
       AND audit.created_at >= v_operation.completed_at
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'REMOVAL_EVIDENCE_AMBIGUOUS',
      'reason', 'The project has incomplete or contradictory historical public-removal evidence.',
      'previouslyPublished', true
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'ELIGIBLE',
    'reason', 'Canonical evidence proves this previously published project is no longer public.',
    'previouslyPublished', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.project_soft_delete_decision(
  uuid, text, text, timestamptz, boolean, timestamptz, timestamptz, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_project_soft_delete_preflight(
  p_public_ids text[],
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_project public.projects%ROWTYPE;
  v_decision jsonb;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'SOFT_DELETE_ADMIN_ID_REQUIRED'; END IF;
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RAISE EXCEPTION 'SOFT_DELETE_PERMISSION_DENIED';
  END IF;

  IF p_public_ids IS NULL
     OR pg_catalog.cardinality(p_public_ids) NOT BETWEEN 1 AND 50
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(p_public_ids) requested(public_id)
        WHERE requested.public_id IS NULL
           OR requested.public_id !~ '^[A-Za-z0-9_-]{1,100}$'
     )
     OR pg_catalog.cardinality(p_public_ids) <> (
       SELECT pg_catalog.count(DISTINCT requested.public_id)
         FROM pg_catalog.unnest(p_public_ids) requested(public_id)
     )
  THEN
    RAISE EXCEPTION 'SOFT_DELETE_INPUT_INVALID';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );

  FOREACH v_public_id IN ARRAY p_public_ids LOOP
    v_project := NULL;
    SELECT project.* INTO v_project
      FROM public.projects project
     WHERE project.public_id = v_public_id;

    IF v_project.id IS NULL THEN
      v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'publicId', v_public_id,
        'title', 'Project unavailable',
        'status', NULL,
        'updatedAt', NULL,
        'disposition', 'blocked',
        'reasonCode', 'PROJECT_NOT_FOUND',
        'reason', 'The project could not be found.',
        'previouslyPublished', false
      ));
      CONTINUE;
    END IF;

    v_decision := public.project_soft_delete_decision(
      v_project.id,
      v_project.public_id,
      v_project.status,
      v_project.deleted_at,
      v_project.pending_removal_from_public,
      v_project.public_removal_completed_at,
      v_project.archived_at,
      v_project.archived_from_status
    );

    v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'publicId', v_project.public_id,
      'title', v_project.title,
      'status', v_project.status,
      'updatedAt', v_project.updated_at,
      'disposition', CASE v_decision->>'resultCode'
        WHEN 'ELIGIBLE' THEN 'eligible'
        WHEN 'ALREADY_DELETED' THEN 'already_deleted'
        ELSE 'blocked'
      END,
      'reasonCode', v_decision->>'resultCode',
      'reason', v_decision->>'reason',
      'previouslyPublished', COALESCE((v_decision->>'previouslyPublished')::boolean, false)
    ));
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.get_project_soft_delete_preflight(text[], uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_soft_delete_preflight(text[], uuid)
TO service_role;

CREATE FUNCTION public.soft_delete_project_if_current(
  p_public_id text,
  p_expected_updated_at timestamptz,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_project public.projects%ROWTYPE;
  v_decision jsonb;
  v_deleted_at timestamptz;
  v_audit_record_id uuid;
  v_actor_full_name text;
  v_actor_email text;
BEGIN
  IF p_public_id IS NULL THEN RAISE EXCEPTION 'SOFT_DELETE_PUBLIC_ID_REQUIRED'; END IF;
  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id !~ '^[A-Za-z0-9_-]{1,100}$' OR p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'SOFT_DELETE_INPUT_INVALID';
  END IF;
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'SOFT_DELETE_ADMIN_ID_REQUIRED'; END IF;

  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RAISE EXCEPTION 'SOFT_DELETE_PERMISSION_DENIED';
  END IF;
  SELECT staff.full_name, staff.email
    INTO v_actor_full_name, v_actor_email
    FROM public.admin_users staff
   WHERE staff.id = p_admin_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOFT_DELETE_PERMISSION_DENIED'; END IF;

  -- Canonical writer lock always precedes the project row lock, matching publication, removal,
  -- recovery, and M59 restore. A delete can therefore never interleave with feed membership work.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );

  SELECT project.* INTO v_project
    FROM public.projects project
   WHERE project.public_id = v_public_id
   FOR UPDATE;
  IF v_project.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  IF v_project.status = 'deleted' AND v_project.deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_DELETED',
      'publicId', v_project.public_id,
      'status', v_project.status,
      'deletedAt', v_project.deleted_at
    );
  END IF;

  IF v_project.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'STALE_VERSION',
      'publicId', v_project.public_id,
      'status', v_project.status
    );
  END IF;

  v_decision := public.project_soft_delete_decision(
    v_project.id,
    v_project.public_id,
    v_project.status,
    v_project.deleted_at,
    v_project.pending_removal_from_public,
    v_project.public_removal_completed_at,
    v_project.archived_at,
    v_project.archived_from_status
  );
  IF v_decision->>'resultCode' <> 'ELIGIBLE' THEN
    RETURN v_decision || pg_catalog.jsonb_build_object(
      'publicId', v_project.public_id,
      'status', v_project.status
    );
  END IF;

  v_deleted_at := pg_catalog.now();
  UPDATE public.projects
     SET status = 'deleted',
         deleted_at = v_deleted_at
   WHERE id = v_project.id
     AND status = v_project.status
     AND deleted_at IS NULL
     AND updated_at IS NOT DISTINCT FROM p_expected_updated_at;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'STALE_VERSION',
      'publicId', v_project.public_id,
      'status', v_project.status
    );
  END IF;

  INSERT INTO public.approval_records(
    project_id,
    admin_id,
    action_taken,
    from_status,
    to_status,
    comments,
    created_at,
    actor_full_name_snapshot,
    actor_email_snapshot,
    event_details
  ) VALUES (
    v_project.id,
    p_admin_id,
    'soft_delete',
    v_project.status,
    'deleted',
    'Soft delete retained the project row, assets, participant evidence, publication history, and audit history.',
    v_deleted_at,
    v_actor_full_name,
    v_actor_email,
    pg_catalog.jsonb_build_object(
      'version', 1,
      'type', 'project_soft_delete',
      'fromStatus', v_project.status,
      'toStatus', 'deleted',
      'deletedAt', v_deleted_at,
      'previouslyPublished', COALESCE((v_decision->>'previouslyPublished')::boolean, false),
      'retained', pg_catalog.jsonb_build_array(
        'project', 'media', 'approval_records', 'participant_evidence',
        'publication_history', 'feed_versions'
      )
    )
  ) RETURNING id INTO v_audit_record_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'DELETED',
    'publicId', v_project.public_id,
    'status', 'deleted',
    'fromStatus', v_project.status,
    'deletedAt', v_deleted_at,
    'auditRecordId', v_audit_record_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_project_if_current(text, timestamptz, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_project_if_current(text, timestamptz, uuid)
TO service_role;

-- A soft-delete event is permanent evidence. Blocking update/delete of that exact audit type also
-- prevents a later physical project-row delete from cascading away its lifecycle record.
CREATE FUNCTION public.guard_soft_delete_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.action_taken = 'soft_delete' THEN
    RAISE EXCEPTION 'SOFT_DELETE_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_soft_delete_audit_immutable()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER soft_delete_audit_immutable
BEFORE UPDATE OR DELETE ON public.approval_records
FOR EACH ROW EXECUTE FUNCTION public.guard_soft_delete_audit_immutable();

CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT '20260917120000_governed_project_soft_delete|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1|archived_project_republish_media_rearm_v1|governed_project_soft_delete_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()
TO service_role;

COMMIT;
