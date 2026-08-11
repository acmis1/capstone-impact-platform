-- Migration 0017: Service-Role-Only Publication Readiness RPC Function
--
-- Introduces get_project_publication_readiness to evaluate authoritative publication eligibility.
-- A project is publication-ready if and only if ALL of the following hold:
--   1. Authoritative project status is 'approved' (deleted_at IS NULL).
--   2. Exactly one active participant preview exists (status = 'active').
--   3. That exact active preview has a participant confirmation record.
--   4. That exact active preview has ZERO correction requests.
--   5. ZERO unresolved (open or in_progress) correction requests exist across the project's history.
--   6. Re-derived canonical participant-facing project snapshot matches stored preview snapshot.
--   7. Re-derived canonical private media snapshot matches stored preview media_snapshot (order-independent comparison).
--
-- Security:
--   - SECURITY DEFINER with fixed search_path = ''
--   - Strict input validation and defense-in-depth authorization checks (requires combined projects.edit and projects.review)
--   - EXECUTE revoked from PUBLIC, anon, and authenticated; granted ONLY to service_role

BEGIN;

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
  v_has_edit boolean;
  v_has_review boolean;
  v_project RECORD;
  v_active_preview RECORD;
  v_confirmation RECORD;
  v_active_corr_count integer;
  v_unresolved_corr_count integer;
  v_current_snapshot jsonb;
  v_current_media_snapshot jsonb;
  v_stored_media_snapshot jsonb;
  v_canonical_current_media jsonb;
  v_canonical_stored_media jsonb;
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

  -- 3. Authorization Check (require BOTH projects.edit AND projects.review)
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

  v_has_edit := ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles));
  v_has_review := ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles));

  IF NOT (v_has_edit AND v_has_review) THEN
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

  IF v_project.status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PROJECT_STATE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project status must be approved to evaluate publication readiness'])
    );
  END IF;

  -- 5. Lock and inspect active participant preview
  SELECT pp.*
    INTO v_active_preview
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project.id
     AND pp.status = 'active'
     FOR UPDATE;

  IF v_active_preview.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'NO_ACTIVE_PREVIEW',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant preview required'])
    );
  END IF;

  -- 6. Check confirmation for active preview
  SELECT c.*
    INTO v_confirmation
    FROM public.participant_preview_confirmations c
   WHERE c.participant_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NULL THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Waiting for participant confirmation');
  END IF;

  -- 7. Check for correction requests on active preview
  SELECT pg_catalog.count(*)
    INTO v_active_corr_count
    FROM public.participant_preview_correction_requests r
   WHERE r.participant_preview_id = v_active_preview.id;

  IF v_active_corr_count > 0 THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Active preview has an open correction request');
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

  -- If preview is unconfirmed or corrections are unresolved, we can early exit with primary blocker code
  IF v_confirmation.id IS NULL THEN
    IF v_unresolved_corr_count > 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'ready', false,
        'resultCode', 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION',
        'blockers', pg_catalog.to_jsonb(v_blockers),
        'confirmedPreviewId', null,
        'confirmedAt', null
      );
    ELSE
      RETURN pg_catalog.jsonb_build_object(
        'ready', false,
        'resultCode', 'PREVIEW_NOT_CONFIRMED',
        'blockers', pg_catalog.to_jsonb(v_blockers),
        'confirmedPreviewId', null,
        'confirmedAt', null
      );
    END IF;
  END IF;

  IF v_unresolved_corr_count > 0 OR v_active_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'CORRECTION_UNRESOLVED',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', pg_catalog.to_jsonb(v_confirmation.confirmed_at)::text
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

  -- Compare project snapshot against stored active preview snapshot
  IF v_current_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project information changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', pg_catalog.to_jsonb(v_confirmation.confirmed_at)::text
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
      'confirmedAt', pg_catalog.to_jsonb(v_confirmation.confirmed_at)::text
    );
  END IF;

  -- 11. All conditions satisfied -> READY
  RETURN pg_catalog.jsonb_build_object(
    'ready', true,
    'resultCode', 'READY',
    'blockers', '[]'::jsonb,
    'confirmedPreviewId', v_active_preview.id,
    'confirmedAt', pg_catalog.to_jsonb(v_confirmation.confirmed_at)::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) TO service_role;

COMMIT;
