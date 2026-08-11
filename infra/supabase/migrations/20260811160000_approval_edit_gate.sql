-- Migration 0018: protect approved and published records from direct metadata edits.
BEGIN;

CREATE OR REPLACE FUNCTION public.update_project_metadata(
  p_public_id text, p_title text, p_summary text, p_background text, p_solution text,
  p_year integer, p_program_id uuid, p_discipline_ids uuid[], p_industry_category_ids uuid[],
  p_expected_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_title text := pg_catalog.btrim(COALESCE(p_title, ''));
  v_summary text := pg_catalog.btrim(COALESCE(p_summary, ''));
  v_background text := pg_catalog.btrim(COALESCE(p_background, ''));
  v_solution text := pg_catalog.btrim(COALESCE(p_solution, ''));
  v_project_id uuid; v_current_updated_at timestamptz; v_status text; v_updated_at timestamptz;
  v_program_name text; v_discipline_name text; v_industry_name text;
BEGIN
  IF v_public_id = '' OR v_title = '' OR v_summary = '' OR pg_catalog.length(v_title) > 200
    OR pg_catalog.length(v_summary) > 1000 OR pg_catalog.length(v_background) > 10000
    OR pg_catalog.length(v_solution) > 10000 OR p_year IS NULL OR p_year < 2000 OR p_year > 2100
    OR p_program_id IS NULL OR p_expected_updated_at IS NULL OR p_discipline_ids IS NULL
    OR pg_catalog.cardinality(p_discipline_ids) = 0 OR pg_catalog.array_position(p_discipline_ids, NULL) IS NOT NULL
    OR p_industry_category_ids IS NULL OR pg_catalog.cardinality(p_industry_category_ids) = 0
    OR pg_catalog.array_position(p_industry_category_ids, NULL) IS NOT NULL
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_discipline_ids) x) <> pg_catalog.cardinality(p_discipline_ids)
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_industry_category_ids) x) <> pg_catalog.cardinality(p_industry_category_ids)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED'); END IF;

  SELECT id, updated_at, status INTO v_project_id, v_current_updated_at, v_status
  FROM public.projects WHERE public_id = v_public_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND'); END IF;
  IF v_status = 'approved' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'APPROVAL_REOPEN_REQUIRED'); END IF;
  IF v_status = 'published' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLISHED_PROJECT_LOCKED'); END IF;
  IF v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION'); END IF;

  SELECT name INTO v_program_name FROM public.programs WHERE id = p_program_id;
  SELECT name INTO v_discipline_name FROM public.disciplines WHERE id = p_discipline_ids[1];
  SELECT name INTO v_industry_name FROM public.industry_categories WHERE id = p_industry_category_ids[1];
  IF v_program_name IS NULL OR v_discipline_name IS NULL OR v_industry_name IS NULL
    OR (SELECT count(*) FROM public.disciplines WHERE id = ANY(p_discipline_ids)) <> pg_catalog.cardinality(p_discipline_ids)
    OR (SELECT count(*) FROM public.industry_categories WHERE id = ANY(p_industry_category_ids)) <> pg_catalog.cardinality(p_industry_category_ids)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED'); END IF;

  UPDATE public.projects SET title = v_title, summary = v_summary, background = v_background, solution = v_solution,
    year = p_year, program_id = p_program_id, program_name = v_program_name, discipline = v_discipline_name, industry = v_industry_name
  WHERE id = v_project_id RETURNING updated_at INTO v_updated_at;
  DELETE FROM public.project_disciplines WHERE project_id = v_project_id;
  INSERT INTO public.project_disciplines(project_id, discipline_id) SELECT v_project_id, x FROM pg_catalog.unnest(p_discipline_ids) x;
  DELETE FROM public.project_industry_categories WHERE project_id = v_project_id;
  INSERT INTO public.project_industry_categories(project_id, industry_category_id) SELECT v_project_id, x FROM pg_catalog.unnest(p_industry_category_ids) x;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'SUCCESS', 'metadata', pg_catalog.jsonb_build_object(
    'publicId', v_public_id, 'title', v_title, 'summary', v_summary, 'background', v_background, 'solution', v_solution,
    'year', p_year::text, 'programId', p_program_id::text,
    'disciplineIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_discipline_ids) x),
    'industryCategoryIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_industry_category_ids) x),
    'expectedUpdatedAt', v_updated_at));
END; $$;

CREATE OR REPLACE FUNCTION public.perform_project_review_action(
  p_public_id text, p_action text, p_comments text, p_admin_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text; v_comments text; v_roles text[]; v_project_id uuid; v_from_status text;
  v_to_status text; v_archive_reason text; v_now timestamptz; v_audit_record_id uuid;
  v_unresolved integer; v_active integer;
BEGIN
  IF p_public_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  IF pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_INVALID'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('request_changes', 'approve', 'archive') THEN RAISE EXCEPTION 'REVIEW_ACTION_INVALID'; END IF;
  v_comments := NULLIF(pg_catalog.btrim(COALESCE(p_comments, '')), '');
  IF v_comments IS NOT NULL AND pg_catalog.length(v_comments) > 4000 THEN RAISE EXCEPTION 'REVIEW_COMMENTS_TOO_LONG'; END IF;
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'REVIEW_ADMIN_ID_REQUIRED'; END IF;

  SELECT pg_catalog.array_agg(r.role) INTO v_roles FROM public.user_roles r WHERE r.user_id = p_admin_id;
  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED'; END IF;
  IF p_action IN ('request_changes', 'approve') AND NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)) THEN RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED'; END IF;
  IF p_action = 'archive' AND NOT ('admin' = ANY(v_roles)) THEN RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED'; END IF;

  -- This is the existing participant-preview namespace. It serializes reopen against participant responses.
  IF p_action = 'request_changes' THEN PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id)); END IF;
  SELECT p.id, p.status INTO v_project_id, v_from_status FROM public.projects p
  WHERE p.public_id = v_public_id AND p.deleted_at IS NULL FOR UPDATE;
  IF v_project_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PROJECT_NOT_FOUND'; END IF;

  IF v_from_status = 'approved' AND p_action = 'request_changes' THEN
    SELECT count(*) INTO v_unresolved FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
    WHERE pp.project_id = v_project_id AND r.status IN ('open', 'in_progress');
    IF v_unresolved > 0 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'CORRECTION_RESOLUTION_REQUIRED'); END IF;
    SELECT count(*) INTO v_active FROM public.participant_previews WHERE project_id = v_project_id AND status = 'active';
    IF v_active > 1 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'AMBIGUOUS_ACTIVE_PREVIEW'); END IF;
    IF v_active = 1 THEN
      UPDATE public.participant_previews SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = p_admin_id
      WHERE project_id = v_project_id AND status = 'active';
    END IF;
    v_to_status := 'changes_requested';
  ELSE
    CASE v_from_status
      WHEN 'submitted', 'in_review' THEN
        CASE p_action WHEN 'request_changes' THEN v_to_status := 'changes_requested'; WHEN 'approve' THEN v_to_status := 'approved'; WHEN 'archive' THEN v_to_status := 'archived'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END CASE;
      WHEN 'changes_requested' THEN IF p_action = 'approve' THEN v_to_status := 'approved'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;
      WHEN 'approved' THEN IF p_action = 'archive' THEN v_to_status := 'archived'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;
      WHEN 'published' THEN IF p_action = 'archive' THEN v_to_status := 'archived'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;
      ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
    END CASE;
  END IF;

  v_now := pg_catalog.now();
  IF p_action = 'archive' THEN
    v_archive_reason := pg_catalog.coalesce(v_comments, 'Archived under standard review workflow');
    UPDATE public.projects SET status = v_to_status, archived_at = v_now, archived_from_status = v_from_status,
      archive_reason = v_archive_reason, pending_removal_from_public = true WHERE id = v_project_id;
  ELSIF p_action = 'approve' THEN
    UPDATE public.projects SET status = v_to_status, archived_at = NULL, archived_from_status = NULL, archive_reason = NULL WHERE id = v_project_id;
  ELSE UPDATE public.projects SET status = v_to_status WHERE id = v_project_id;
  END IF;
  INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments)
  VALUES (v_project_id, p_admin_id, p_action, v_from_status, v_to_status, v_comments) RETURNING id INTO v_audit_record_id;
  RETURN pg_catalog.jsonb_build_object('publicId', v_public_id, 'status', v_to_status, 'auditRecordId', v_audit_record_id::text);
END; $$;

REVOKE ALL ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.perform_project_review_action(text,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text,text,text,uuid) TO service_role;
COMMIT;
