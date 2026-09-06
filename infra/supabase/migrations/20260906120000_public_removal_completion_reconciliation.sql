-- Migration 0052 / Issue #268: make public-removal completion and project reconciliation one transaction.

BEGIN;

CREATE OR REPLACE FUNCTION public.complete_public_feed_operation(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid,
  p_observed_hash text,
  p_observed_record_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.public_feed_operations%ROWTYPE;
  v_head_version public.public_feed_versions%ROWTYPE;
  v_operation_version public.public_feed_versions%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_project_was_pending boolean;
  v_completed_at timestamptz;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF v_operation.state = 'COMPLETED' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPLETED'); END IF;
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  IF v_operation.state <> 'DB_FINALIZED' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE'); END IF;

  SELECT v.* INTO v_head_version
    FROM public.public_feed_head h JOIN public.public_feed_versions v ON v.id = h.current_version_id
   WHERE h.singleton = true;
  IF v_head_version.id IS NULL
     OR v_head_version.feed_hash IS DISTINCT FROM p_observed_hash
     OR v_head_version.record_count IS DISTINCT FROM p_observed_record_count
     OR v_operation.candidate_feed_hash IS DISTINCT FROM p_observed_hash
     OR v_operation.candidate_record_count IS DISTINCT FROM p_observed_record_count
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OBSERVATION_MISMATCH'); END IF;

  IF v_operation.kind = 'removal' THEN
    SELECT * INTO v_project
      FROM public.projects
     WHERE id = v_operation.project_id
     FOR UPDATE;
    IF v_project.id IS NULL
       OR v_project.deleted_at IS NOT NULL
       OR v_project.public_id IS DISTINCT FROM v_operation.public_id
       OR v_project.status <> 'archived'
       OR v_project.archived_from_status IS DISTINCT FROM 'published'
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PROJECT_STATE'); END IF;
    v_project_was_pending := v_project.pending_removal_from_public IS TRUE
      AND v_project.public_removal_completed_at IS NULL;

    -- A changed removal must still own the exact current head version. A no-change removal writes
    -- no version, so its exact bound baseline must remain the head. Either shape must prove that
    -- the target is absent before lifecycle state can truthfully say removal is complete.
    SELECT * INTO v_operation_version
      FROM public.public_feed_versions
     WHERE operation_id = v_operation.id;
    IF v_operation_version.id IS NOT NULL THEN
      IF v_operation_version.operation <> 'removal'
         OR v_operation_version.id IS DISTINCT FROM v_head_version.id
         OR v_operation_version.previous_version_id IS DISTINCT FROM v_operation.baseline_version_id
         OR v_operation_version.project_id IS DISTINCT FROM v_operation.project_id
         OR v_operation_version.affected_public_id IS DISTINCT FROM v_operation.public_id
         OR v_operation_version.feed_hash IS DISTINCT FROM v_operation.candidate_feed_hash
         OR v_operation_version.record_count IS DISTINCT FROM v_operation.candidate_record_count
         OR v_operation_version.artifact_content IS DISTINCT FROM v_operation.candidate_feed_content
         OR NOT EXISTS (
           SELECT 1
             FROM public.public_feed_version_members m
            WHERE m.version_id = v_operation.baseline_version_id
              AND m.public_id = v_operation.public_id
         )
      THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;
    ELSIF v_head_version.id IS DISTINCT FROM v_operation.baseline_version_id
       OR v_operation.candidate_feed_hash IS DISTINCT FROM v_operation.baseline_feed_hash
       OR v_operation.candidate_record_count IS DISTINCT FROM v_operation.baseline_record_count
       OR v_operation.candidate_feed_content IS DISTINCT FROM v_operation.baseline_feed_content
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;

    IF EXISTS (
      SELECT 1
        FROM public.public_feed_version_members m
       WHERE m.version_id = v_head_version.id
         AND m.public_id = v_operation.public_id
    ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;

    -- Rollback can deliberately restore an older canonical version containing a project whose
    -- lifecycle remains archived and whose earlier removal is already complete. A subsequent
    -- changed removal is compatible only when the immutable baseline proves that restoration.
    -- No-change removals and every other project-state shape still require the normal pending
    -- transition established by DB finalization.
    IF NOT v_project_was_pending
       AND (
         v_operation_version.id IS NULL
         OR v_project.pending_removal_from_public IS DISTINCT FROM false
         OR v_project.public_removal_completed_at IS NULL
       )
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PROJECT_STATE'); END IF;
  END IF;

  v_completed_at := pg_catalog.now();
  IF v_operation.kind = 'removal' THEN
    -- The active-operation trigger permits only this exact fenced operation to mutate its target.
    PERFORM pg_catalog.set_config('app.public_feed_operation_id', v_operation.id::text, true);
    UPDATE public.projects
       SET pending_removal_from_public = false,
           public_removal_completed_at = v_completed_at
     WHERE id = v_operation.project_id
       AND public_id = v_operation.public_id
       AND deleted_at IS NULL
       AND status = 'archived'
       AND archived_from_status = 'published'
       AND (
         (pending_removal_from_public = true AND public_removal_completed_at IS NULL)
         OR (
           v_operation_version.id IS NOT NULL
           AND pending_removal_from_public = false
           AND public_removal_completed_at IS NOT NULL
         )
       );
    IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PROJECT_STATE'); END IF;
  END IF;

  UPDATE public.public_feed_operations
     SET state = 'COMPLETED', observed_storage_hash = p_observed_hash,
         observed_storage_record_count = p_observed_record_count,
         completed_at = v_completed_at, updated_at = v_completed_at,
         lease_expires_at = v_completed_at, recovery_from_state = NULL
   WHERE id = p_operation_id;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, 'DB_FINALIZED', 'COMPLETED', p_actor_id, p_owner_epoch,
    p_observed_hash, p_observed_record_count
  );
  RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPLETED');
END;
$$;

REVOKE ALL ON FUNCTION public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer)
TO service_role;

-- Reconcile only historical project rows whose one completed removal is supported by the exact
-- immutable completion event and either its exact removal version or its exact no-change baseline.
-- Anything completed-but-ambiguous remains pending and emits a bounded migration warning.
DO $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_operation public.public_feed_operations%ROWTYPE;
  v_version public.public_feed_versions%ROWTYPE;
  v_baseline_version public.public_feed_versions%ROWTYPE;
  v_completed_removal_count integer;
  v_completion_event_count integer;
  v_proof_valid boolean;
  v_later_contradiction boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));

  FOR v_project IN
    SELECT p.*
      FROM public.projects p
     WHERE p.deleted_at IS NULL
       AND p.status = 'archived'
       AND p.archived_from_status = 'published'
       AND p.pending_removal_from_public = true
       AND p.public_removal_completed_at IS NULL
     ORDER BY p.id
     FOR UPDATE
  LOOP
    SELECT pg_catalog.count(*)
      INTO v_completed_removal_count
      FROM public.public_feed_operations o
     WHERE o.project_id = v_project.id
       AND o.public_id = v_project.public_id
       AND o.kind = 'removal'
       AND o.state = 'COMPLETED'
       AND o.completed_at IS NOT NULL;

    -- An incomplete/failed/no-operation row is not historical completion evidence. Multiple
    -- completed removals are intentionally not ordered or guessed between.
    IF v_completed_removal_count = 0 THEN CONTINUE; END IF;
    IF v_completed_removal_count <> 1 THEN
      RAISE WARNING 'PUBLIC_REMOVAL_RECONCILIATION_AMBIGUOUS: %', v_project.public_id;
      CONTINUE;
    END IF;

    SELECT * INTO v_operation
      FROM public.public_feed_operations o
     WHERE o.project_id = v_project.id
       AND o.public_id = v_project.public_id
       AND o.kind = 'removal'
       AND o.state = 'COMPLETED'
       AND o.completed_at IS NOT NULL;

    SELECT pg_catalog.count(*)
      INTO v_completion_event_count
      FROM public.public_feed_operation_events e
     WHERE e.operation_id = v_operation.id
       AND e.from_state = 'DB_FINALIZED'
       AND e.to_state = 'COMPLETED'
       AND e.actor_id = v_operation.completion_actor_id
       AND e.owner_epoch = v_operation.owner_epoch
       AND e.observed_storage_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
       AND e.observed_storage_record_count IS NOT DISTINCT FROM v_operation.candidate_record_count
       AND e.code IS NULL;

    v_proof_valid := v_operation.finalized_at IS NOT NULL
      AND v_operation.completed_at >= v_operation.finalized_at
      AND v_operation.failure_code IS NULL
      AND v_operation.observed_storage_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
      AND v_operation.observed_storage_record_count IS NOT DISTINCT FROM v_operation.candidate_record_count
      AND v_operation.candidate_feed_content IS NOT NULL
      AND v_operation.candidate_feed_hash IS NOT NULL
      AND v_operation.candidate_record_count IS NOT NULL
      AND v_operation.candidate_byte_count IS NOT NULL
      AND v_operation.candidate_byte_count = pg_catalog.octet_length(v_operation.candidate_feed_content)
      AND v_operation.candidate_feed_hash = pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(v_operation.candidate_feed_content, 'UTF8'), 'sha256'),
        'hex'
      )
      AND v_completion_event_count = 1
      AND (
        SELECT pg_catalog.count(*)
          FROM public.public_feed_operation_events e
         WHERE e.operation_id = v_operation.id
           AND e.from_state = 'DB_FINALIZED'
           AND e.to_state = 'COMPLETED'
      ) = 1;

    SELECT * INTO v_version
      FROM public.public_feed_versions v
     WHERE v.operation_id = v_operation.id;
    SELECT * INTO v_baseline_version
      FROM public.public_feed_versions v
     WHERE v.id = v_operation.baseline_version_id;

    IF v_version.id IS NOT NULL THEN
      v_proof_valid := v_proof_valid
        AND v_version.operation = 'removal'
        AND v_version.previous_version_id IS NOT DISTINCT FROM v_operation.baseline_version_id
        AND v_version.project_id IS NOT DISTINCT FROM v_project.id
        AND v_version.affected_public_id IS NOT DISTINCT FROM v_project.public_id
        AND v_version.authorizing_actor_id IS NOT DISTINCT FROM v_operation.authorizing_actor_id
        AND v_version.completion_actor_id IS NOT DISTINCT FROM v_operation.completion_actor_id
        AND v_version.artifact_content IS NOT DISTINCT FROM v_operation.candidate_feed_content
        AND v_version.feed_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
        AND v_version.record_count IS NOT DISTINCT FROM v_operation.candidate_record_count
        AND v_version.byte_count = pg_catalog.octet_length(v_version.artifact_content)
        AND v_version.feed_hash = pg_catalog.encode(
          extensions.digest(pg_catalog.convert_to(v_version.artifact_content, 'UTF8'), 'sha256'),
          'hex'
        )
        AND (SELECT pg_catalog.count(*) FROM public.public_feed_version_members m
              WHERE m.version_id = v_version.id) = v_version.record_count
        AND EXISTS (
          SELECT 1 FROM public.public_feed_version_members m
           WHERE m.version_id = v_operation.baseline_version_id
             AND m.public_id = v_project.public_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.public_feed_version_members m
           WHERE m.version_id = v_version.id
             AND m.public_id = v_project.public_id
        );

      SELECT EXISTS (
        SELECT 1
          FROM public.public_feed_versions later
         WHERE later.version_number > v_version.version_number
           AND (
             (
               later.operation = 'publication'
               AND later.project_id = v_project.id
               AND later.affected_public_id = v_project.public_id
             )
             OR EXISTS (
               SELECT 1 FROM public.public_feed_version_members m
                WHERE m.version_id = later.id
                  AND m.public_id = v_project.public_id
             )
           )
      ) INTO v_later_contradiction;
    ELSE
      -- A legitimate no-change removal writes no new version. Its immutable completion event,
      -- exact baseline equality, and target absence from that baseline are the durable proof.
      v_proof_valid := v_proof_valid
        AND v_baseline_version.id IS NOT NULL
        AND v_operation.baseline_storage_existed = true
        AND v_operation.candidate_feed_content IS NOT DISTINCT FROM v_operation.baseline_feed_content
        AND v_operation.candidate_feed_hash IS NOT DISTINCT FROM v_operation.baseline_feed_hash
        AND v_operation.candidate_record_count IS NOT DISTINCT FROM v_operation.baseline_record_count
        AND v_baseline_version.artifact_content IS NOT DISTINCT FROM v_operation.candidate_feed_content
        AND v_baseline_version.feed_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
        AND v_baseline_version.record_count IS NOT DISTINCT FROM v_operation.candidate_record_count
        AND (SELECT pg_catalog.count(*) FROM public.public_feed_version_members m
              WHERE m.version_id = v_baseline_version.id) = v_baseline_version.record_count
        AND NOT EXISTS (
          SELECT 1 FROM public.public_feed_version_members m
           WHERE m.version_id = v_baseline_version.id
             AND m.public_id = v_project.public_id
        );

      SELECT EXISTS (
        SELECT 1
          FROM public.public_feed_versions later
         WHERE later.id <> v_baseline_version.id
           AND later.created_at >= v_operation.completed_at
           AND (
             (
               later.operation = 'publication'
               AND later.project_id = v_project.id
               AND later.affected_public_id = v_project.public_id
             )
             OR EXISTS (
               SELECT 1 FROM public.public_feed_version_members m
                WHERE m.version_id = later.id
                  AND m.public_id = v_project.public_id
             )
           )
      ) INTO v_later_contradiction;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.public_feed_head h
        JOIN public.public_feed_version_members m ON m.version_id = h.current_version_id
       WHERE h.singleton = true
         AND m.public_id = v_project.public_id
    ) THEN v_later_contradiction := true; END IF;

    IF v_proof_valid IS DISTINCT FROM true OR v_later_contradiction IS TRUE THEN
      RAISE WARNING 'PUBLIC_REMOVAL_RECONCILIATION_AMBIGUOUS: %', v_project.public_id;
      CONTINUE;
    END IF;

    UPDATE public.projects
       SET pending_removal_from_public = false,
           public_removal_completed_at = v_operation.completed_at
     WHERE id = v_project.id
       AND status = 'archived'
       AND archived_from_status = 'published'
       AND pending_removal_from_public = true
       AND public_removal_completed_at IS NULL;
  END LOOP;
END;
$$;

COMMIT;
