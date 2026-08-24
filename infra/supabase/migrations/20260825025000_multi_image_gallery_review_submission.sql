-- Forward migration: multi-image gallery review-submission gate.
--
-- Preserves the existing submit_import_projects_for_review contract and
-- transaction/RBAC behavior while replacing the legacy single-snapshot
-- accessibility check with an all-snapshot gallery check.
--
-- Historical migrations are intentionally left untouched.

CREATE OR REPLACE FUNCTION public.submit_import_projects_for_review(
  p_batch_id uuid,
  p_project_public_ids text[],
  p_admin_id uuid,
  p_comments text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comments text;
  v_roles text[];
  v_batch RECORD;
  v_canonical_ids text[];
  v_id_count integer;
  v_matched_count integer;
  v_project RECORD;
  v_discipline_count integer;
  v_industry_count integer;
  v_poster_ok boolean;
  v_poster_pdf_ok boolean;
  v_unresolved_error_flag_count integer;
  v_blocking_reasons text[];
  v_to_submit uuid[] := ARRAY[]::uuid[];
  v_to_submit_from_status jsonb := '{}'::jsonb;
  v_already_submitted text[] := ARRAY[]::text[];
  v_results jsonb := '[]'::jsonb;
  v_pid uuid;
  v_from_status text;
  v_public_id text;
  v_audit_id uuid;
  v_submitted_count integer := 0;
  v_locked_count integer := 0;
BEGIN
  -- 1. Top-level parameter validation
  IF p_batch_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'BATCH_NOT_FOUND');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SUBMIT_PERMISSION_DENIED');
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
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  -- 2. Transaction lock keyed on batch id (shared namespace with the media-stage finalize RPC
  --    is intentional defense-in-depth: the two operations can never legitimately overlap on
  --    the same batch, since one only runs pre-completion and the other only post-completion).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_batch_id::text));

  -- 3. Authorization defense-in-depth: submission is a preparation/editing action (projects.edit),
  --    never an approval action. A reviewer-only identity must not be able to submit.
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0
     OR NOT ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SUBMIT_PERMISSION_DENIED');
  END IF;

  -- 4. Fetch and lock the batch row; require it to be completed.
  SELECT b.id, b.status INTO v_batch
    FROM public.import_batches AS b
   WHERE b.id = p_batch_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'BATCH_NOT_FOUND');
  END IF;

  IF v_batch.status <> 'completed' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_BATCH_STATE');
  END IF;

  -- 5. Canonicalize / deduplicate selected project identifiers (order-independent, distinct).
  IF p_project_public_ids IS NULL
     OR pg_catalog.array_position(p_project_public_ids, NULL) IS NOT NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT ids.id ORDER BY ids.id)
    INTO v_canonical_ids
    FROM pg_catalog.unnest(p_project_public_ids) AS ids(id);

  v_id_count := COALESCE(pg_catalog.cardinality(v_canonical_ids), 0);
  IF v_id_count = 0 OR v_id_count > 25 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  -- 6. Lock every matching project row in deterministic (id) order — avoids deadlocks against
  --    concurrent overlapping selections and is the sole idempotency/convergence mechanism.
  SELECT pg_catalog.count(*) INTO v_matched_count
    FROM public.projects AS p
   WHERE p.public_id = ANY(v_canonical_ids)
     AND p.import_batch_id = p_batch_id
     AND p.deleted_at IS NULL;

  IF v_matched_count <> v_id_count THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_IN_BATCH');
  END IF;

  --------------------------------------------------------------------------------
  -- 7. Pre-mutation validation pass: derive eligibility + readiness for every selected
  --    project BEFORE any mutation. Any ineligible or unready project aborts the whole
  --    call with zero mutations (selection is all-or-nothing).
  --------------------------------------------------------------------------------
  FOR v_project IN
    SELECT p.id, p.public_id, p.status, p.title, p.summary, p.program_id,
           p.program_name, p.study_program, p.discipline, p.group_name, p.team_members,
           p.validation_errors, p.poster_text_public, p.accessibility_text_public
      FROM public.projects AS p
     WHERE p.public_id = ANY(v_canonical_ids)
       AND p.import_batch_id = p_batch_id
       AND p.deleted_at IS NULL
     ORDER BY p.id
       FOR UPDATE
  LOOP
    v_locked_count := v_locked_count + 1;

    IF v_project.status = 'submitted' THEN
      v_already_submitted := pg_catalog.array_append(v_already_submitted, v_project.public_id);
      CONTINUE;
    END IF;

    IF v_project.status NOT IN ('draft', 'changes_requested') THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'INVALID_PROJECT_STATE',
        'publicId', v_project.public_id,
        'status', v_project.status
      );
    END IF;

    -- Readiness re-derivation (server-authoritative; mirrors the application-side
    -- computeProjectReviewReadiness rules).
    v_blocking_reasons := ARRAY[]::text[];

    IF pg_catalog.btrim(COALESCE(v_project.title, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_TITLE');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.summary, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_SUMMARY');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.program_name, '')) = '' OR v_project.program_id IS NULL THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_PROGRAM');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.study_program, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_STUDY_PROGRAM');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.discipline, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_DISCIPLINE');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.group_name, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_GROUP_NAME');
    END IF;
    IF v_project.team_members IS NULL OR pg_catalog.cardinality(v_project.team_members) = 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_TEAM_MEMBERS');
    END IF;

    -- Accessible poster content. A legacy project.json package can reach the CMS without either
    -- value; it may be staged, but it may never enter review until staff supply both through the
    -- project metadata editor. The bound is re-derived from the persisted row rather than trusted
    -- from whatever wrote it, so a row that reached the table by any path is still checked here.
    IF pg_catalog.btrim(COALESCE(v_project.poster_text_public, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_POSTER_TEXT');
    ELSIF pg_catalog.length(pg_catalog.btrim(v_project.poster_text_public)) > 20000 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'POSTER_TEXT_TOO_LONG');
    END IF;
    IF pg_catalog.btrim(COALESCE(v_project.accessibility_text_public, '')) = '' THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_ACCESSIBILITY_TEXT');
    ELSIF pg_catalog.length(pg_catalog.btrim(v_project.accessibility_text_public)) > 2000 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'ACCESSIBILITY_TEXT_TOO_LONG');
    END IF;

    IF v_project.validation_errors IS NOT NULL AND pg_catalog.cardinality(v_project.validation_errors) > 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'BLOCKING_VALIDATION_ERRORS');
    END IF;

    -- Authoritative validation_flags: an unresolved error-severity flag blocks submission.
    -- Resolved flags, and warning/info severities regardless of resolution, are never blocking.
    SELECT pg_catalog.count(*) INTO v_unresolved_error_flag_count
      FROM public.validation_flags AS vf
     WHERE vf.project_id = v_project.id
       AND vf.severity = 'error'
       AND vf.resolved = false;
    IF v_unresolved_error_flag_count > 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'BLOCKING_VALIDATION_FLAGS');
    END IF;

    SELECT pg_catalog.count(*) INTO v_discipline_count
      FROM public.project_disciplines AS pd
     WHERE pd.project_id = v_project.id;
    IF v_discipline_count = 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_DISCIPLINE_MAPPING');
    END IF;

    SELECT pg_catalog.count(*) INTO v_industry_count
      FROM public.project_industry_categories AS pic
     WHERE pic.project_id = v_project.id;
    IF v_industry_count = 0 THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_INDUSTRY_MAPPING');
    END IF;

    -- Staged media consistency: required private assets must be registered and must remain
    -- private (never public_url, never is_public_approved). Fail closed on inconsistency.
    SELECT pg_catalog.bool_or(ma.public_url IS NULL AND ma.is_public_approved = false)
      INTO v_poster_ok
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id AND ma.asset_type = 'poster_image';
    IF NOT COALESCE(v_poster_ok, false) THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_OR_INCONSISTENT_POSTER_MEDIA');
    END IF;

    SELECT pg_catalog.bool_or(ma.public_url IS NULL AND ma.is_public_approved = false)
      INTO v_poster_pdf_ok
      FROM public.media_assets AS ma
     WHERE ma.project_id = v_project.id AND ma.asset_type = 'poster_pdf';
    IF NOT COALESCE(v_poster_pdf_ok, false) THEN
      v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_OR_INCONSISTENT_POSTER_PDF_MEDIA');
    END IF;

    -- Snapshot gallery accessibility is conditional by design.
    -- Zero snapshots remains valid. When snapshots exist, every snapshot row is
    -- checked server-side; no single-row selection may hide an invalid gallery item.
    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'MISSING_SNAPSHOT_ALT_TEXT'
      );
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.media_assets AS ma
       WHERE ma.project_id = v_project.id
         AND ma.asset_type = 'snapshot_image'
         AND pg_catalog.length(
               pg_catalog.btrim(COALESCE(ma.alt_text_public, ''))
             ) > 2000
    ) THEN
      v_blocking_reasons := pg_catalog.array_append(
        v_blocking_reasons,
        'SNAPSHOT_ALT_TEXT_TOO_LONG'
      );
    END IF;

    IF pg_catalog.cardinality(v_blocking_reasons) > 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'READINESS_BLOCKED',
        'publicId', v_project.public_id,
        'blockingReasons', pg_catalog.to_jsonb(v_blocking_reasons)
      );
    END IF;

    v_to_submit := pg_catalog.array_append(v_to_submit, v_project.id);
    v_to_submit_from_status := pg_catalog.jsonb_set(
      v_to_submit_from_status, ARRAY[v_project.id::text], pg_catalog.to_jsonb(v_project.status)
    );
  END LOOP;

  -- Defense against a project being concurrently soft-deleted (or moved out of this batch)
  -- between the pre-lock existence count (step 6) and this locking loop: the loop must have
  -- actually locked exactly the canonical selection, or the all-or-nothing guarantee is violated.
  IF v_locked_count <> v_id_count THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_IN_BATCH');
  END IF;

  --------------------------------------------------------------------------------
  -- ALL VALIDATION PASSED BEFORE MUTATIONS BEGIN.
  -- AFTER THIS POINT, ANY UNEXPECTED FAILURE MUST RAISE AN EXCEPTION TO ROLL BACK.
  --------------------------------------------------------------------------------

  FOREACH v_pid IN ARRAY v_to_submit LOOP
    v_from_status := v_to_submit_from_status->>(v_pid::text);

    UPDATE public.projects
       SET status = 'submitted'
     WHERE id = v_pid
       AND status = v_from_status
     RETURNING public_id INTO v_public_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROJECT_STATE_CHANGED_CONCURRENTLY';
    END IF;

    INSERT INTO public.approval_records (
      project_id, admin_id, action_taken, from_status, to_status, comments
    ) VALUES (
      v_pid, p_admin_id, 'submit_for_review', v_from_status, 'submitted', v_comments
    ) RETURNING id INTO v_audit_id;

    v_submitted_count := v_submitted_count + 1;
    v_results := v_results || pg_catalog.jsonb_build_object(
      'publicId', v_public_id,
      'fromStatus', v_from_status,
      'toStatus', 'submitted',
      'auditRecordId', v_audit_id::text
    );
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'batchId', p_batch_id,
    'submittedCount', v_submitted_count,
    'alreadySubmittedPublicIds', pg_catalog.to_jsonb(v_already_submitted),
    'results', v_results
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_import_projects_for_review(uuid, text[], uuid, text) TO service_role;
