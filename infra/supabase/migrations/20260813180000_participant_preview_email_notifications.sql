-- Migration 0023: participant preview email notifications.
--
-- Staff may now deliberately generate a participant preview AND email that exact freshly generated
-- secure link to the project's authoritative participant/group contact. Two independent problems
-- are solved here.
--
-- 1. An authoritative recipient.
--    `projects.participant_contact_email` is the single source of truth for participant/group
--    preview correspondence. It arrives through the canonical import path
--    (project-details.xlsx -> workbook parser -> stage_browser_import_metadata, redefined below to
--    persist it) and is normalized by the database itself. No browser payload ever selects, adds or
--    overrides a destination address.
--
-- 2. An external side effect that cannot join a PostgreSQL transaction.
--    SMTP delivery is observable in the outside world and irreversible. The durable lifecycle below
--    therefore records what the application actually knows, never what it hopes:
--
--      reserved          -> a durable lifecycle exists; no transport has been attempted
--      transport_started -> execution has durably crossed the external side-effect boundary
--      sent              -> the transport returned a reliable acceptance and it was persisted
--      failed            -> reliable evidence that the message was not accepted, or that transport
--                           never began at all
--      delivery_unknown  -> transport may have happened; acceptance cannot be safely proven
--
--    This is deliberately NOT an exactly-once claim. Generic SMTP cannot offer one. What is
--    guaranteed is: exactly one authoritative lifecycle per (preview, recipient, kind); at most one
--    ordinary transport invocation per claimed lifecycle; deterministic fencing of stale execution
--    owners; and no automatic resend after an ambiguous outcome.
--
-- The raw preview credential is intentionally non-persistent. It exists only in server memory
-- between generation and the outgoing message, so a delivery attempt CANNOT be resumed later once
-- the process that held it has ended. Nothing below stores, encrypts or reconstructs it, and an
-- expired lease never returns execution rights for an existing lifecycle. Staff who need another
-- emailed preview use the ordinary preview lifecycle to issue a NEW preview with a NEW credential.
--
-- Every privileged function is service-role only. Browser clients can neither read this table nor
-- insert, finalize, re-address or re-attribute a delivery.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Authoritative participant/group contact email
-- ---------------------------------------------------------------------------------------------
-- Nullable: legacy rows predate the column, and an ordinary preview generated without email must
-- never require a contact. This is a project/group communication contact, not an individual
-- participant account. The stored form is always trimmed and lowercased.
ALTER TABLE public.projects
  ADD COLUMN participant_contact_email text;

ALTER TABLE public.projects
  ADD CONSTRAINT check_projects_participant_contact_email CHECK (
    participant_contact_email IS NULL
    OR (
      participant_contact_email = lower(btrim(participant_contact_email))
      AND length(participant_contact_email) BETWEEN 3 AND 254
      AND participant_contact_email !~ '[[:cntrl:]]'
    )
  );

COMMENT ON COLUMN public.projects.participant_contact_email IS
  'Authoritative participant/group contact address used for participant preview correspondence. '
  'Normalized to trimmed lowercase. Never supplied by a browser at send time.';

-- ---------------------------------------------------------------------------------------------
-- 2. The canonical import path now persists the contact email
-- ---------------------------------------------------------------------------------------------
-- Redefined verbatim from Migration 0010 apart from reading, normalizing and inserting
-- `participantContactEmail`. Nothing else about browser import metadata staging changes.
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
  v_participant_contact_email text;
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
  v_mode := pg_catalog.btrim(COALESCE(p_mode, ''));
  v_source_folder := pg_catalog.btrim(COALESCE(p_source_folder, ''));

  IF v_intent_hash !~ '^[a-f0-9]{64}$' OR v_preview_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INTENT');
  END IF;

  IF p_canonical_intent IS NULL OR pg_catalog.jsonb_typeof(p_canonical_intent) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INTENT');
  END IF;

  IF v_mode NOT IN ('single', 'batch') THEN
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

    -- Validate teamMembers array structure
    IF NOT (v_pkg ? 'teamMembers') OR pg_catalog.jsonb_typeof(v_pkg->'teamMembers') <> 'array' OR pg_catalog.jsonb_array_length(v_pkg->'teamMembers') = 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
    END IF;

    -- Validate layoutConfig object structure
    IF NOT (v_pkg ? 'layoutConfig') OR pg_catalog.jsonb_typeof(v_pkg->'layoutConfig') <> 'object' THEN
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

    -- Authoritative participant/group communication contact. Trimmed and lowercased here so the
    -- database, not any browser payload, owns the canonical stored form. Syntactic validation is
    -- deliberately NOT repeated here: the workbook parser rejects a malformed address at import
    -- time with a staff-facing issue, and reserve_participant_preview_notification independently
    -- revalidates the stored value and returns PARTICIPANT_EMAIL_INVALID. Blank (or an absurdly
    -- long) value is stored as NULL so Generate + Send fails closed with PARTICIPANT_EMAIL_MISSING
    -- rather than the whole import failing over an optional communication contact.
    v_participant_contact_email := pg_catalog.lower(
      pg_catalog.btrim(COALESCE(v_pkg->>'participantContactEmail', ''))
    );
    IF v_participant_contact_email = '' OR pg_catalog.length(v_participant_contact_email) > 254 THEN
      v_participant_contact_email := NULL;
    END IF;

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
      participant_contact_email,
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
      v_participant_contact_email,
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

-- CREATE OR REPLACE preserves existing privileges; the original grants are restated so this
-- migration remains self-describing about who may execute the function.
REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.stage_browser_import_metadata(text, text, jsonb, text, text, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Durable delivery ledger
-- ---------------------------------------------------------------------------------------------
-- Deliberately excluded from this table: the raw preview token, the full secure preview URL, the
-- rendered subject/text/HTML body, any provider secret, and any raw provider response. The ledger
-- answers only which exact preview, for which project, to which authoritative recipient, requested
-- by whom, of what kind, in what state, when, whether transport began, and — where the provider
-- gave one — a bounded, non-sensitive transport reference or failure classification.
CREATE TABLE public.participant_preview_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  -- Bound to the exact preview, never to the project alone: after a correction reissue, Preview B
  -- must carry a lifecycle wholly independent of Preview A's preserved history.
  participant_preview_id uuid NOT NULL
    REFERENCES public.participant_previews(id) ON DELETE CASCADE,
  notification_kind text NOT NULL DEFAULT 'initial'
    CONSTRAINT check_participant_preview_notification_kind
      CHECK (notification_kind IN ('initial')),
  -- Historical evidence of where this delivery actually went. Never rewritten when the project's
  -- authoritative contact later changes; a future preview resolves the contact current at that time.
  recipient_email_snapshot text NOT NULL
    CONSTRAINT check_participant_preview_notification_recipient CHECK (
      recipient_email_snapshot = lower(btrim(recipient_email_snapshot))
      AND length(recipient_email_snapshot) BETWEEN 3 AND 254
      AND recipient_email_snapshot !~ '[[:cntrl:]]'
    ),
  requested_by_admin_id uuid REFERENCES public.admin_users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'reserved'
    CONSTRAINT check_participant_preview_notification_status CHECK (
      status IN ('reserved', 'transport_started', 'sent', 'failed', 'delivery_unknown')
    ),
  requested_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  transport_started_at timestamptz,
  sent_at timestamptz,
  finalized_at timestamptz,
  -- A bounded, printable-ASCII provider/message reference for diagnostics only. It is not proof of
  -- delivery and carries no provider response body.
  transport_reference text
    CONSTRAINT check_participant_preview_notification_transport_reference CHECK (
      transport_reference IS NULL
      OR (length(transport_reference) BETWEEN 1 AND 200 AND transport_reference ~ '^[!-~]+$')
    ),
  failure_code text
    CONSTRAINT check_participant_preview_notification_failure_code CHECK (
      failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
  execution_token_hash text NOT NULL
    CONSTRAINT check_participant_preview_notification_execution_hash CHECK (
      execution_token_hash ~ '^[0-9a-f]{64}$'
    ),
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- The state machine is enforced by the database, not merely by the calling service.
  CONSTRAINT check_participant_preview_notification_state CHECK (
    (status = 'reserved'
      AND transport_started_at IS NULL AND sent_at IS NULL AND finalized_at IS NULL
      AND failure_code IS NULL AND transport_reference IS NULL)
    OR (status = 'transport_started'
      AND transport_started_at IS NOT NULL AND sent_at IS NULL AND finalized_at IS NULL
      AND failure_code IS NULL)
    OR (status = 'sent'
      AND transport_started_at IS NOT NULL AND sent_at IS NOT NULL AND finalized_at IS NOT NULL
      AND failure_code IS NULL)
    OR (status = 'failed'
      AND sent_at IS NULL AND finalized_at IS NOT NULL AND failure_code IS NOT NULL)
    OR (status = 'delivery_unknown'
      AND transport_started_at IS NOT NULL AND sent_at IS NULL AND finalized_at IS NOT NULL)
  )
);

-- Declared semantic identity (Preview + authoritative recipient + notification kind). Reservation
-- below keys on (preview, kind) alone, which is strictly stronger for this slice: one initial
-- notification per exact preview, even if the project's contact address changes in between.
CREATE UNIQUE INDEX participant_preview_notifications_identity_uidx
  ON public.participant_preview_notifications(
    participant_preview_id, recipient_email_snapshot, notification_kind
  );

CREATE UNIQUE INDEX participant_preview_notifications_preview_kind_uidx
  ON public.participant_preview_notifications(participant_preview_id, notification_kind);

CREATE INDEX participant_preview_notifications_project_idx
  ON public.participant_preview_notifications(project_id);

ALTER TABLE public.participant_preview_notifications ENABLE ROW LEVEL SECURITY;

-- An explicit always-false policy makes the intent unmistakable alongside the REVOKE below: no
-- Data API role reaches this table, and every write travels through the SECURITY DEFINER functions.
CREATE POLICY admin_all_participant_preview_notifications
  ON public.participant_preview_notifications
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.participant_preview_notifications
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.participant_preview_notifications TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Reserve (or observe) an initial notification lifecycle for an exact preview
-- ---------------------------------------------------------------------------------------------
-- A lifecycle is created ONLY when none exists for this preview and kind. Every other outcome is an
-- observer result that yields no execution token and therefore no transport. In particular an
-- expired lease never re-grants execution: the raw preview credential is gone by then, so the same
-- preview genuinely cannot be emailed again, and pretending otherwise would be a lie.
CREATE OR REPLACE FUNCTION public.reserve_participant_preview_notification(
  p_participant_preview_id uuid,
  p_admin_id uuid,
  p_notification_kind text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_kind text := pg_catalog.btrim(pg_catalog.lower(COALESCE(p_notification_kind, 'initial')));
  v_preview RECORD;
  v_roles text[];
  v_recipient text;
  v_existing public.participant_preview_notifications%ROWTYPE;
  v_execution_token uuid;
  v_row public.participant_preview_notifications%ROWTYPE;
BEGIN
  IF p_participant_preview_id IS NULL OR p_admin_id IS NULL OR v_kind <> 'initial' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- Serialize concurrent reservation attempts for this exact preview.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'capstone.participant_preview_notification:' || p_participant_preview_id::text, 0
    )
  );

  -- Authorization defense-in-depth: the same authority that manages participant previews.
  SELECT pg_catalog.array_agg(r.role) INTO v_roles
    FROM public.user_roles r WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0
     OR NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  SELECT pp.id, pp.project_id, pp.status, pp.expires_at
    INTO v_preview
    FROM public.participant_previews pp
   WHERE pp.id = p_participant_preview_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_NOT_FOUND');
  END IF;

  -- Revoked, expired, or superseded previews are never notified. The single-active partial unique
  -- index on participant_previews means an 'active' row is by definition the project's current one,
  -- so a superseded Preview A is already excluded here.
  IF v_preview.status <> 'active' OR v_preview.expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_NOT_ELIGIBLE');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.participant_preview_confirmations c
     WHERE c.participant_preview_id = v_preview.id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_CONFIRMED');
  END IF;

  -- The authoritative recipient is resolved here, from trusted persisted project data.
  SELECT pg_catalog.lower(pg_catalog.btrim(COALESCE(p.participant_contact_email, '')))
    INTO v_recipient
    FROM public.projects p
   WHERE p.id = v_preview.project_id;

  IF v_recipient IS NULL OR v_recipient = '' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PARTICIPANT_EMAIL_MISSING');
  END IF;

  IF pg_catalog.length(v_recipient) > 254
     OR v_recipient ~ '[[:cntrl:]]'
     OR pg_catalog.regexp_match(
          v_recipient, '^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$'
        ) IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PARTICIPANT_EMAIL_INVALID');
  END IF;

  SELECT * INTO v_existing
    FROM public.participant_preview_notifications n
   WHERE n.participant_preview_id = v_preview.id
     AND n.notification_kind = v_kind
     FOR UPDATE;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', CASE
        WHEN v_existing.status = 'sent' THEN 'ALREADY_SENT'
        WHEN v_existing.status = 'failed' THEN 'ALREADY_FAILED'
        WHEN v_existing.status = 'delivery_unknown' THEN 'DELIVERY_UNKNOWN'
        WHEN v_existing.lease_expires_at > pg_catalog.now() THEN 'IN_PROGRESS'
        WHEN v_existing.status = 'transport_started' THEN 'DELIVERY_UNKNOWN'
        ELSE 'EXPIRED_UNSENT'
      END,
      'notificationId', v_existing.id::text,
      'notificationKind', v_existing.notification_kind,
      'recipient', v_existing.recipient_email_snapshot,
      'status', v_existing.status,
      'requestedAt', pg_catalog.to_jsonb(v_existing.requested_at),
      'sentAt', pg_catalog.to_jsonb(v_existing.sent_at),
      'failureCode', v_existing.failure_code
    );
  END IF;

  v_execution_token := gen_random_uuid();

  INSERT INTO public.participant_preview_notifications(
    project_id, participant_preview_id, notification_kind, recipient_email_snapshot,
    requested_by_admin_id, status, execution_token_hash, lease_expires_at
  ) VALUES (
    v_preview.project_id, v_preview.id, v_kind, v_recipient,
    p_admin_id, 'reserved',
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_execution_token::text, 'UTF8'), 'sha256'), 'hex'
    ),
    pg_catalog.now() + interval '2 minutes'
  ) RETURNING * INTO v_row;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RESERVED',
    'notificationId', v_row.id::text,
    'notificationKind', v_row.notification_kind,
    'executionToken', v_execution_token::text,
    'recipient', v_row.recipient_email_snapshot,
    'status', v_row.status,
    'requestedAt', pg_catalog.to_jsonb(v_row.requested_at),
    'sentAt', NULL,
    'failureCode', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_participant_preview_notification(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_participant_preview_notification(uuid, uuid, text)
  TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Atomic Generate + Send foundation
-- ---------------------------------------------------------------------------------------------
-- One transaction validates the recipient, creates the preview from the caller-supplied hash, and
-- reserves the bound delivery lifecycle. Either all three exist afterwards or none does, so the
-- damaging partial state — an active preview whose one-time credential is already gone and which
-- has no delivery lifecycle at all — cannot occur. The recipient is checked BEFORE generation so
-- the ordinary "no authoritative contact" case never burns a preview credential.
--
-- The raw token is never passed in, derived here, or returned: only its SHA-256 hash reaches the
-- database, exactly as ordinary preview generation already works.
CREATE OR REPLACE FUNCTION public.generate_participant_preview_with_notification(
  p_public_id text,
  p_admin_id uuid,
  p_token_hash text,
  p_expires_in_seconds integer,
  p_private_bucket text,
  p_is_correction_reissue boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_project_id uuid;
  v_project_title text;
  v_recipient text;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_generated jsonb;
  v_reserved jsonb;
BEGIN
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100
     OR v_public_id !~ '^[A-Za-z0-9_-]+$'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  -- The title is returned so the caller can compose the participant-facing message without a second
  -- round trip and without ever reading the preview snapshot back out of the database.
  SELECT p.id,
         COALESCE(p.title, ''),
         pg_catalog.lower(pg_catalog.btrim(COALESCE(p.participant_contact_email, '')))
    INTO v_project_id, v_project_title, v_recipient
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  IF v_recipient = '' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PARTICIPANT_EMAIL_MISSING');
  END IF;

  IF pg_catalog.length(v_recipient) > 254
     OR v_recipient ~ '[[:cntrl:]]'
     OR pg_catalog.regexp_match(
          v_recipient, '^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$'
        ) IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PARTICIPANT_EMAIL_INVALID');
  END IF;

  -- Ordinary generation, unchanged: identical eligibility, authorization, single-active-preview and
  -- correction-reissue semantics as Generate Without Email.
  v_generated := public.generate_participant_preview(
    v_public_id, p_admin_id, p_token_hash, p_expires_in_seconds, p_private_bucket,
    COALESCE(p_is_correction_reissue, false)
  );

  IF v_generated->>'resultCode' IS DISTINCT FROM 'SUCCESS' THEN
    RETURN v_generated;
  END IF;

  v_reserved := public.reserve_participant_preview_notification(
    (v_generated->>'previewId')::uuid, p_admin_id, 'initial'
  );

  -- For a preview created moments ago in this very transaction every observer outcome is
  -- unreachable, so anything other than RESERVED means an invariant was violated. Raising rolls the
  -- new preview back rather than leaving it stranded without a delivery lifecycle.
  IF v_reserved->>'resultCode' IS DISTINCT FROM 'RESERVED' THEN
    RAISE EXCEPTION 'PARTICIPANT_PREVIEW_NOTIFICATION_RESERVATION_FAILED';
  END IF;

  -- Timestamps are re-read from the row just created rather than passed through from ordinary
  -- generation, whose legacy `to_jsonb(...)::text` encoding wraps them in literal quote characters.
  -- Generate + Send composes a participant-facing expiry from this value, so it must be a directly
  -- parseable timestamp. Ordinary Generate Without Email keeps its existing encoding untouched.
  SELECT pp.created_at, pp.expires_at
    INTO v_created_at, v_expires_at
    FROM public.participant_previews pp
   WHERE pp.id = (v_generated->>'previewId')::uuid;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'previewId', v_generated->>'previewId',
    'publicId', v_generated->>'publicId',
    'createdAt', pg_catalog.to_jsonb(v_created_at),
    'expiresAt', pg_catalog.to_jsonb(v_expires_at),
    'projectTitle', v_project_title,
    'notificationId', v_reserved->>'notificationId',
    'notificationKind', v_reserved->>'notificationKind',
    'executionToken', v_reserved->>'executionToken',
    'recipient', v_reserved->>'recipient',
    'notificationStatus', v_reserved->>'status',
    'requestedAt', v_reserved->>'requestedAt'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generate_participant_preview_with_notification(
  text, uuid, text, integer, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_participant_preview_with_notification(
  text, uuid, text, integer, text, boolean
) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Durable transport-started boundary
-- ---------------------------------------------------------------------------------------------
-- Called immediately before the application crosses into SMTP, and never after. Eligibility of the
-- exact preview is rechecked here so a preview revoked, expired, superseded or confirmed between
-- reservation and transport results in zero email. If the process dies after this commits, the row
-- truthfully reads transport_started and reconciles to delivery_unknown — never to "unsent".
CREATE OR REPLACE FUNCTION public.begin_participant_preview_notification_transport(
  p_notification_id uuid,
  p_execution_token uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.participant_preview_notifications%ROWTYPE;
  v_preview RECORD;
BEGIN
  IF p_notification_id IS NULL OR p_execution_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_row FROM public.participant_preview_notifications
   WHERE id = p_notification_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOTIFICATION_NOT_FOUND');
  END IF;

  IF v_row.execution_token_hash IS DISTINCT FROM pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_execution_token::text, 'UTF8'), 'sha256'), 'hex'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_TOKEN_MISMATCH');
  END IF;

  IF v_row.lease_expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_LEASE_EXPIRED');
  END IF;

  IF v_row.status <> 'reserved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE', 'status', v_row.status);
  END IF;

  SELECT pp.id, pp.project_id, pp.status, pp.expires_at
    INTO v_preview
    FROM public.participant_previews pp
   WHERE pp.id = v_row.participant_preview_id
     FOR UPDATE;

  IF NOT FOUND
     OR v_preview.project_id IS DISTINCT FROM v_row.project_id
     OR v_preview.status <> 'active'
     OR v_preview.expires_at <= pg_catalog.now()
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_NOT_ELIGIBLE');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.participant_preview_confirmations c
     WHERE c.participant_preview_id = v_preview.id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_CONFIRMED');
  END IF;

  UPDATE public.participant_preview_notifications
     SET status = 'transport_started',
         transport_started_at = pg_catalog.now(),
         updated_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now() + interval '2 minutes'
   WHERE id = p_notification_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'TRANSPORT_AUTHORIZED',
    'notificationId', v_row.id::text,
    'recipient', v_row.recipient_email_snapshot,
    'status', 'transport_started'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_participant_preview_notification_transport(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_participant_preview_notification_transport(uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Bounded finalization
-- ---------------------------------------------------------------------------------------------
-- 'sent' and 'delivery_unknown' require that transport was durably entered first, so neither can be
-- claimed for a lifecycle that never crossed the boundary. 'failed' is reachable from 'reserved'
-- (transport provably never started) and from 'transport_started' (the provider reliably rejected
-- the message). Terminal states are immutable, which is what fences a stale owner: once a
-- reconciliation or another finalization has settled the row, a late arrival can only observe it.
CREATE OR REPLACE FUNCTION public.finalize_participant_preview_notification(
  p_notification_id uuid,
  p_execution_token uuid,
  p_outcome text,
  p_transport_reference text,
  p_failure_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.participant_preview_notifications%ROWTYPE;
  v_outcome text := pg_catalog.btrim(pg_catalog.lower(COALESCE(p_outcome, '')));
  v_reference text := pg_catalog.btrim(COALESCE(p_transport_reference, ''));
  v_failure text := pg_catalog.btrim(pg_catalog.upper(COALESCE(p_failure_code, '')));
  v_now timestamptz;
BEGIN
  IF p_notification_id IS NULL
     OR p_execution_token IS NULL
     OR v_outcome NOT IN ('sent', 'failed', 'delivery_unknown')
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF v_reference = '' THEN
    v_reference := NULL;
  ELSIF pg_catalog.length(v_reference) > 200 OR v_reference !~ '^[!-~]+$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF v_failure = '' THEN
    v_failure := NULL;
  ELSIF pg_catalog.regexp_match(v_failure, '^[A-Z][A-Z0-9_]{0,63}$') IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF v_outcome = 'failed' AND v_failure IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_row FROM public.participant_preview_notifications
   WHERE id = p_notification_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOTIFICATION_NOT_FOUND');
  END IF;

  IF v_row.execution_token_hash IS DISTINCT FROM pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_execution_token::text, 'UTF8'), 'sha256'), 'hex'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_TOKEN_MISMATCH');
  END IF;

  -- Terminal states are immutable and are reported before the lease is consulted, so an owner whose
  -- own outcome was already settled learns the settled truth instead of a misleading lease error.
  IF v_row.status IN ('sent', 'failed', 'delivery_unknown') THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_FINALIZED', 'status', v_row.status, 'failureCode', v_row.failure_code
    );
  END IF;

  IF v_row.lease_expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_LEASE_EXPIRED');
  END IF;

  IF (v_outcome IN ('sent', 'delivery_unknown') AND v_row.status <> 'transport_started')
     OR (v_outcome = 'failed' AND v_row.status NOT IN ('reserved', 'transport_started'))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE', 'status', v_row.status);
  END IF;

  v_now := pg_catalog.now();

  UPDATE public.participant_preview_notifications
     SET status = v_outcome,
         sent_at = CASE WHEN v_outcome = 'sent' THEN v_now ELSE NULL END,
         finalized_at = v_now,
         transport_reference = CASE WHEN v_outcome = 'failed' THEN NULL ELSE v_reference END,
         failure_code = CASE WHEN v_outcome = 'sent' THEN NULL ELSE v_failure END,
         updated_at = v_now,
         lease_expires_at = v_now
   WHERE id = p_notification_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'FINALIZED',
    'status', v_outcome,
    'sentAt', CASE WHEN v_outcome = 'sent' THEN pg_catalog.to_jsonb(v_now) ELSE NULL END,
    'failureCode', CASE WHEN v_outcome = 'sent' THEN NULL ELSE v_failure END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_participant_preview_notification(
  uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_participant_preview_notification(
  uuid, uuid, text, text, text
) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. Observer reconciliation for abandoned executions
-- ---------------------------------------------------------------------------------------------
-- Deliberately takes no execution token: it is the recovery path for a lifecycle whose owner died,
-- and it can only settle a row whose lease has already lapsed. It never resends and never invents a
-- success. A lapsed 'reserved' row is durable proof that transport never began, so it becomes
-- failed/TRANSPORT_NOT_STARTED; a lapsed 'transport_started' row may or may not have reached the
-- provider, so it becomes delivery_unknown. Neither result is retryable-unsent — the raw credential
-- required to retry stopped existing when the owning request ended.
CREATE OR REPLACE FUNCTION public.reconcile_participant_preview_notification(
  p_notification_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.participant_preview_notifications%ROWTYPE;
  v_now timestamptz;
  v_status text;
BEGIN
  IF p_notification_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_row FROM public.participant_preview_notifications
   WHERE id = p_notification_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOTIFICATION_NOT_FOUND');
  END IF;

  IF v_row.status IN ('sent', 'failed', 'delivery_unknown') THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'NO_CHANGE', 'status', v_row.status, 'failureCode', v_row.failure_code
    );
  END IF;

  IF v_row.lease_expires_at > pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'IN_PROGRESS', 'status', v_row.status);
  END IF;

  v_now := pg_catalog.now();
  v_status := CASE WHEN v_row.status = 'reserved' THEN 'failed' ELSE 'delivery_unknown' END;

  UPDATE public.participant_preview_notifications
     SET status = v_status,
         finalized_at = v_now,
         failure_code = CASE WHEN v_status = 'failed' THEN 'TRANSPORT_NOT_STARTED' ELSE NULL END,
         updated_at = v_now,
         lease_expires_at = v_now
   WHERE id = p_notification_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RECONCILED',
    'status', v_status,
    'failureCode', CASE WHEN v_status = 'failed' THEN 'TRANSPORT_NOT_STARTED' ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_participant_preview_notification(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_participant_preview_notification(uuid)
  TO service_role;

COMMIT;
