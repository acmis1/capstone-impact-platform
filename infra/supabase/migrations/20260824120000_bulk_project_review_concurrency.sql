-- Bulk project review concurrency fence.
-- This wrapper owns no workflow/readiness/audit rules; it only serializes a bounded action
-- against the current projects.updated_at value before delegating to existing authorities.

BEGIN;

CREATE OR REPLACE FUNCTION public.perform_project_workflow_action_if_current(
  p_public_id text,
  p_action text,
  p_comments text,
  p_admin_id uuid,
  p_expected_updated_at timestamptz
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
  v_batch_id uuid;
  v_status text;
  v_updated_at timestamptz;
  v_result jsonb;
  v_transition jsonb;
  v_reason_code text;
BEGIN
  IF p_public_id IS NULL THEN RAISE EXCEPTION 'BULK_REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'BULK_REVIEW_PUBLIC_ID_INVALID';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('submit_for_review', 'approve', 'request_changes') THEN
    RAISE EXCEPTION 'BULK_REVIEW_ACTION_INVALID';
  END IF;
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'BULK_REVIEW_ADMIN_ID_REQUIRED'; END IF;
  v_comments := NULLIF(pg_catalog.btrim(COALESCE(p_comments, '')), '');
  IF v_comments IS NOT NULL AND pg_catalog.length(v_comments) > 4000 THEN
    RAISE EXCEPTION 'BULK_REVIEW_COMMENTS_TOO_LONG';
  END IF;
  IF p_action = 'request_changes' AND v_comments IS NULL THEN
    RAISE EXCEPTION 'BULK_REVIEW_COMMENTS_REQUIRED';
  END IF;
  IF p_action <> 'request_changes' AND v_comments IS NOT NULL THEN
    RAISE EXCEPTION 'BULK_REVIEW_COMMENTS_NOT_ALLOWED';
  END IF;

  -- The wrapper checks authorization before exposing target-state convergence.
  SELECT pg_catalog.array_agg(r.role) INTO v_roles
    FROM public.user_roles r WHERE r.user_id = p_admin_id;
  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN
    RAISE EXCEPTION 'BULK_REVIEW_PERMISSION_DENIED';
  END IF;
  IF p_action = 'submit_for_review'
     AND NOT ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles)) THEN
    RAISE EXCEPTION 'BULK_REVIEW_PERMISSION_DENIED';
  END IF;
  IF p_action IN ('approve', 'request_changes')
     AND NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)) THEN
    RAISE EXCEPTION 'BULK_REVIEW_PERMISSION_DENIED';
  END IF;

  -- Submission follows the existing batch -> project lock order. The first lookup only obtains
  -- the lock namespace; the authoritative row is read again under the project lock below.
  IF p_action = 'submit_for_review' THEN
    SELECT p.import_batch_id INTO v_batch_id
      FROM public.projects p
     WHERE p.public_id = v_public_id AND p.deleted_at IS NULL;
    IF v_batch_id IS NULL THEN RAISE EXCEPTION 'BULK_REVIEW_PROJECT_NOT_FOUND'; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_batch_id::text));
  ELSIF p_action = 'request_changes' THEN
    -- Matches perform_project_review_action's participant-preview -> project order.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));
  END IF;

  SELECT p.id, p.import_batch_id, p.status, p.updated_at
    INTO v_project_id, v_batch_id, v_status, v_updated_at
    FROM public.projects p
   WHERE p.public_id = v_public_id AND p.deleted_at IS NULL
   FOR UPDATE;
  IF v_project_id IS NULL THEN RAISE EXCEPTION 'BULK_REVIEW_PROJECT_NOT_FOUND'; END IF;

  IF (p_action = 'submit_for_review' AND v_status = 'submitted')
     OR (p_action = 'approve' AND v_status = 'approved')
     OR (p_action = 'request_changes' AND v_status = 'changes_requested') THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_COMPLETE', 'publicId', v_public_id, 'status', v_status
    );
  END IF;

  IF p_expected_updated_at IS NULL OR v_updated_at IS NULL OR v_updated_at <> p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'STALE_VERSION', 'publicId', v_public_id, 'status', v_status
    );
  END IF;

  IF p_action = 'submit_for_review' THEN
    IF v_batch_id IS NULL THEN RAISE EXCEPTION 'BULK_REVIEW_PROJECT_NOT_FOUND'; END IF;
    BEGIN
      v_result := public.submit_import_projects_for_review(
        v_batch_id, ARRAY[v_public_id]::text[], p_admin_id, NULL
      );
    EXCEPTION WHEN OTHERS THEN
      -- Only an explicit workflow rule violation (RAISE EXCEPTION, SQLSTATE P0001) is a bounded
      -- per-project block. Deadlocks, serialization failures, constraint violations, and every
      -- other condition are re-raised so this project is reported as FAILED instead of being
      -- mislabelled as a workflow decision. The subtransaction rollback keeps the project
      -- unmutated either way.
      IF SQLSTATE <> 'P0001' THEN RAISE; END IF;
      v_reason_code := COALESCE(NULLIF(pg_catalog.left(pg_catalog.regexp_replace(
        pg_catalog.upper(pg_catalog.split_part(SQLERRM, ' ', 1)), '[^A-Z0-9_]', '', 'g'
      ), 80), ''), 'WORKFLOW_BLOCKED');
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'BLOCKED', 'publicId', v_public_id, 'status', v_status,
        'reasonCode', v_reason_code
      );
    END;
    IF v_result->>'resultCode' = 'SUCCESS'
       AND v_result->'results'->0->>'auditRecordId' IS NOT NULL THEN
      v_transition := v_result->'results'->0;
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'SUCCESS',
        'publicId', v_public_id,
        'status', v_transition->>'toStatus',
        'auditRecordId', v_transition->>'auditRecordId'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'BLOCKED', 'publicId', v_public_id, 'status', v_status,
      'reasonCode', COALESCE(v_result->>'resultCode', 'WORKFLOW_BLOCKED')
    );
  END IF;

  BEGIN
    v_result := public.perform_project_review_action(
      v_public_id, p_action, v_comments, p_admin_id
    );
  EXCEPTION WHEN OTHERS THEN
    -- Same boundary as the submission branch: preserve the review authority's own rule code and
    -- re-raise anything that is not an explicit workflow rule violation.
    IF SQLSTATE <> 'P0001' THEN RAISE; END IF;
    v_reason_code := COALESCE(NULLIF(pg_catalog.left(pg_catalog.regexp_replace(
      pg_catalog.upper(pg_catalog.split_part(SQLERRM, ' ', 1)), '[^A-Z0-9_]', '', 'g'
    ), 80), ''), 'WORKFLOW_BLOCKED');
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'BLOCKED', 'publicId', v_public_id, 'status', v_status,
      'reasonCode', v_reason_code
    );
  END;

  -- The historical review RPC returns {publicId,status,auditRecordId} on success, without
  -- resultCode. Normalize that existing shape here so the new gateway has one explicit contract.
  IF v_result->>'auditRecordId' IS NOT NULL AND v_result->>'status' IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'SUCCESS',
      'publicId', COALESCE(v_result->>'publicId', v_public_id),
      'status', v_result->>'status',
      'auditRecordId', v_result->>'auditRecordId'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'BLOCKED', 'publicId', v_public_id, 'status', v_status,
    'reasonCode', COALESCE(v_result->>'resultCode', 'WORKFLOW_BLOCKED')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.perform_project_workflow_action_if_current(text, text, text, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_project_workflow_action_if_current(text, text, text, uuid, timestamptz)
  TO service_role;

-- Bounded, one-row-per-project evidence for bulk preflight. The gateway needs existence counts,
-- not unbounded child histories; the existing workflow RPCs remain the mutation authorities.
CREATE OR REPLACE FUNCTION public.get_bulk_project_review_evidence(p_project_ids uuid[])
RETURNS TABLE(
  project_id uuid,
  unresolved_error_count bigint,
  active_preview_count bigint,
  unresolved_correction_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.id,
    (
      SELECT count(*)
        FROM public.validation_flags vf
       WHERE vf.project_id = p.id
         AND vf.severity = 'error'
         AND vf.resolved = false
    ),
    (
      SELECT count(*)
        FROM public.participant_previews pp
       WHERE pp.project_id = p.id
         AND pp.status = 'active'
    ),
    (
      SELECT count(*)
        FROM public.participant_preview_correction_requests cr
        JOIN public.participant_previews pp ON pp.id = cr.participant_preview_id
       WHERE pp.project_id = p.id
         AND cr.status IN ('open', 'in_progress')
    )
  FROM public.projects p
  WHERE p.id = ANY(COALESCE(p_project_ids, ARRAY[]::uuid[]));
$$;

REVOKE ALL ON FUNCTION public.get_bulk_project_review_evidence(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bulk_project_review_evidence(uuid[])
  TO service_role;

COMMIT;
