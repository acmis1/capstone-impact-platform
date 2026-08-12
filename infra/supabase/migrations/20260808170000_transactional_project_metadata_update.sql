-- Atomic, service-role-only project metadata update.
-- Metadata audit records are intentionally deferred; this function changes no approval state.

BEGIN;

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
  p_expected_updated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_title text;
  v_summary text;
  v_background text;
  v_solution text;
  v_project_id uuid;
  v_current_updated_at timestamptz;
  v_updated_at timestamptz;
  v_program_name text;
  v_discipline_name text;
  v_industry_name text;
  v_discipline_count integer;
  v_industry_category_count integer;
BEGIN
  v_public_id := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_title := pg_catalog.btrim(COALESCE(p_title, ''));
  v_summary := pg_catalog.btrim(COALESCE(p_summary, ''));
  v_background := pg_catalog.btrim(COALESCE(p_background, ''));
  v_solution := pg_catalog.btrim(COALESCE(p_solution, ''));

  IF v_public_id = ''
    OR v_title = ''
    OR v_summary = ''
    OR pg_catalog.length(v_title) > 200
    OR pg_catalog.length(v_summary) > 1000
    OR pg_catalog.length(v_background) > 10000
    OR pg_catalog.length(v_solution) > 10000
    OR p_year IS NULL
    OR p_year < 2000
    OR p_year > 2100
    OR p_program_id IS NULL
    OR p_expected_updated_at IS NULL
    OR p_discipline_ids IS NULL
    OR pg_catalog.cardinality(p_discipline_ids) = 0
    OR pg_catalog.array_position(p_discipline_ids, NULL) IS NOT NULL
    OR p_industry_category_ids IS NULL
    OR pg_catalog.cardinality(p_industry_category_ids) = 0
    OR pg_catalog.array_position(p_industry_category_ids, NULL) IS NOT NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.count(DISTINCT d_id)
    INTO v_discipline_count
    FROM pg_catalog.unnest(p_discipline_ids) AS d_id;
  SELECT pg_catalog.count(DISTINCT c_id)
    INTO v_industry_category_count
    FROM pg_catalog.unnest(p_industry_category_ids) AS c_id;

  IF v_discipline_count <> pg_catalog.cardinality(p_discipline_ids)
    OR v_industry_category_count <> pg_catalog.cardinality(p_industry_category_ids)
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT p.id, p.updated_at
    INTO v_project_id, v_current_updated_at
    FROM public.projects AS p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  IF v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION');
  END IF;

  SELECT p.name INTO v_program_name FROM public.programs AS p WHERE p.id = p_program_id;
  SELECT d.name INTO v_discipline_name FROM public.disciplines AS d WHERE d.id = p_discipline_ids[1];
  SELECT c.name INTO v_industry_name FROM public.industry_categories AS c WHERE c.id = p_industry_category_ids[1];

  IF v_program_name IS NULL
    OR v_discipline_name IS NULL
    OR v_industry_name IS NULL
    OR (SELECT pg_catalog.count(*) FROM public.disciplines AS d WHERE d.id = ANY(p_discipline_ids)) <> pg_catalog.cardinality(p_discipline_ids)
    OR (SELECT pg_catalog.count(*) FROM public.industry_categories AS c WHERE c.id = ANY(p_industry_category_ids)) <> pg_catalog.cardinality(p_industry_category_ids)
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  UPDATE public.projects
     SET title = v_title,
         summary = v_summary,
         background = v_background,
         solution = v_solution,
         year = p_year,
         program_id = p_program_id,
         program_name = v_program_name,
         discipline = v_discipline_name,
         industry = v_industry_name
   WHERE id = v_project_id
   RETURNING updated_at INTO v_updated_at;

  DELETE FROM public.project_disciplines WHERE project_id = v_project_id;
  INSERT INTO public.project_disciplines (project_id, discipline_id)
  SELECT v_project_id, item.discipline_id
    FROM pg_catalog.unnest(p_discipline_ids) WITH ORDINALITY AS item(discipline_id, ordinal)
   ORDER BY item.ordinal;

  DELETE FROM public.project_industry_categories WHERE project_id = v_project_id;
  INSERT INTO public.project_industry_categories (project_id, industry_category_id)
  SELECT v_project_id, item.industry_category_id
    FROM pg_catalog.unnest(p_industry_category_ids) WITH ORDINALITY AS item(industry_category_id, ordinal)
   ORDER BY item.ordinal;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'metadata', pg_catalog.jsonb_build_object(
      'publicId', v_public_id,
      'title', v_title,
      'summary', v_summary,
      'background', v_background,
      'solution', v_solution,
      'year', p_year::text,
      'programId', p_program_id::text,
      'disciplineIds', (SELECT pg_catalog.jsonb_agg(item.discipline_id::text ORDER BY item.ordinal) FROM pg_catalog.unnest(p_discipline_ids) WITH ORDINALITY AS item(discipline_id, ordinal)),
      'industryCategoryIds', (SELECT pg_catalog.jsonb_agg(item.industry_category_id::text ORDER BY item.ordinal) FROM pg_catalog.unnest(p_industry_category_ids) WITH ORDINALITY AS item(industry_category_id, ordinal)),
      'expectedUpdatedAt', v_updated_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_project_metadata(text, text, text, text, text, integer, uuid, uuid[], uuid[], timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_project_metadata(text, text, text, text, text, integer, uuid, uuid[], uuid[], timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.update_project_metadata(text, text, text, text, text, integer, uuid, uuid[], uuid[], timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_project_metadata(text, text, text, text, text, integer, uuid, uuid[], uuid[], timestamptz) TO service_role;

COMMIT;
