-- Migration: 20260811130000_participant_preview_correction_resolution.sql
-- Description: Controlled administrative resolution of participant correction requests and
-- controlled preview reissue for approved projects.
--
-- Lifecycle: open -> in_progress -> resolved
-- Start resolution: revokes active Preview A (if still active), moves project from approved to
-- changes_requested, creates audit record, marks correction in_progress with start actor/time.
-- Reissue preview: allowed when correction is in_progress and project is approved again;
-- creates new Preview B, marks correction resolved with resolution actor/time and replacement_preview_id.
-- Enforces that ordinary preview generation is blocked while an unresolved open correction exists.

BEGIN;

-- 1. Extend participant_preview_correction_requests table to support in_progress and resolved lifecycle.
ALTER TABLE public.participant_preview_correction_requests
  DROP CONSTRAINT IF EXISTS check_participant_preview_correction_request_status;

ALTER TABLE public.participant_preview_correction_requests
  ADD COLUMN IF NOT EXISTS resolution_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_started_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replacement_preview_id UUID REFERENCES public.participant_previews(id) ON DELETE SET NULL;

ALTER TABLE public.participant_preview_correction_requests
  ADD CONSTRAINT check_participant_preview_correction_request_status
    CHECK (status IN ('open', 'in_progress', 'resolved'));

-- Lifecycle consistency constraints:
-- open: no start/resolved metadata
-- in_progress: start metadata populated, resolved fields null
-- resolved: start metadata populated, resolved metadata populated, replacement_preview_id populated
ALTER TABLE public.participant_preview_correction_requests
  ADD CONSTRAINT check_participant_preview_correction_resolution_consistency CHECK (
    (status = 'open' AND resolution_started_at IS NULL AND resolution_started_by IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND replacement_preview_id IS NULL) OR
    (status = 'in_progress' AND resolution_started_at IS NOT NULL AND resolution_started_by IS NOT NULL AND resolved_at IS NULL AND resolved_by IS NULL AND replacement_preview_id IS NULL) OR
    (status = 'resolved' AND resolution_started_at IS NOT NULL AND resolution_started_by IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND replacement_preview_id IS NOT NULL)
  );

-- 2. Update generate_participant_preview to block ordinary preview generation if an open correction exists.
--    Also support controlled reissue for an in_progress correction when p_is_correction_reissue = true.
CREATE OR REPLACE FUNCTION public.generate_participant_preview(
  p_public_id text,
  p_admin_id uuid,
  p_token_hash text,
  p_expires_in_seconds integer,
  p_private_bucket text,
  p_is_correction_reissue boolean
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
  v_project_id uuid;
  v_status text;
  v_existing_active_count integer;
  v_open_correction_count integer;
  v_in_progress_correction RECORD;
  v_expires_in integer;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_preview_id uuid;
  v_snapshot jsonb;
  v_media_snapshot jsonb;
  v_has_edit boolean;
  v_has_review boolean;
BEGIN
  -- 1. Input validation
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_TOKEN_HASH');
  END IF;

  IF p_private_bucket IS NULL OR pg_catalog.btrim(p_private_bucket) = '' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PRIVATE_BUCKET');
  END IF;
  v_private_bucket := pg_catalog.btrim(p_private_bucket);

  v_expires_in := COALESCE(p_expires_in_seconds, 604800);
  IF v_expires_in < 3600 OR v_expires_in > 2592000 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_EXPIRY');
  END IF;

  -- 2. Advisory Lock Serialization
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization check
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  v_has_edit := ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles));
  v_has_review := ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles));

  IF COALESCE(p_is_correction_reissue, false) THEN
    -- Corrected reissue requires combined authority (projects.edit AND projects.review)
    IF NOT (v_has_edit AND v_has_review) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
    END IF;
  ELSE
    -- Ordinary generation requires review authority
    IF NOT v_has_review THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
    END IF;
  END IF;

  -- 4. Resolve and lock project
  SELECT p.id, p.status
    INTO v_project_id, v_status
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  IF v_status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PROJECT_STATE', 'status', v_status);
  END IF;

  -- 5. Active preview check
  SELECT pg_catalog.count(*)
    INTO v_existing_active_count
    FROM public.participant_previews
   WHERE project_id = v_project_id
     AND status = 'active';

  IF v_existing_active_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVE_PREVIEW_EXISTS');
  END IF;

  -- 6. Correction workflow enforcement
  IF COALESCE(p_is_correction_reissue, false) THEN
    -- Must have exactly one in_progress correction request
    SELECT pg_catalog.count(*)
      INTO v_open_correction_count
      FROM public.participant_preview_correction_requests r
      JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
     WHERE pp.project_id = v_project_id
       AND r.status = 'in_progress';

    IF v_open_correction_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'NO_CORRECTION_IN_PROGRESS');
    ELSIF v_open_correction_count > 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'AMBIGUOUS_CORRECTION_REQUEST');
    END IF;

    SELECT r.id
      INTO v_in_progress_correction
      FROM public.participant_preview_correction_requests r
      JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
     WHERE pp.project_id = v_project_id
       AND r.status = 'in_progress'
       FOR UPDATE OF r;
  ELSE
    -- Ordinary generation: blocked if an open or in_progress correction exists
    SELECT pg_catalog.count(*)
      INTO v_open_correction_count
      FROM public.participant_preview_correction_requests r
      JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
     WHERE pp.project_id = v_project_id
       AND r.status IN ('open', 'in_progress');

    IF v_open_correction_count > 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'CORRECTION_RESOLUTION_REQUIRED');
    END IF;
  END IF;

  -- 7. Snapshot construction
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
    INTO v_snapshot
    FROM public.projects p
   WHERE p.id = v_project_id;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'mediaAssetId', ma.id,
      'assetType', ma.asset_type,
      'fileName', ma.file_name,
      'storageBucket', ma.storage_bucket,
      'storagePath', ma.storage_path,
      'mimeType', ma.mime_type
    )), '[]'::jsonb)
    INTO v_media_snapshot
    FROM public.media_assets ma
   WHERE ma.project_id = v_project_id
     AND ma.storage_bucket = v_private_bucket
     AND ma.is_public_approved = false
     AND ma.public_url IS NULL;

  v_now := pg_catalog.now();
  v_expires_at := v_now + pg_catalog.make_interval(secs => v_expires_in);

  BEGIN
    INSERT INTO public.participant_previews (
      project_id, token_hash, snapshot, media_snapshot, status, created_by, created_at, expires_at
    ) VALUES (
      v_project_id, p_token_hash, v_snapshot, v_media_snapshot, 'active', p_admin_id, v_now, v_expires_at
    ) RETURNING id INTO v_preview_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVE_PREVIEW_EXISTS');
  END;

  -- 8. If this was a correction reissue, complete the resolution transactionally
  IF COALESCE(p_is_correction_reissue, false) AND v_in_progress_correction.id IS NOT NULL THEN
    UPDATE public.participant_preview_correction_requests
       SET status = 'resolved',
           resolved_at = v_now,
           resolved_by = p_admin_id,
           replacement_preview_id = v_preview_id
     WHERE id = v_in_progress_correction.id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'previewId', v_preview_id,
    'publicId', v_public_id,
    'createdAt', pg_catalog.to_jsonb(v_now)::text,
    'expiresAt', pg_catalog.to_jsonb(v_expires_at)::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text, boolean) TO service_role;

-- Backward-compatibility wrapper for legacy 5-argument callers.
-- Always passes p_is_correction_reissue = false so legacy calls receive full correction-resolution gating.
CREATE OR REPLACE FUNCTION public.generate_participant_preview(
  p_public_id text,
  p_admin_id uuid,
  p_token_hash text,
  p_expires_in_seconds integer,
  p_private_bucket text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.generate_participant_preview(
    p_public_id,
    p_admin_id,
    p_token_hash,
    p_expires_in_seconds,
    p_private_bucket,
    false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) TO service_role;

-- 3. Atomic RPC to start participant preview correction resolution
CREATE OR REPLACE FUNCTION public.start_participant_preview_correction_resolution(
  p_public_id text,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_roles text[];
  v_has_edit boolean;
  v_has_review boolean;
  v_project_id uuid;
  v_project_status text;
  v_in_progress_count integer;
  v_open_request_count integer;
  v_target_request RECORD;
  v_active_preview RECORD;
  v_now timestamptz;
  v_audit_id uuid;
BEGIN
  -- 1. Input validation
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- 2. Advisory Lock
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization: require BOTH projects.edit (admin or editor) AND projects.review (admin or reviewer)
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  v_has_edit := ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles));
  v_has_review := ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles));

  IF NOT (v_has_edit AND v_has_review) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- 4. Lock project
  SELECT p.id, p.status
    INTO v_project_id, v_project_status
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  -- Check if resolution is already in_progress for this project
  SELECT pg_catalog.count(*)
    INTO v_in_progress_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project_id
     AND r.status = 'in_progress';

  IF v_in_progress_count > 1 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AMBIGUOUS_CORRECTION_REQUEST');
  ELSIF v_in_progress_count = 1 THEN
    SELECT r.id, r.resolution_started_at
      INTO v_target_request
      FROM public.participant_preview_correction_requests r
      JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
     WHERE pp.project_id = v_project_id
       AND r.status = 'in_progress';

    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_IN_PROGRESS',
      'correctionRequestId', v_target_request.id,
      'resolutionStartedAt', pg_catalog.to_jsonb(v_target_request.resolution_started_at)::text
    );
  END IF;

  -- Require project state to be approved to start resolution
  IF v_project_status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PROJECT_STATE', 'status', v_project_status);
  END IF;

  -- 5. Resolve the unresolved correction request server-side
  SELECT pg_catalog.count(*)
    INTO v_open_request_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project_id
     AND r.status = 'open';

  IF v_open_request_count = 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NO_OPEN_CORRECTION');
  ELSIF v_open_request_count > 1 THEN
    -- Fail closed on ambiguity
    RETURN pg_catalog.jsonb_build_object('resultCode', 'AMBIGUOUS_CORRECTION_REQUEST');
  END IF;

  SELECT r.id, r.participant_preview_id
    INTO v_target_request
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project_id
     AND r.status = 'open'
     FOR UPDATE OF r;

  v_now := pg_catalog.now();

  -- 6. Check active preview state against target_preview_id
  SELECT pp.id
    INTO v_active_preview
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project_id
     AND pp.status = 'active'
     FOR UPDATE;

  IF v_active_preview.id IS NOT NULL THEN
    IF v_active_preview.id <> v_target_request.participant_preview_id THEN
      -- An active preview exists that is NOT Preview A (the one with open correction request).
      -- Fail closed to prevent silently revoking the wrong active preview.
      RETURN pg_catalog.jsonb_build_object('resultCode', 'CONFLICTING_ACTIVE_PREVIEW');
    END IF;

    UPDATE public.participant_previews
       SET status = 'revoked',
           revoked_at = v_now,
           revoked_by = p_admin_id
     WHERE id = v_active_preview.id;
  END IF;

  -- 7. Transition project status: approved -> changes_requested
  UPDATE public.projects
     SET status = 'changes_requested'
   WHERE id = v_project_id;

  -- 8. Create approval/audit record
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
    'request_changes',
    'approved',
    'changes_requested',
    'Resolution started for participant correction request'
  ) RETURNING id INTO v_audit_id;

  -- 9. Mark correction request in_progress
  UPDATE public.participant_preview_correction_requests
     SET status = 'in_progress',
         resolution_started_at = v_now,
         resolution_started_by = p_admin_id
   WHERE id = v_target_request.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'correctionRequestId', v_target_request.id,
    'resolutionStartedAt', pg_catalog.to_jsonb(v_now)::text,
    'auditRecordId', v_audit_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_participant_preview_correction_resolution(text, uuid) TO service_role;

COMMIT;
