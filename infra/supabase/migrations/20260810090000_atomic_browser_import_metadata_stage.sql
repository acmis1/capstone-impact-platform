-- Migration: 20260810090000_atomic_browser_import_metadata_stage.sql
-- Description: Atomic, service-role-only browser import metadata staging transaction and ledger

BEGIN;

-- 1. Safely extend import_batches check constraint for status
ALTER TABLE public.import_batches
  DROP CONSTRAINT IF EXISTS check_batch_status;

ALTER TABLE public.import_batches
  ADD CONSTRAINT check_batch_status
  CHECK (status IN ('pending', 'processing', 'metadata_staged', 'completed', 'failed'));

-- 2. Create browser_import_commits idempotency ledger table
CREATE TABLE IF NOT EXISTS public.browser_import_commits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_hash TEXT NOT NULL UNIQUE CONSTRAINT check_intent_hash_hex CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
    preview_fingerprint TEXT NOT NULL CONSTRAINT check_preview_fingerprint_hex CHECK (preview_fingerprint ~ '^[a-f0-9]{64}$'),
    canonical_intent JSONB NOT NULL,
    batch_id UUID NOT NULL UNIQUE REFERENCES public.import_batches(id) ON DELETE CASCADE,
    imported_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_browser_import_commits_intent_hash ON public.browser_import_commits(intent_hash);
CREATE INDEX IF NOT EXISTS idx_browser_import_commits_batch_id ON public.browser_import_commits(batch_id);

-- 3. Service-role-only atomic metadata staging RPC
CREATE OR REPLACE FUNCTION public.stage_browser_import_metadata(
  p_intent_hash text,
  p_preview_fingerprint text,
  p_canonical_intent jsonb,
  p_mode text,
  p_source_folder text,
  p_imported_by_id uuid,
  p_packages jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent_hash text;
  v_preview_fingerprint text;
  v_mode text;
  v_source_folder text;
  v_existing_commit_record RECORD;
  v_pkg_count integer;
  v_warning_count_total integer := 0;
  v_batch_id uuid;
  v_pkg jsonb;
  v_pkg_path text;
  v_public_id text;
  v_title text;
  v_summary text;
  v_background text;
  v_solution text;
  v_year integer;
  v_program_name text;
  v_study_program text;
  v_industry_partner text;
  v_academic_supervisor text;
  v_group_name text;
  v_team_members text[];
  v_poster_text text;
  v_accessibility_text text;
  v_layout_config jsonb;
  v_package_validation jsonb;
  v_validation_warnings text[];
  v_validation_flags jsonb;
  v_program_id uuid;
  v_program_db_name text;
  v_project_id uuid;
  v_disc_name text;
  v_disc_id uuid;
  v_first_disc_name text;
  v_first_disc_id uuid;
  v_ind_name text;
  v_ind_id uuid;
  v_first_ind_name text;
  v_first_ind_id uuid;
  v_flag jsonb;
  v_flag_severity text;
  v_flag_rule_code text;
  v_flag_message text;
  v_flag_field_name text;
  v_existing_proj_count integer;
  v_admin_count integer;
  v_match_count integer;
  v_path_array text[] := ARRAY[]::text[];
  v_public_id_array text[] := ARRAY[]::text[];
BEGIN
  -- 1. Top-level parameter validation
  v_intent_hash := pg_catalog.btrim(COALESCE(p_intent_hash, ''));
  v_preview_fingerprint := pg_catalog.btrim(COALESCE(p_preview_fingerprint, ''));
  v_mode := pg_catalog.btrim(COALESCE(p_mode, 'unknown'));
  v_source_folder := pg_catalog.btrim(COALESCE(p_source_folder, ''));

  IF v_intent_hash !~ '^[a-f0-9]{64}$' OR v_preview_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INTENT');
  END IF;

  IF p_canonical_intent IS NULL OR pg_catalog.jsonb_typeof(p_canonical_intent) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INTENT');
  END IF;

  IF v_mode NOT IN ('single', 'batch', 'manual', 'unknown') THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INTENT');
  END IF;

  -- 2. Transaction lock & Idempotency Check
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_intent_hash));

  SELECT c.batch_id, b.total_projects, b.warning_count, b.status
    INTO v_existing_commit_record
    FROM public.browser_import_commits AS c
    JOIN public.import_batches AS b ON b.id = c.batch_id
   WHERE c.intent_hash = v_intent_hash;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'SUCCESS',
      'result', 'already_staged',
      'batchId', v_existing_commit_record.batch_id,
      'projectCount', v_existing_commit_record.total_projects,
      'warningCount', v_existing_commit_record.warning_count,
      'batchStatus', v_existing_commit_record.status
    );
  END IF;

  -- 3. Package array & count validation (MAX 25)
  IF p_packages IS NULL OR pg_catalog.jsonb_typeof(p_packages) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  v_pkg_count := pg_catalog.jsonb_array_length(p_packages);
  IF v_pkg_count = 0 OR v_pkg_count > 25 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  -- 4. Validate acting administrator
  IF p_imported_by_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  SELECT pg_catalog.count(*) INTO v_admin_count
    FROM public.admin_users AS u
   WHERE u.id = p_imported_by_id;

  IF v_admin_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  -- 5. Pre-mutation validation loop over all packages & lookups
  FOR v_pkg IN SELECT * FROM pg_catalog.jsonb_array_elements(p_packages) LOOP
    IF pg_catalog.jsonb_typeof(v_pkg) <> 'object' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
    END IF;

    v_pkg_path := pg_catalog.btrim(COALESCE(v_pkg->>'packagePath', ''));
    v_public_id := pg_catalog.btrim(COALESCE(v_pkg->>'publicId', ''));
    v_title := pg_catalog.btrim(COALESCE(v_pkg->>'title', ''));
    v_summary := pg_catalog.btrim(COALESCE(v_pkg->>'summary', ''));
    v_program_name := pg_catalog.btrim(COALESCE(v_pkg->>'program', ''));
    v_group_name := pg_catalog.btrim(COALESCE(v_pkg->>'groupName', ''));

    IF v_pkg_path = '' OR v_public_id = '' OR v_title = '' OR v_summary = '' OR v_program_name = '' OR v_group_name = '' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
    END IF;

    -- Validate year range
    IF (v_pkg->>'year') !~ '^\d{4}$' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
    END IF;
    v_year := (v_pkg->>'year')::integer;
    IF v_year < 2000 OR v_year > 2100 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
    END IF;

    -- Check duplicate packagePath within request
    IF v_pkg_path = ANY(v_path_array) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
    END IF;
    v_path_array := pg_catalog.array_append(v_path_array, v_pkg_path);

    -- Check duplicate publicId within request
    IF v_public_id = ANY(v_public_id_array) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
    END IF;
    v_public_id_array := pg_catalog.array_append(v_public_id_array, v_public_id);

    -- Check existing publicId conflict in database (including soft-deleted rows)
    SELECT pg_catalog.count(*) INTO v_existing_proj_count
      FROM public.projects AS p
     WHERE p.public_id = v_public_id;

    IF v_existing_proj_count > 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_ALREADY_EXISTS');
    END IF;

    -- Strict taxonomy resolution: Program
    SELECT pg_catalog.count(*) INTO v_match_count
      FROM public.programs AS p
     WHERE pg_catalog.lower(pg_catalog.btrim(p.name)) = pg_catalog.lower(v_program_name);

    IF v_match_count <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'LOOKUP_NOT_FOUND');
    END IF;

    -- Strict taxonomy resolution: Disciplines
    IF v_pkg ? 'disciplines' AND pg_catalog.jsonb_typeof(v_pkg->'disciplines') = 'array' THEN
      FOR v_disc_name IN SELECT pg_catalog.btrim(elem.value::text, '"') FROM pg_catalog.jsonb_array_elements(v_pkg->'disciplines') AS elem LOOP
        IF v_disc_name <> '' THEN
          SELECT pg_catalog.count(*) INTO v_match_count
            FROM public.disciplines AS d
           WHERE pg_catalog.lower(pg_catalog.btrim(d.name)) = pg_catalog.lower(v_disc_name);
          IF v_match_count <> 1 THEN
            RETURN pg_catalog.jsonb_build_object('resultCode', 'LOOKUP_NOT_FOUND');
          END IF;
        END IF;
      END LOOP;
    END IF;

    -- Strict taxonomy resolution: Industry categories
    IF v_pkg ? 'industryCategories' AND pg_catalog.jsonb_typeof(v_pkg->'industryCategories') = 'array' THEN
      FOR v_ind_name IN SELECT pg_catalog.btrim(elem.value::text, '"') FROM pg_catalog.jsonb_array_elements(v_pkg->'industryCategories') AS elem LOOP
        IF v_ind_name <> '' THEN
          SELECT pg_catalog.count(*) INTO v_match_count
            FROM public.industry_categories AS c
           WHERE pg_catalog.lower(pg_catalog.btrim(c.name)) = pg_catalog.lower(v_ind_name);
          IF v_match_count <> 1 THEN
            RETURN pg_catalog.jsonb_build_object('resultCode', 'LOOKUP_NOT_FOUND');
          END IF;
        END IF;
      END LOOP;
    END IF;

    -- Validate validationFlags shape & severity
    IF v_pkg ? 'validationFlags' AND pg_catalog.jsonb_typeof(v_pkg->'validationFlags') = 'array' THEN
      FOR v_flag IN SELECT * FROM pg_catalog.jsonb_array_elements(v_pkg->'validationFlags') LOOP
        IF pg_catalog.jsonb_typeof(v_flag) <> 'object' THEN
          RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
        END IF;
        v_flag_severity := COALESCE(v_flag->>'severity', '');
        IF v_flag_severity <> 'warning' THEN
          RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
        END IF;
        IF pg_catalog.btrim(COALESCE(v_flag->>'ruleCode', '')) = '' OR pg_catalog.btrim(COALESCE(v_flag->>'message', '')) = '' THEN
          RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
        END IF;
        v_warning_count_total := v_warning_count_total + 1;
      END LOOP;
    END IF;
  END LOOP;

  --------------------------------------------------------------------------------
  -- ALL VALIDATION PASSED BEFORE MUTATIONS BEGIN.
  -- AFTER THIS POINT, ANY UNEXPECTED FAILURE MUST RAISE AN EXCEPTION TO ROLL BACK.
  --------------------------------------------------------------------------------

  -- 6. Insert import_batches row
  INSERT INTO public.import_batches (
    batch_name,
    mode,
    source_folder,
    imported_by,
    status,
    total_projects,
    warning_count,
    error_count
  ) VALUES (
    v_source_folder,
    v_mode,
    v_source_folder,
    p_imported_by_id,
    'metadata_staged',
    v_pkg_count,
    v_warning_count_total,
    0
  ) RETURNING id INTO v_batch_id;

  -- 7. Insert projects, mappings, and validation flags
  FOR v_pkg IN SELECT * FROM pg_catalog.jsonb_array_elements(p_packages) LOOP
    v_public_id := pg_catalog.btrim(v_pkg->>'publicId');
    v_title := pg_catalog.btrim(v_pkg->>'title');
    v_summary := pg_catalog.btrim(v_pkg->>'summary');
    v_background := pg_catalog.btrim(COALESCE(v_pkg->>'background', ''));
    v_solution := pg_catalog.btrim(COALESCE(v_pkg->>'solution', ''));
    v_year := (v_pkg->>'year')::integer;
    v_program_name := pg_catalog.btrim(v_pkg->>'program');
    v_study_program := pg_catalog.btrim(COALESCE(v_pkg->>'studyProgram', v_program_name));
    v_industry_partner := pg_catalog.btrim(COALESCE(v_pkg->>'industryPartner', ''));
    v_academic_supervisor := pg_catalog.btrim(COALESCE(v_pkg->>'academicSupervisor', ''));
    v_group_name := pg_catalog.btrim(v_pkg->>'groupName');

    v_team_members := ARRAY[]::text[];
    IF v_pkg ? 'teamMembers' AND pg_catalog.jsonb_typeof(v_pkg->'teamMembers') = 'array' THEN
      SELECT pg_catalog.array_agg(m.val) INTO v_team_members
        FROM (SELECT pg_catalog.btrim(elem.value::text, '"') AS val FROM pg_catalog.jsonb_array_elements(v_pkg->'teamMembers') AS elem) AS m
       WHERE m.val <> '';
    END IF;

    v_poster_text := COALESCE(v_pkg->>'posterText', NULL);
    v_accessibility_text := COALESCE(v_pkg->>'accessibilityText', NULL);
    v_layout_config := COALESCE(v_pkg->'layoutConfig', '{}'::jsonb);
    v_package_validation := COALESCE(v_pkg->'packageValidation', '{}'::jsonb);

    v_validation_warnings := ARRAY[]::text[];
    IF v_pkg ? 'validationWarnings' AND pg_catalog.jsonb_typeof(v_pkg->'validationWarnings') = 'array' THEN
      SELECT pg_catalog.array_agg(w.val) INTO v_validation_warnings
        FROM (SELECT pg_catalog.btrim(elem.value::text, '"') AS val FROM pg_catalog.jsonb_array_elements(v_pkg->'validationWarnings') AS elem) AS w
       WHERE w.val <> '';
    END IF;

    -- Fetch exact canonical program name and ID
    SELECT p.id, p.name INTO STRICT v_program_id, v_program_db_name
      FROM public.programs AS p
     WHERE pg_catalog.lower(pg_catalog.btrim(p.name)) = pg_catalog.lower(v_program_name);

    -- Resolve disciplines & industry categories to populate scalar compatibility fields
    v_first_disc_name := NULL;
    v_first_disc_id := NULL;
    IF v_pkg ? 'disciplines' AND pg_catalog.jsonb_typeof(v_pkg->'disciplines') = 'array' THEN
      FOR v_disc_name IN SELECT pg_catalog.btrim(elem.value::text, '"') FROM pg_catalog.jsonb_array_elements(v_pkg->'disciplines') AS elem LOOP
        IF v_disc_name <> '' THEN
          SELECT d.id, d.name INTO STRICT v_disc_id, v_disc_name
            FROM public.disciplines AS d
           WHERE pg_catalog.lower(pg_catalog.btrim(d.name)) = pg_catalog.lower(v_disc_name);
          IF v_first_disc_id IS NULL THEN
            v_first_disc_id := v_disc_id;
            v_first_disc_name := v_disc_name;
          END IF;
        END IF;
      END LOOP;
    END IF;

    v_first_ind_name := NULL;
    v_first_ind_id := NULL;
    IF v_pkg ? 'industryCategories' AND pg_catalog.jsonb_typeof(v_pkg->'industryCategories') = 'array' THEN
      FOR v_ind_name IN SELECT pg_catalog.btrim(elem.value::text, '"') FROM pg_catalog.jsonb_array_elements(v_pkg->'industryCategories') AS elem LOOP
        IF v_ind_name <> '' THEN
          SELECT c.id, c.name INTO STRICT v_ind_id, v_ind_name
            FROM public.industry_categories AS c
           WHERE pg_catalog.lower(pg_catalog.btrim(c.name)) = pg_catalog.lower(v_ind_name);
          IF v_first_ind_id IS NULL THEN
            v_first_ind_id := v_ind_id;
            v_first_ind_name := v_ind_name;
          END IF;
        END IF;
      END LOOP;
    END IF;

    -- Insert project row
    INSERT INTO public.projects (
      public_id,
      title,
      summary,
      background,
      solution,
      year,
      program_id,
      program_name,
      study_program,
      discipline,
      industry,
      industry_partner,
      academic_supervisor,
      group_name,
      team_members,
      poster_text_public,
      accessibility_text_public,
      layout_config,
      status,
      import_batch_id,
      source_folder,
      package_validation,
      validation_warnings
    ) VALUES (
      v_public_id,
      v_title,
      v_summary,
      v_background,
      v_solution,
      v_year,
      v_program_id,
      v_program_db_name,
      v_study_program,
      v_first_disc_name,
      v_first_ind_name,
      v_industry_partner,
      v_academic_supervisor,
      v_group_name,
      COALESCE(v_team_members, ARRAY[]::text[]),
      v_poster_text,
      v_accessibility_text,
      v_layout_config,
      'draft',
      v_batch_id,
      v_source_folder,
      v_package_validation,
      COALESCE(v_validation_warnings, ARRAY[]::text[])
    ) RETURNING id INTO v_project_id;

    -- Insert discipline mappings
    IF v_pkg ? 'disciplines' AND pg_catalog.jsonb_typeof(v_pkg->'disciplines') = 'array' THEN
      FOR v_disc_name IN SELECT pg_catalog.btrim(elem.value::text, '"') FROM pg_catalog.jsonb_array_elements(v_pkg->'disciplines') AS elem LOOP
        IF v_disc_name <> '' THEN
          SELECT d.id INTO STRICT v_disc_id
            FROM public.disciplines AS d
           WHERE pg_catalog.lower(pg_catalog.btrim(d.name)) = pg_catalog.lower(v_disc_name);

          INSERT INTO public.project_disciplines (project_id, discipline_id)
          VALUES (v_project_id, v_disc_id)
          ON CONFLICT (project_id, discipline_id) DO NOTHING;
        END IF;
      END LOOP;
    END IF;

    -- Insert industry category mappings
    IF v_pkg ? 'industryCategories' AND pg_catalog.jsonb_typeof(v_pkg->'industryCategories') = 'array' THEN
      FOR v_ind_name IN SELECT pg_catalog.btrim(elem.value::text, '"') FROM pg_catalog.jsonb_array_elements(v_pkg->'industryCategories') AS elem LOOP
        IF v_ind_name <> '' THEN
          SELECT c.id INTO STRICT v_ind_id
            FROM public.industry_categories AS c
           WHERE pg_catalog.lower(pg_catalog.btrim(c.name)) = pg_catalog.lower(v_ind_name);

          INSERT INTO public.project_industry_categories (project_id, industry_category_id)
          VALUES (v_project_id, v_ind_id)
          ON CONFLICT (project_id, industry_category_id) DO NOTHING;
        END IF;
      END LOOP;
    END IF;

    -- Insert validation flags
    IF v_pkg ? 'validationFlags' AND pg_catalog.jsonb_typeof(v_pkg->'validationFlags') = 'array' THEN
      FOR v_flag IN SELECT * FROM pg_catalog.jsonb_array_elements(v_pkg->'validationFlags') LOOP
        v_flag_severity := v_flag->>'severity';
        v_flag_rule_code := v_flag->>'ruleCode';
        v_flag_message := v_flag->>'message';
        v_flag_field_name := COALESCE(v_flag->>'fieldName', NULL);

        INSERT INTO public.validation_flags (
          project_id,
          severity,
          rule_code,
          message,
          field_name
        ) VALUES (
          v_project_id,
          v_flag_severity,
          v_flag_rule_code,
          v_flag_message,
          v_flag_field_name
        );
      END LOOP;
    END IF;
  END LOOP;

  -- 8. Create browser_import_commits idempotency ledger row
  INSERT INTO public.browser_import_commits (
    intent_hash,
    preview_fingerprint,
    canonical_intent,
    batch_id,
    imported_by
  ) VALUES (
    v_intent_hash,
    v_preview_fingerprint,
    p_canonical_intent,
    v_batch_id,
    p_imported_by_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'result', 'created',
    'batchId', v_batch_id,
    'projectCount', v_pkg_count,
    'warningCount', v_warning_count_total,
    'batchStatus', 'metadata_staged'
  );
END;
$$;

-- Security hardening
REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) TO service_role;

COMMIT;
