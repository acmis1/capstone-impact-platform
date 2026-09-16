-- Migration 0059: safe restoration of archived projects.
--
-- The existing review authority remains byte-for-byte executable under an internal, revoked
-- helper name. The public service-role RPC wraps it only to add the restore action. This avoids
-- duplicating or weakening the established approval, request-changes, and archive gates.

BEGIN;

ALTER FUNCTION public.perform_project_review_action(text, text, text, uuid)
  RENAME TO perform_project_review_action_without_restore;

REVOKE ALL ON FUNCTION public.perform_project_review_action_without_restore(text, text, text, uuid)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.perform_project_review_action(
  p_public_id text,
  p_action text,
  p_comments text,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_comments text;
  v_roles text[];
  v_project_id uuid;
  v_from_status text;
  v_archive_origin text;
  v_restore_status text;
  v_archived_at timestamptz;
  v_archive_reason text;
  v_pending_removal boolean;
  v_public_removal_completed_at timestamptz;
  v_archive_audit_count integer;
  v_completed_removal_count integer;
  v_audit_record_id uuid;
  v_actor_full_name text;
  v_actor_email text;
BEGIN
  IF p_action IS DISTINCT FROM 'restore' THEN
    RETURN public.perform_project_review_action_without_restore(
      p_public_id,
      p_action,
      p_comments,
      p_admin_id
    );
  END IF;

  IF p_public_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  IF pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'REVIEW_PUBLIC_ID_INVALID';
  END IF;

  v_comments := NULLIF(pg_catalog.btrim(COALESCE(p_comments, '')), '');
  IF v_comments IS NOT NULL AND pg_catalog.length(v_comments) > 4000 THEN
    RAISE EXCEPTION 'REVIEW_COMMENTS_TOO_LONG';
  END IF;
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'REVIEW_ADMIN_ID_REQUIRED'; END IF;

  SELECT pg_catalog.array_agg(r.role ORDER BY r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles)) THEN
    RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED';
  END IF;

  SELECT staff.full_name, staff.email
    INTO v_actor_full_name, v_actor_email
    FROM public.admin_users staff
   WHERE staff.id = p_admin_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED'; END IF;

  -- Match the canonical writer lock order before taking the project row lock. A restore can never
  -- race a bound publication/removal/rollback candidate into an unsafe lifecycle/feed split.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );

  SELECT
    p.id,
    p.status,
    p.archived_from_status,
    p.archived_at,
    p.archive_reason,
    p.pending_removal_from_public,
    p.public_removal_completed_at
  INTO
    v_project_id,
    v_from_status,
    v_archive_origin,
    v_archived_at,
    v_archive_reason,
    v_pending_removal,
    v_public_removal_completed_at
  FROM public.projects p
  WHERE p.public_id = v_public_id
    AND p.deleted_at IS NULL
  FOR UPDATE;

  IF v_project_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PROJECT_NOT_FOUND'; END IF;
  IF v_from_status <> 'archived' THEN RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;

  v_restore_status := CASE v_archive_origin
    WHEN 'submitted' THEN 'submitted'
    WHEN 'in_review' THEN 'in_review'
    WHEN 'approved' THEN 'approved'
    WHEN 'published' THEN 'approved'
    ELSE NULL
  END;

  IF v_restore_status IS NULL
     OR v_archived_at IS NULL
     OR pg_catalog.btrim(COALESCE(v_archive_reason, '')) = ''
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ARCHIVE_PROVENANCE_AMBIGUOUS');
  END IF;

  -- The row provenance is accepted only when the one atomic archive audit created at the same
  -- transaction timestamp agrees with it. Missing, duplicated, or contradictory evidence fails
  -- closed instead of defaulting the project to Approved.
  SELECT pg_catalog.count(*)
    INTO v_archive_audit_count
    FROM public.approval_records audit
   WHERE audit.project_id = v_project_id
     AND audit.action_taken = 'archive'
     AND audit.created_at IS NOT DISTINCT FROM v_archived_at;

  IF v_archive_audit_count <> 1 OR NOT EXISTS (
    SELECT 1
      FROM public.approval_records matching
     WHERE matching.project_id = v_project_id
       AND matching.action_taken = 'archive'
       AND matching.created_at IS NOT DISTINCT FROM v_archived_at
       AND matching.from_status IS NOT DISTINCT FROM v_archive_origin
       AND matching.to_status IS NOT DISTINCT FROM 'archived'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ARCHIVE_PROVENANCE_AMBIGUOUS');
  END IF;

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
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLICATION_IN_PROGRESS');
  END IF;

  -- Restoration never writes deployment history. It may proceed only if the current immutable
  -- head already proves the target absent, so changing the lifecycle row cannot expose content.
  IF EXISTS (
    SELECT 1
      FROM public.public_feed_head head
      JOIN public.public_feed_version_members member
        ON member.version_id = head.current_version_id
     WHERE head.singleton = true
       AND member.public_id = v_public_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'RESTORE_PUBLIC_FEED_UNSAFE');
  END IF;

  IF v_archive_origin = 'published' THEN
    IF v_pending_removal IS DISTINCT FROM false
       OR v_public_removal_completed_at IS NULL
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED');
    END IF;

    IF v_public_removal_completed_at < v_archived_at THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ARCHIVE_PROVENANCE_AMBIGUOUS');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.public_feed_head head WHERE head.singleton = true
    ) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'RESTORE_PUBLIC_FEED_UNSAFE');
    END IF;

    SELECT pg_catalog.count(*)
      INTO v_completed_removal_count
      FROM public.public_feed_operations operation
     WHERE operation.project_id = v_project_id
       AND operation.public_id = v_public_id
       AND operation.kind = 'removal'
       AND operation.state = 'COMPLETED'
       AND operation.completed_at IS NOT DISTINCT FROM v_public_removal_completed_at;

    IF v_completed_removal_count <> 1 OR NOT EXISTS (
      SELECT 1
        FROM public.public_feed_operations operation
       WHERE operation.project_id = v_project_id
         AND operation.public_id = v_public_id
         AND operation.kind = 'removal'
         AND operation.state = 'COMPLETED'
         AND operation.completed_at IS NOT DISTINCT FROM v_public_removal_completed_at
       AND operation.finalized_at IS NOT NULL
       AND operation.completed_at >= operation.finalized_at
       AND operation.finalized_at >= v_archived_at
       AND operation.failure_code IS NULL
       AND operation.completion_actor_id IS NOT NULL
       AND operation.candidate_feed_content IS NOT NULL
       AND operation.candidate_feed_hash IS NOT NULL
       AND operation.candidate_record_count IS NOT NULL
       AND operation.candidate_byte_count = pg_catalog.octet_length(operation.candidate_feed_content)
       AND operation.candidate_feed_hash = pg_catalog.encode(
         extensions.digest(pg_catalog.convert_to(operation.candidate_feed_content, 'UTF8'), 'sha256'),
         'hex'
       )
       AND operation.observed_storage_hash IS NOT DISTINCT FROM operation.candidate_feed_hash
       AND operation.observed_storage_record_count IS NOT DISTINCT FROM operation.candidate_record_count
       AND (
         SELECT pg_catalog.count(*)
           FROM public.public_feed_operation_events event
          WHERE event.operation_id = operation.id
            AND event.from_state = 'DB_FINALIZED'
            AND event.to_state = 'COMPLETED'
            AND event.actor_id = operation.completion_actor_id
            AND event.owner_epoch = operation.owner_epoch
             AND event.observed_storage_hash IS NOT DISTINCT FROM operation.candidate_feed_hash
             AND event.observed_storage_record_count IS NOT DISTINCT FROM operation.candidate_record_count
             AND event.code IS NULL
        ) = 1
    ) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ARCHIVE_PROVENANCE_AMBIGUOUS');
    END IF;
  END IF;

  UPDATE public.projects
     SET status = v_restore_status,
         archived_at = NULL,
         archived_from_status = NULL,
         archive_reason = NULL,
         pending_removal_from_public = false
   WHERE id = v_project_id
     AND status = 'archived'
     AND archived_at IS NOT DISTINCT FROM v_archived_at
     AND archived_from_status IS NOT DISTINCT FROM v_archive_origin;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;

  INSERT INTO public.approval_records(
    project_id,
    admin_id,
    action_taken,
    from_status,
    to_status,
    comments,
    actor_full_name_snapshot,
    actor_email_snapshot,
    event_details
  ) VALUES (
    v_project_id,
    p_admin_id,
    'restore',
    'archived',
    v_restore_status,
    v_comments,
    v_actor_full_name,
    v_actor_email,
    pg_catalog.jsonb_build_object(
      'version', 1,
      'type', 'archived_project_restore',
      'archivedFromStatus', v_archive_origin,
      'restoredStatus', v_restore_status,
      'republishRequired', v_archive_origin = 'published'
    )
  ) RETURNING id INTO v_audit_record_id;

  RETURN pg_catalog.jsonb_build_object(
    'publicId', v_public_id,
    'status', v_restore_status,
    'auditRecordId', v_audit_record_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.perform_project_review_action(text, text, text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid)
TO service_role;

CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT '20260916120000_archived_project_restore|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()
TO service_role;

COMMIT;
