-- Migration 0025: accessible poster full-text workflow gate.
--
-- Every public project page must carry a full text version of its image content plus a text
-- alternative for the poster image. Both values already exist as columns
-- (projects.poster_text_public, projects.accessibility_text_public) and already flow into the
-- participant-preview snapshot and the compiled public feed — but no workflow boundary required
-- them. This migration makes them authoritative at the three boundaries that matter:
--
--   * submit_import_projects_for_review  -- cannot enter review while either is blank
--   * perform_project_review_action      -- cannot approve while either is blank
--   * get_project_publication_readiness  -- cannot become publication-ready while either is blank
--
-- and extends update_project_metadata so staff have an explicit, audited correction path for a
-- project that reached the CMS without them (notably a legacy project.json package).
--
-- No column is added, renamed, or backfilled. The existing columns are reused as-is.
--
-- The authoritative rule is presence after trim plus a bounded technical ceiling. Nothing here
-- judges whether the text is complete, accurate, or well written — no heuristics, no word counts,
-- no comparison against other fields, and no OCR or AI of any kind. Both values are staff-authored
-- or imported from the project workbook.
--
-- Bounds (transport/storage safety ceilings, NOT content-quality rules) mirror
-- apps/admin-cms/src/domain/accessibleContent.ts: poster text 20000, accessibility text 2000.

BEGIN;

--------------------------------------------------------------------------------
-- 1. update_project_metadata
--    Forward-redefined from 20260813002154_project_metadata_audit_history.sql (the current
--    authoritative definition, which introduced the actor snapshots and event_details audit).
--    Gains p_poster_text / p_accessibility_text; every inherited behaviour is preserved --
--    Admin/Editor authorization, service-role-only execution, fixed search_path, row lock,
--    stale-version check, approved reopen gate, published lock, lookup validation, relationship
--    replacement, NO_CHANGES, the exact audit event structure, and rollback semantics.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_project_metadata(
  p_public_id text,
  p_title text,
  p_summary text,
  p_background text,
  p_solution text,
  p_year integer,
  p_program_id uuid,
  p_discipline_ids uuid[],
  p_industry_category_ids uuid[],
  p_expected_updated_at timestamptz,
  p_admin_id uuid,
  p_poster_text text,
  p_accessibility_text text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_title text := pg_catalog.btrim(COALESCE(p_title, ''));
  v_summary text := pg_catalog.btrim(COALESCE(p_summary, ''));
  v_background text := pg_catalog.btrim(COALESCE(p_background, ''));
  v_solution text := pg_catalog.btrim(COALESCE(p_solution, ''));
  v_poster_text text := pg_catalog.btrim(COALESCE(p_poster_text, ''));
  v_accessibility_text text := pg_catalog.btrim(COALESCE(p_accessibility_text, ''));
  v_project_id uuid;
  v_current_updated_at timestamptz;
  v_status text;
  v_updated_at timestamptz;
  v_program_name text;
  v_discipline_name text;
  v_industry_name text;
  v_old_title text;
  v_old_summary text;
  v_old_background text;
  v_old_solution text;
  v_old_poster_text text;
  v_old_accessibility_text text;
  v_old_year integer;
  v_old_program_id uuid;
  v_old_program_name text;
  v_old_discipline_name text;
  v_old_industry_name text;
  v_audit_record_id uuid;
  v_actor_full_name text;
  v_actor_email text;
  v_changed_fields text[] := ARRAY[]::text[];
  v_before_state jsonb := '{}'::jsonb;
  v_after_state jsonb := '{}'::jsonb;
  v_event_details jsonb;
  v_old_disciplines jsonb;
  v_new_disciplines jsonb;
  v_old_industries jsonb;
  v_new_industries jsonb;
BEGIN
  SELECT full_name, email INTO v_actor_full_name, v_actor_email
  FROM public.admin_users WHERE id = p_admin_id;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_admin_id AND role IN ('admin', 'editor')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- Accessible poster content is required and bounded, exactly like title/summary. A blank value
  -- can never be written back, so the correction path always moves a project toward compliance.
  IF v_public_id = '' OR v_title = '' OR v_summary = '' OR pg_catalog.length(v_title) > 200
    OR pg_catalog.length(v_summary) > 1000 OR pg_catalog.length(v_background) > 10000
    OR pg_catalog.length(v_solution) > 10000
    OR v_poster_text = '' OR pg_catalog.length(v_poster_text) > 20000
    OR v_accessibility_text = '' OR pg_catalog.length(v_accessibility_text) > 2000
    OR p_year IS NULL OR p_year < 2000 OR p_year > 2100
    OR p_program_id IS NULL OR p_expected_updated_at IS NULL OR p_discipline_ids IS NULL
    OR pg_catalog.cardinality(p_discipline_ids) = 0 OR pg_catalog.array_position(p_discipline_ids, NULL) IS NOT NULL
    OR p_industry_category_ids IS NULL OR pg_catalog.cardinality(p_industry_category_ids) = 0
    OR pg_catalog.array_position(p_industry_category_ids, NULL) IS NOT NULL
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_discipline_ids) x) <> pg_catalog.cardinality(p_discipline_ids)
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_industry_category_ids) x) <> pg_catalog.cardinality(p_industry_category_ids)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED'); END IF;

  SELECT id, updated_at, status, title, summary, background, solution, year, program_id, program_name, discipline, industry,
         poster_text_public, accessibility_text_public
  INTO v_project_id, v_current_updated_at, v_status, v_old_title, v_old_summary, v_old_background, v_old_solution, v_old_year, v_old_program_id, v_old_program_name, v_old_discipline_name, v_old_industry_name,
       v_old_poster_text, v_old_accessibility_text
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

  IF v_old_title IS DISTINCT FROM v_title THEN
    v_changed_fields := array_append(v_changed_fields, 'title');
    v_before_state := jsonb_set(v_before_state, '{title}', to_jsonb(v_old_title));
    v_after_state := jsonb_set(v_after_state, '{title}', to_jsonb(v_title));
  END IF;
  IF v_old_summary IS DISTINCT FROM v_summary THEN
    v_changed_fields := array_append(v_changed_fields, 'summary');
    v_before_state := jsonb_set(v_before_state, '{summary}', to_jsonb(v_old_summary));
    v_after_state := jsonb_set(v_after_state, '{summary}', to_jsonb(v_summary));
  END IF;
  IF coalesce(v_old_background, '') IS DISTINCT FROM v_background THEN
    v_changed_fields := array_append(v_changed_fields, 'background');
    v_before_state := jsonb_set(v_before_state, '{background}', to_jsonb(coalesce(v_old_background, '')));
    v_after_state := jsonb_set(v_after_state, '{background}', to_jsonb(v_background));
  END IF;
  IF coalesce(v_old_solution, '') IS DISTINCT FROM v_solution THEN
    v_changed_fields := array_append(v_changed_fields, 'solution');
    v_before_state := jsonb_set(v_before_state, '{solution}', to_jsonb(coalesce(v_old_solution, '')));
    v_after_state := jsonb_set(v_after_state, '{solution}', to_jsonb(v_solution));
  END IF;
  -- A NULL column and an empty string are the same absence of accessible content, so an
  -- absent-to-absent save must never fabricate a changed field.
  IF coalesce(v_old_poster_text, '') IS DISTINCT FROM v_poster_text THEN
    v_changed_fields := array_append(v_changed_fields, 'posterText');
    v_before_state := jsonb_set(v_before_state, '{posterText}', to_jsonb(coalesce(v_old_poster_text, '')));
    v_after_state := jsonb_set(v_after_state, '{posterText}', to_jsonb(v_poster_text));
  END IF;
  IF coalesce(v_old_accessibility_text, '') IS DISTINCT FROM v_accessibility_text THEN
    v_changed_fields := array_append(v_changed_fields, 'accessibilityText');
    v_before_state := jsonb_set(v_before_state, '{accessibilityText}', to_jsonb(coalesce(v_old_accessibility_text, '')));
    v_after_state := jsonb_set(v_after_state, '{accessibilityText}', to_jsonb(v_accessibility_text));
  END IF;
  IF coalesce(v_old_year, 0) IS DISTINCT FROM p_year THEN
    v_changed_fields := array_append(v_changed_fields, 'year');
    v_before_state := jsonb_set(v_before_state, '{year}', to_jsonb(v_old_year));
    v_after_state := jsonb_set(v_after_state, '{year}', to_jsonb(p_year));
  END IF;
  IF coalesce(v_old_program_id, '00000000-0000-0000-0000-000000000000'::uuid) IS DISTINCT FROM p_program_id THEN
    v_changed_fields := array_append(v_changed_fields, 'program');
    v_before_state := jsonb_set(v_before_state, '{program}', jsonb_build_object('id', v_old_program_id, 'name', v_old_program_name));
    v_after_state := jsonb_set(v_after_state, '{program}', jsonb_build_object('id', p_program_id, 'name', v_program_name));
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) ORDER BY d.id), '[]'::jsonb) INTO v_old_disciplines
  FROM public.project_disciplines pd JOIN public.disciplines d ON pd.discipline_id = d.id WHERE pd.project_id = v_project_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) ORDER BY d.id), '[]'::jsonb) INTO v_new_disciplines
  FROM public.disciplines d WHERE d.id = ANY(p_discipline_ids);

  IF v_old_disciplines IS NOT DISTINCT FROM v_new_disciplines THEN
    v_discipline_name := v_old_discipline_name;
  ELSE
    v_changed_fields := array_append(v_changed_fields, 'disciplines');
    v_before_state := jsonb_set(v_before_state, '{disciplines}', v_old_disciplines);
    v_after_state := jsonb_set(v_after_state, '{disciplines}', v_new_disciplines);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ic.id, 'name', ic.name) ORDER BY ic.id), '[]'::jsonb) INTO v_old_industries
  FROM public.project_industry_categories pic JOIN public.industry_categories ic ON pic.industry_category_id = ic.id WHERE pic.project_id = v_project_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ic.id, 'name', ic.name) ORDER BY ic.id), '[]'::jsonb) INTO v_new_industries
  FROM public.industry_categories ic WHERE ic.id = ANY(p_industry_category_ids);

  IF v_old_industries IS NOT DISTINCT FROM v_new_industries THEN
    v_industry_name := v_old_industry_name;
  ELSE
    v_changed_fields := array_append(v_changed_fields, 'industryCategories');
    v_before_state := jsonb_set(v_before_state, '{industryCategories}', v_old_industries);
    v_after_state := jsonb_set(v_after_state, '{industryCategories}', v_new_industries);
  END IF;

  IF array_length(v_changed_fields, 1) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'NO_CHANGES',
      'metadata', pg_catalog.jsonb_build_object(
        'publicId', v_public_id, 'title', v_old_title, 'summary', v_old_summary,
        'background', coalesce(v_old_background, ''), 'solution', coalesce(v_old_solution, ''),
        'posterText', coalesce(v_old_poster_text, ''), 'accessibilityText', coalesce(v_old_accessibility_text, ''),
        'year', v_old_year::text, 'programId', v_old_program_id::text,
        'disciplineIds', (SELECT coalesce(pg_catalog.jsonb_agg(d->>'id'), '[]'::jsonb) FROM jsonb_array_elements(v_old_disciplines) d),
        'industryCategoryIds', (SELECT coalesce(pg_catalog.jsonb_agg(ic->>'id'), '[]'::jsonb) FROM jsonb_array_elements(v_old_industries) ic),
        'expectedUpdatedAt', v_current_updated_at
      )
    );
  END IF;

  UPDATE public.projects SET title = v_title, summary = v_summary, background = v_background, solution = v_solution,
    poster_text_public = v_poster_text, accessibility_text_public = v_accessibility_text,
    year = p_year, program_id = p_program_id, program_name = v_program_name, discipline = v_discipline_name, industry = v_industry_name
  WHERE id = v_project_id RETURNING updated_at INTO v_updated_at;

  DELETE FROM public.project_disciplines WHERE project_id = v_project_id;
  INSERT INTO public.project_disciplines(project_id, discipline_id) SELECT v_project_id, x FROM pg_catalog.unnest(p_discipline_ids) x;

  DELETE FROM public.project_industry_categories WHERE project_id = v_project_id;
  INSERT INTO public.project_industry_categories(project_id, industry_category_id) SELECT v_project_id, x FROM pg_catalog.unnest(p_industry_category_ids) x;

  v_event_details := jsonb_build_object(
    'version', 1,
    'type', 'project_metadata',
    'changedFields', to_jsonb(v_changed_fields),
    'before', v_before_state,
    'after', v_after_state
  );

  INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments, actor_full_name_snapshot, actor_email_snapshot, event_details)
  VALUES (v_project_id, p_admin_id, 'update_metadata', v_status, v_status, 'Updated project metadata.', v_actor_full_name, v_actor_email, v_event_details)
  RETURNING id INTO v_audit_record_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'metadata', pg_catalog.jsonb_build_object(
      'publicId', v_public_id, 'title', v_title, 'summary', v_summary, 'background', v_background, 'solution', v_solution,
      'posterText', v_poster_text, 'accessibilityText', v_accessibility_text,
      'year', p_year::text, 'programId', p_program_id::text,
      'disciplineIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_discipline_ids) x),
      'industryCategoryIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_industry_category_ids) x),
      'expectedUpdatedAt', v_updated_at
    ),
    'auditRecordId', v_audit_record_id::text
  );
END; $$;

REVOKE ALL ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid,text,text) TO service_role;

-- The prior signature would let a service-role caller write metadata without ever supplying
-- accessible content, bypassing both the new requirement and its audit fields. Exactly one
-- callable update_project_metadata signature must remain.
DROP FUNCTION IF EXISTS public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid);

--------------------------------------------------------------------------------
-- 2. submit_import_projects_for_review
--    Forward-redefined from 20260810150000_atomic_import_batch_review_submit.sql (the current
--    authoritative definition). Adds the two accessible-content blocking reasons to the existing
--    pre-mutation readiness pass. Every inherited guarantee is preserved: Editor/Admin permission
--    semantics, reviewer denial, batch advisory lock, completed-batch requirement, deterministic
--    project locking, all-or-nothing behaviour, idempotent already-submitted handling, validation
--    errors/flags, discipline/industry mappings, private poster image/PDF checks, and audit rows.
--------------------------------------------------------------------------------
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

--------------------------------------------------------------------------------
-- 3. perform_project_review_action
--    Forward-redefined from 20260812150000_controlled_public_removal.sql (the current
--    authoritative definition, which added the controlled-public-removal protection on top of the
--    approval-edit-gate participant-preview/correction handling). ALL of that behaviour is
--    preserved verbatim; the only addition is an approval-time accessible-content gate.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.perform_project_review_action(p_public_id text, p_action text, p_comments text, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text; v_comments text; v_roles text[]; v_project_id uuid; v_from_status text;
  v_to_status text; v_archive_reason text; v_now timestamptz; v_audit_record_id uuid;
  v_unresolved integer; v_active integer;
  v_poster_text text; v_accessibility_text text;
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
  IF p_action = 'request_changes' THEN PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id)); END IF;
  SELECT p.id, p.status, p.poster_text_public, p.accessibility_text_public
    INTO v_project_id, v_from_status, v_poster_text, v_accessibility_text
    FROM public.projects p WHERE p.public_id = v_public_id AND p.deleted_at IS NULL FOR UPDATE;
  IF v_project_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PROJECT_NOT_FOUND'; END IF;
  IF v_from_status = 'published' AND p_action = 'archive' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED');
  END IF;
  IF v_from_status = 'approved' AND p_action = 'request_changes' THEN
    PERFORM pp.id FROM public.participant_previews pp WHERE pp.project_id = v_project_id AND pp.status = 'active' ORDER BY pp.id FOR UPDATE;
    SELECT count(*) INTO v_unresolved FROM public.participant_preview_correction_requests r JOIN public.participant_previews pp ON pp.id = r.participant_preview_id WHERE pp.project_id = v_project_id AND r.status IN ('open', 'in_progress');
    IF v_unresolved > 0 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'CORRECTION_RESOLUTION_REQUIRED'); END IF;
    SELECT count(*) INTO v_active FROM public.participant_previews WHERE project_id = v_project_id AND status = 'active';
    IF v_active > 1 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'AMBIGUOUS_ACTIVE_PREVIEW'); END IF;
    IF v_active = 1 THEN UPDATE public.participant_previews SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = p_admin_id WHERE project_id = v_project_id AND status = 'active'; END IF;
    v_to_status := 'changes_requested';
  ELSE
    CASE v_from_status
      WHEN 'submitted', 'in_review' THEN CASE p_action WHEN 'request_changes' THEN v_to_status := 'changes_requested'; WHEN 'approve' THEN v_to_status := 'approved'; WHEN 'archive' THEN v_to_status := 'archived'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END CASE;
      WHEN 'changes_requested' THEN IF p_action = 'approve' THEN v_to_status := 'approved'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;
      WHEN 'approved' THEN IF p_action = 'archive' THEN v_to_status := 'archived'; ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID'; END IF;
      ELSE RAISE EXCEPTION 'REVIEW_TRANSITION_INVALID';
    END CASE;
  END IF;
  -- Approval is the last point at which a project can still be corrected cheaply, and it is the
  -- gate a caller could otherwise reach without ever passing through import-review preparation.
  -- Re-read from the locked row, so this holds regardless of how the project got here. Only
  -- 'approve' is gated: request_changes and archive must stay available precisely so staff can
  -- move a non-compliant project somewhere useful.
  --
  -- Absent and oversized are reported as distinct codes so staff are never told to shorten
  -- something that is missing, or to supply something that is merely too long.
  IF p_action = 'approve' THEN
    IF pg_catalog.btrim(COALESCE(v_poster_text, '')) = ''
       OR pg_catalog.btrim(COALESCE(v_accessibility_text, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED');
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(v_poster_text)) > 20000
       OR pg_catalog.length(pg_catalog.btrim(v_accessibility_text)) > 2000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_INVALID');
    END IF;
  END IF;
  v_now := pg_catalog.now();
  IF p_action = 'archive' THEN
    v_archive_reason := COALESCE(v_comments, 'Archived under standard review workflow');
    UPDATE public.projects SET status = v_to_status, archived_at = v_now, archived_from_status = v_from_status, archive_reason = v_archive_reason, pending_removal_from_public = true WHERE id = v_project_id;
  ELSIF p_action = 'approve' THEN UPDATE public.projects SET status = v_to_status, archived_at = NULL, archived_from_status = NULL, archive_reason = NULL WHERE id = v_project_id;
  ELSE UPDATE public.projects SET status = v_to_status WHERE id = v_project_id; END IF;
  INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments)
  VALUES (v_project_id, p_admin_id, p_action, v_from_status, v_to_status, v_comments) RETURNING id INTO v_audit_record_id;
  RETURN pg_catalog.jsonb_build_object('publicId', v_public_id, 'status', v_to_status, 'auditRecordId', v_audit_record_id::text);
END; $$;

REVOKE ALL ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) TO service_role;

--------------------------------------------------------------------------------
-- 4. get_project_publication_readiness
--    Forward-redefined from 20260811150000_publication_readiness_gate.sql (the current
--    authoritative definition). Every inherited rule is preserved: authorization, project advisory
--    lock, active-preview cardinality, confirmation requirement, correction-resolution logic,
--    snapshot and media-snapshot comparison, and fail-closed malformed-state handling.
--
--    The added gate is deliberately independent of the participant preview. The snapshot
--    comparison alone would let an approved project whose accessible content was already blank
--    when the preview was generated pass readiness — the stored snapshot and the current row would
--    simply agree on the absence. Publication readiness must reject that outright.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_project_publication_readiness(
  p_public_id text,
  p_admin_id uuid,
  p_private_bucket text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_private_bucket text;
  v_roles text[];
  v_has_review boolean;
  v_project RECORD;
  v_active_preview RECORD;
  v_active_preview_count integer;
  v_confirmation RECORD;
  v_active_corr_count integer;
  v_unresolved_corr_count integer;
  v_replacement_count integer;
  v_invalid_media_element_count integer;
  v_current_snapshot jsonb;
  v_current_media_snapshot jsonb;
  v_stored_media_snapshot jsonb;
  v_canonical_current_media jsonb;
  v_canonical_stored_media jsonb;
  v_accessibility_blockers text[];
  v_blockers text[];
BEGIN
  v_blockers := '{}'::text[];

  -- 1. Input Validation
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_NOT_FOUND',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project not found'])
    );
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_SELECTION',
      'blockers', pg_catalog.to_jsonb(ARRAY['Invalid project identifier'])
    );
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_PERMISSION_DENIED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Permission denied'])
    );
  END IF;

  IF p_private_bucket IS NULL OR pg_catalog.btrim(p_private_bucket) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PRIVATE_BUCKET',
      'blockers', pg_catalog.to_jsonb(ARRAY['Invalid private bucket configuration'])
    );
  END IF;
  v_private_bucket := pg_catalog.btrim(p_private_bucket);

  -- 2. Advisory Lock Serialization
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization Check. Readiness is review evidence, so review authority
  -- is sufficient; correction resolution retains its separate combined check.
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_PERMISSION_DENIED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Permission denied'])
    );
  END IF;

  v_has_review := ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles));

  IF NOT v_has_review THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_PERMISSION_DENIED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Permission denied'])
    );
  END IF;

  -- 4. Lock and inspect authoritative project
  SELECT p.*
    INTO v_project
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_NOT_FOUND',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project not found'])
    );
  END IF;

  -- Preserve meaningful correction workflow state ahead of generic project or
  -- preview-state outcomes. Resolution may revoke the old preview while the
  -- project awaits reapproval, but the correction is still unresolved.
  SELECT pg_catalog.count(*)
    INTO v_unresolved_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project.id
     AND r.status IN ('open', 'in_progress');

  -- A confirmed current preview with any correction row is contradictory
  -- persisted state. Check it before the legitimate lifecycle short-circuit.
  SELECT pg_catalog.count(*)
    INTO v_active_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
    JOIN public.participant_preview_confirmations c ON c.participant_preview_id = pp.id
   WHERE pp.project_id = v_project.id
     AND pp.status = 'active';

  IF v_active_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Active preview has contradictory participant responses'])
    );
  END IF;

  IF v_unresolved_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'CORRECTION_UNRESOLVED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant correction must be resolved']),
      'confirmedPreviewId', null,
      'confirmedAt', null
    );
  END IF;

  IF v_project.status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PROJECT_STATE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project status must be approved to evaluate publication readiness'])
    );
  END IF;

  -- 4b. Accessible poster content is a precondition of publication in its own right, evaluated
  -- against the locked project row rather than against any stored preview evidence. Both absence
  -- and oversize fail closed, and the diagnostic distinguishes them truthfully. Nothing is ever
  -- truncated to make a row publishable.
  v_accessibility_blockers := '{}'::text[];
  IF pg_catalog.btrim(COALESCE(v_project.poster_text_public, '')) = '' THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Poster full text is missing');
  ELSIF pg_catalog.length(pg_catalog.btrim(v_project.poster_text_public)) > 20000 THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Poster full text exceeds the 20,000 character safety limit');
  END IF;
  IF pg_catalog.btrim(COALESCE(v_project.accessibility_text_public, '')) = '' THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Accessibility text is missing');
  ELSIF pg_catalog.length(pg_catalog.btrim(v_project.accessibility_text_public)) > 2000 THEN
    v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Accessibility text exceeds the 2,000 character safety limit');
  END IF;
  IF pg_catalog.cardinality(v_accessibility_blockers) > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED',
      'blockers', pg_catalog.to_jsonb(v_accessibility_blockers)
    );
  END IF;

  -- 5. Lock and inspect active participant preview. More than one active row
  -- is contradictory persisted state and must never select an arbitrary row.
  SELECT pg_catalog.count(*)
    INTO v_active_preview_count
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project.id
     AND pp.status = 'active';

  IF v_active_preview_count = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'NO_ACTIVE_PREVIEW',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant preview required'])
    );
  END IF;

  IF v_active_preview_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant preview state is ambiguous'])
    );
  END IF;

  SELECT pp.*
    INTO v_active_preview
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project.id
     AND pp.status = 'active'
     FOR UPDATE;

  -- 6. Check confirmation for active preview
  SELECT c.*
    INTO v_confirmation
    FROM public.participant_preview_confirmations c
   WHERE c.participant_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NULL THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Waiting for participant confirmation');
  END IF;

  -- 7. Any correction against a confirmed active preview is contradictory.
  SELECT pg_catalog.count(*)
    INTO v_active_corr_count
    FROM public.participant_preview_correction_requests r
   WHERE r.participant_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NOT NULL AND v_active_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Active preview has contradictory participant responses'])
    );
  END IF;

  -- 8. Check for unresolved (open or in_progress) correction requests across ALL previews of this project
  SELECT pg_catalog.count(*)
    INTO v_unresolved_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project.id
     AND r.status IN ('open', 'in_progress');

  IF v_unresolved_corr_count > 0 THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Participant correction must be resolved');
  END IF;

  IF v_unresolved_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'CORRECTION_UNRESOLVED',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  IF v_project.status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PROJECT_STATE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project status must be approved to evaluate publication readiness'])
    );
  END IF;

  -- A corrected replacement preview is identified from the persisted
  -- correction-resolution relationship, never browser state or history alone.
  SELECT pg_catalog.count(*)
    INTO v_replacement_count
    FROM public.participant_preview_correction_requests r
   WHERE r.status = 'resolved'
     AND r.replacement_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', CASE WHEN v_replacement_count = 1
        THEN 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION'
        WHEN v_replacement_count = 0 THEN 'PREVIEW_NOT_CONFIRMED'
        ELSE 'READINESS_UNAVAILABLE'
      END,
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', null,
      'confirmedAt', null
    );
  END IF;

  IF v_replacement_count > 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Correction replacement state is ambiguous'])
    );
  END IF;

  IF pg_catalog.jsonb_typeof(v_active_preview.snapshot) <> 'object'
     OR pg_catalog.jsonb_typeof(v_active_preview.media_snapshot) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview state is malformed'])
    );
  END IF;

  -- 9. Re-derive current canonical participant-facing project snapshot
  SELECT pg_catalog.jsonb_build_object(
      'title', p.title,
      'summary', p.summary,
      'background', p.background,
      'solution', p.solution,
      'year', p.year,
      'program', p.program_name,
      'studyProgram', p.study_program,
      'discipline', p.discipline,
      'industry', p.industry,
      'industryPartner', p.industry_partner,
      'academicSupervisor', p.academic_supervisor,
      'groupName', p.group_name,
      'teamMembers', pg_catalog.to_jsonb(COALESCE(p.team_members, '{}'::text[])),
      'posterText', p.poster_text_public,
      'accessibilityText', p.accessibility_text_public,
      'citations', pg_catalog.to_jsonb(COALESCE(p.citations, '{}'::text[])),
      'externalLinks', COALESCE(p.external_links, '[]'::jsonb),
      'disciplines', COALESCE((
        SELECT pg_catalog.jsonb_agg(d.name ORDER BY d.name)
          FROM public.project_disciplines pd
          JOIN public.disciplines d ON d.id = pd.discipline_id
         WHERE pd.project_id = p.id
      ), '[]'::jsonb),
      'industryCategories', COALESCE((
        SELECT pg_catalog.jsonb_agg(ic.name ORDER BY ic.name)
          FROM public.project_industry_categories pic
          JOIN public.industry_categories ic ON ic.id = pic.industry_category_id
         WHERE pic.project_id = p.id
      ), '[]'::jsonb)
    )
    INTO v_current_snapshot
    FROM public.projects p
   WHERE p.id = v_project.id;

  -- Compare project snapshot against stored active preview snapshot. posterText and
  -- accessibilityText are part of this canonical snapshot, so an accessible-content edit made
  -- after confirmation invalidates the confirmation exactly like any other content change.
  IF v_current_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project information changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 10. Re-derive current canonical private media snapshot
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'mediaAssetId', ma.id,
      'assetType', ma.asset_type,
      'fileName', ma.file_name,
      'storageBucket', ma.storage_bucket,
      'storagePath', ma.storage_path,
      'mimeType', ma.mime_type
    )), '[]'::jsonb)
    INTO v_current_media_snapshot
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.storage_bucket = v_private_bucket
     AND ma.is_public_approved = false
     AND ma.public_url IS NULL;

  -- Canonicalize both current and stored media snapshots for order-independent comparison
  SELECT COALESCE(pg_catalog.jsonb_agg(elem ORDER BY (elem->>'mediaAssetId')), '[]'::jsonb)
    INTO v_canonical_current_media
    FROM pg_catalog.jsonb_array_elements(v_current_media_snapshot) elem;

  v_stored_media_snapshot := COALESCE(v_active_preview.media_snapshot, '[]'::jsonb);

  SELECT pg_catalog.count(*) INTO v_invalid_media_element_count
    FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem
   WHERE pg_catalog.jsonb_typeof(elem) <> 'object'
      OR pg_catalog.jsonb_typeof(elem->'mediaAssetId') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'assetType') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'fileName') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storageBucket') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storagePath') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'mimeType') <> 'string';

  IF v_invalid_media_element_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview media state is malformed'])
    );
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(elem ORDER BY (elem->>'mediaAssetId')), '[]'::jsonb)
    INTO v_canonical_stored_media
    FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem;

  IF v_canonical_current_media IS DISTINCT FROM v_canonical_stored_media THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project media changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'MEDIA_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 11. All conditions satisfied -> READY
  RETURN pg_catalog.jsonb_build_object(
    'ready', true,
    'resultCode', 'READY',
    'blockers', '[]'::jsonb,
    'confirmedPreviewId', v_active_preview.id,
    'confirmedAt', v_confirmation.confirmed_at::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) TO service_role;

COMMIT;
