BEGIN;

ALTER TABLE public.approval_records
ADD COLUMN actor_full_name_snapshot TEXT,
ADD COLUMN actor_email_snapshot TEXT,
ADD COLUMN event_details JSONB;

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
  p_admin_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
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
  v_old_year integer;
  v_old_program_id uuid;
  v_old_program_name text;
  v_audit_record_id uuid;
  v_admin_roles text[];
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

  IF p_public_id = '' OR p_title = '' OR p_summary = '' OR pg_catalog.length(p_title) > 200
    OR pg_catalog.length(p_summary) > 1000 OR pg_catalog.length(p_background) > 10000
    OR pg_catalog.length(p_solution) > 10000 OR p_year IS NULL OR p_year < 2000 OR p_year > 2100
    OR p_program_id IS NULL OR p_expected_updated_at IS NULL OR p_discipline_ids IS NULL
    OR pg_catalog.cardinality(p_discipline_ids) = 0 OR pg_catalog.array_position(p_discipline_ids, NULL) IS NOT NULL
    OR p_industry_category_ids IS NULL OR pg_catalog.cardinality(p_industry_category_ids) = 0
    OR pg_catalog.array_position(p_industry_category_ids, NULL) IS NOT NULL
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_discipline_ids) x) <> pg_catalog.cardinality(p_discipline_ids)
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_industry_category_ids) x) <> pg_catalog.cardinality(p_industry_category_ids)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED'); END IF;

  SELECT id, updated_at, status, title, summary, background, solution, year, program_id, program_name
  INTO v_project_id, v_current_updated_at, v_status, v_old_title, v_old_summary, v_old_background, v_old_solution, v_old_year, v_old_program_id, v_old_program_name
  FROM public.projects WHERE public_id = p_public_id AND deleted_at IS NULL FOR UPDATE;
  
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

  IF v_old_title IS DISTINCT FROM p_title THEN 
    v_changed_fields := array_append(v_changed_fields, 'title');
    v_before_state := jsonb_set(v_before_state, '{title}', to_jsonb(v_old_title));
    v_after_state := jsonb_set(v_after_state, '{title}', to_jsonb(p_title));
  END IF;
  IF v_old_summary IS DISTINCT FROM p_summary THEN 
    v_changed_fields := array_append(v_changed_fields, 'summary');
    v_before_state := jsonb_set(v_before_state, '{summary}', to_jsonb(v_old_summary));
    v_after_state := jsonb_set(v_after_state, '{summary}', to_jsonb(p_summary));
  END IF;
  IF coalesce(v_old_background, '') IS DISTINCT FROM p_background THEN 
    v_changed_fields := array_append(v_changed_fields, 'background');
    v_before_state := jsonb_set(v_before_state, '{background}', to_jsonb(coalesce(v_old_background, '')));
    v_after_state := jsonb_set(v_after_state, '{background}', to_jsonb(p_background));
  END IF;
  IF coalesce(v_old_solution, '') IS DISTINCT FROM p_solution THEN 
    v_changed_fields := array_append(v_changed_fields, 'solution');
    v_before_state := jsonb_set(v_before_state, '{solution}', to_jsonb(coalesce(v_old_solution, '')));
    v_after_state := jsonb_set(v_after_state, '{solution}', to_jsonb(p_solution));
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
  
  IF v_old_disciplines IS DISTINCT FROM v_new_disciplines THEN
    v_changed_fields := array_append(v_changed_fields, 'disciplines');
    v_before_state := jsonb_set(v_before_state, '{disciplines}', v_old_disciplines);
    v_after_state := jsonb_set(v_after_state, '{disciplines}', v_new_disciplines);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ic.id, 'name', ic.name) ORDER BY ic.id), '[]'::jsonb) INTO v_old_industries
  FROM public.project_industry_categories pic JOIN public.industry_categories ic ON pic.industry_category_id = ic.id WHERE pic.project_id = v_project_id;
  
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ic.id, 'name', ic.name) ORDER BY ic.id), '[]'::jsonb) INTO v_new_industries
  FROM public.industry_categories ic WHERE ic.id = ANY(p_industry_category_ids);
  
  IF v_old_industries IS DISTINCT FROM v_new_industries THEN
    v_changed_fields := array_append(v_changed_fields, 'industryCategories');
    v_before_state := jsonb_set(v_before_state, '{industryCategories}', v_old_industries);
    v_after_state := jsonb_set(v_after_state, '{industryCategories}', v_new_industries);
  END IF;

  IF array_length(v_changed_fields, 1) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NO_CHANGES');
  END IF;

  UPDATE public.projects SET title = p_title, summary = p_summary, background = p_background, solution = p_solution,
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
      'publicId', p_public_id, 'title', p_title, 'summary', p_summary, 'background', p_background, 'solution', p_solution,
      'year', p_year::text, 'programId', p_program_id::text,
      'disciplineIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_discipline_ids) x),
      'industryCategoryIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_industry_category_ids) x),
      'expectedUpdatedAt', v_updated_at
    ),
    'auditRecordId', v_audit_record_id::text
  );
END; $$;

REVOKE ALL ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid) TO service_role;

DROP FUNCTION IF EXISTS public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz);

COMMIT;
