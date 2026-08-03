-- Transactional review action RPC for atomic project status updates and approval audit tracking
-- 0008_transactional_review_actions.sql (Idempotent)

BEGIN;

CREATE OR REPLACE FUNCTION public.perform_project_review_action(
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
  v_to_status text;
  v_archive_reason text;
  v_now timestamptz;
  v_audit_record_id uuid;
BEGIN
  -- 1. Input Sanitization & Defensive Validation
  IF p_public_id IS NULL THEN
    RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED';
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' THEN
    RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED';
  END IF;

  IF pg_catalog.length(v_public_id) > 100 THEN
    RAISE EXCEPTION 'REVIEW_PUBLIC_ID_INVALID';
  END IF;

  IF v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'REVIEW_PUBLIC_ID_INVALID';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('request_changes', 'approve', 'archive') THEN
    RAISE EXCEPTION 'REVIEW_ACTION_INVALID';
  END IF;

  IF p_comments IS NOT NULL THEN
    v_comments := pg_catalog.btrim(p_comments);
    IF v_comments = '' THEN
      v_comments := NULL;
    END IF;
  ELSE
    v_comments := NULL;
  END IF;

  IF v_comments IS NOT NULL AND pg_catalog.length(v_comments) > 4000 THEN
    RAISE EXCEPTION 'REVIEW_COMMENTS_TOO_LONG';
  END IF;

  IF p_admin_id IS NULL THEN
    RAISE EXCEPTION 'REVIEW_ADMIN_ID_REQUIRED';
  END IF;

  -- 2. Authorization Defense in Depth (Check user roles in user_roles table)
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN
    RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED';
  END IF;

  IF p_action IN ('request_changes', 'approve') THEN
    IF NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)) THEN
      RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED';
    END IF;
  ELSIF p_action = 'archive' THEN
    IF NOT ('admin' = ANY(v_roles)) THEN
      RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED';
    END IF;
  ELSE
    RAISE EXCEPTION 'REVIEW_ACTION_INVALID';
  END IF;

  -- 3. Row Locking & Project Existence Check
  SELECT p.id, p.status
    INTO v_project_id, v_from_status
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'REVIEW_PROJECT_NOT_FOUND';
  END IF;

  -- 4. Workflow Transition Rules
  CASE v_from_status
    WHEN 'submitted', 'in_review' THEN
      CASE p_action
        WHEN 'request_changes' THEN v_to_status := 'changes_requested';
        WHEN 'approve' THEN v_to_status := 'approved';
        WHEN 'archive' THEN v_to_status := 'archived';
        ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
      END CASE;
    WHEN 'changes_requested' THEN
      CASE p_action
        WHEN 'approve' THEN v_to_status := 'approved';
        ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
      END CASE;
    WHEN 'approved' THEN
      CASE p_action
        WHEN 'request_changes' THEN v_to_status := 'changes_requested';
        WHEN 'archive' THEN v_to_status := 'archived';
        ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
      END CASE;
    WHEN 'published' THEN
      CASE p_action
        WHEN 'archive' THEN v_to_status := 'archived';
        ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
      END CASE;
    ELSE
      RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
  END CASE;

  -- 5. Status-Specific Side Effects Update
  v_now := pg_catalog.now();

  IF p_action = 'archive' THEN
    v_archive_reason := pg_catalog.coalesce(v_comments, 'Archived under standard review workflow');
    UPDATE public.projects
       SET status = v_to_status,
           archived_at = v_now,
           archived_from_status = v_from_status,
           archive_reason = v_archive_reason,
           pending_removal_from_public = true
     WHERE id = v_project_id;
  ELSIF p_action = 'approve' THEN
    UPDATE public.projects
       SET status = v_to_status,
           archived_at = NULL,
           archived_from_status = NULL,
           archive_reason = NULL
     WHERE id = v_project_id;
  ELSIF p_action = 'request_changes' THEN
    UPDATE public.projects
       SET status = v_to_status
     WHERE id = v_project_id;
  END IF;

  -- 6. Insert Approval/Audit Record
  INSERT INTO public.approval_records (
    project_id,
    admin_id,
    action_taken,
    from_status,
    to_status,
    comments
  ) VALUES (
    v_project_id,
    p_admin_id,
    p_action,
    v_from_status,
    v_to_status,
    v_comments
  ) RETURNING id INTO v_audit_record_id;

  -- 7. Return Stable Result Object
  RETURN pg_catalog.jsonb_build_object(
    'publicId', v_public_id,
    'status', v_to_status,
    'auditRecordId', v_audit_record_id::text
  );
END;
$$;

-- 8. Execution Privilege ACLs (Least Privilege: service_role execution only)
REVOKE EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) TO service_role;

COMMIT;
