-- Migration 0050 -- controlled project links become participant-confirmed evidence.
--
-- Migration 0049 made the project-details.xlsx import populate projects.video_url,
-- projects.demo_url and projects.repository_url for the first time in the normal workflow.
-- Those three values are conditionally emitted into the public feed and rendered on the
-- public showcase, but they were not part of the immutable participant snapshot, so a
-- participant could confirm evidence A while publication carried additional content B.
--
-- This migration closes that gap by projecting the three controlled links into the single
-- canonical participant-facing project snapshot, at all three authorities that build it:
--
--   1. public.generate_participant_preview          -- issuance (immutable snapshot capture)
--   2. public.get_project_publication_readiness     -- normal publication staleness gate
--   3. public.get_project_reconciliation_readiness  -- deployment reconciliation staleness gate
--
-- Each function body is otherwise reproduced exactly as it stands on current main, from its
-- latest authoritative definition (20260824070000, 20260824080000 and 20260824183000
-- respectively). SECURITY DEFINER, SET search_path = '' and every EXECUTE grant/revoke
-- contract are preserved unchanged. No earlier migration is edited, and no stored snapshot
-- is ever rewritten or backfilled.

BEGIN;

-------------------------------------------------------------------------------
-- 1. Participant-preview issuance: capture the controlled links as immutable
--    evidence. An absent value is captured as JSON null so every newly issued
--    snapshot has one deterministic shape.
-------------------------------------------------------------------------------

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
  v_in_progress_correction_id uuid;
  v_expires_in integer;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_preview_id uuid;
  v_snapshot jsonb;
  v_media_snapshot jsonb;
  v_media_total_count integer;
  v_media_valid_count integer;
  v_poster_image_count integer;
  v_poster_pdf_count integer;
  v_snapshot_total_count integer;
  v_snapshot_position_count integer;
  v_has_edit boolean;
  v_has_review boolean;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. Input validation
  ---------------------------------------------------------------------------

  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_NOT_FOUND'
    );
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);

  IF v_public_id = ''
     OR pg_catalog.length(v_public_id) > 100
     OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_SELECTION'
    );
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PREVIEW_PERMISSION_DENIED'
    );
  END IF;

  IF p_token_hash IS NULL
     OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_TOKEN_HASH'
    );
  END IF;

  IF p_private_bucket IS NULL
     OR pg_catalog.btrim(p_private_bucket) = '' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_PRIVATE_BUCKET'
    );
  END IF;

  v_private_bucket := pg_catalog.btrim(p_private_bucket);

  v_expires_in := COALESCE(
    p_expires_in_seconds,
    604800
  );

  IF v_expires_in < 3600
     OR v_expires_in > 2592000 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_EXPIRY'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 2. Serialize participant-preview operations for this project.
  ---------------------------------------------------------------------------

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      'participant_preview:' || v_public_id
    )
  );

  ---------------------------------------------------------------------------
  -- 3. Authorization
  ---------------------------------------------------------------------------

  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL
     OR pg_catalog.cardinality(v_roles) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PREVIEW_PERMISSION_DENIED'
    );
  END IF;

  v_has_edit := (
    'admin' = ANY(v_roles)
    OR 'editor' = ANY(v_roles)
  );

  v_has_review := (
    'admin' = ANY(v_roles)
    OR 'reviewer' = ANY(v_roles)
  );

  IF COALESCE(p_is_correction_reissue, false) THEN

    -- A correction reissue requires both edit and review authority.
    IF NOT (v_has_edit AND v_has_review) THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'PREVIEW_PERMISSION_DENIED'
      );
    END IF;

  ELSE

    -- Ordinary preview generation requires review authority.
    IF NOT v_has_review THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'PREVIEW_PERMISSION_DENIED'
      );
    END IF;

  END IF;

  ---------------------------------------------------------------------------
  -- 4. Resolve and lock the project.
  ---------------------------------------------------------------------------

  SELECT
    p.id,
    p.status
  INTO
    v_project_id,
    v_status
  FROM public.projects p
  WHERE p.public_id = v_public_id
    AND p.deleted_at IS NULL
  FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_NOT_FOUND'
    );
  END IF;

  IF v_status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'INVALID_PROJECT_STATE',
      'status',
      v_status
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 5. Only one active participant preview per project.
  ---------------------------------------------------------------------------

  SELECT pg_catalog.count(*)
    INTO v_existing_active_count
    FROM public.participant_previews
   WHERE project_id = v_project_id
     AND status = 'active';

  IF v_existing_active_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'ACTIVE_PREVIEW_EXISTS'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 6. Correction workflow enforcement.
  ---------------------------------------------------------------------------

  SELECT pg_catalog.count(*)
    INTO v_open_correction_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp
      ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project_id
     AND r.status IN ('open', 'in_progress');

  IF COALESCE(p_is_correction_reissue, false) THEN

    IF v_open_correction_count > 1 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'AMBIGUOUS_CORRECTION_REQUEST'
      );

    ELSIF v_open_correction_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'NO_CORRECTION_IN_PROGRESS'
      );
    END IF;

    SELECT r.id
      INTO v_in_progress_correction_id
      FROM public.participant_preview_correction_requests r
      JOIN public.participant_previews pp
        ON pp.id = r.participant_preview_id
     WHERE pp.project_id = v_project_id
       AND r.status = 'in_progress'
     FOR UPDATE OF r;

    IF v_in_progress_correction_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'NO_CORRECTION_IN_PROGRESS'
      );
    END IF;

  ELSE

    IF v_open_correction_count > 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'CORRECTION_RESOLUTION_REQUIRED'
      );
    END IF;

  END IF;

  ---------------------------------------------------------------------------
  -- 6b. Task 3 authoritative media state gate.
  --
  -- The immutable preview is the participant's evidence of exactly which
  -- gallery they were asked to confirm, so it must be derived from the
  -- COMPLETE validated media set -- never from rows pre-filtered to those
  -- that already look private. Filtering first would let an anomalous row
  -- (wrong bucket, unexpectedly public, malformed identity, duplicate or
  -- out-of-range position) be silently omitted from immutable evidence
  -- instead of blocking issuance. Every project media row is therefore
  -- locked and validated here, and any contradiction fails closed.
  ---------------------------------------------------------------------------

  PERFORM 1
     FROM public.media_assets ma
    WHERE ma.project_id = v_project_id
      FOR UPDATE;

  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE ma.asset_type IN ('poster_image', 'poster_pdf', 'snapshot_image')
        AND ma.storage_bucket = v_private_bucket
        AND ma.is_public_approved = false
        AND ma.public_url IS NULL
        AND ma.public_storage_bucket IS NULL
        AND ma.public_storage_path IS NULL
        AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
        AND ma.storage_path <> ''
        AND pg_catalog.strpos(ma.storage_path, '..') = 0
        AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
        AND ma.file_name = pg_catalog.btrim(ma.file_name)
        AND ma.file_name <> ''
        AND pg_catalog.strpos(ma.file_name, '..') = 0
        AND pg_catalog.strpos(ma.file_name, '/') = 0
        AND pg_catalog.strpos(ma.file_name, E'\\') = 0
        AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
        AND pg_catalog.left(
              ma.storage_path,
              pg_catalog.length('drafts/' || v_public_id || '/' || ma.asset_type || '/')
            ) = 'drafts/' || v_public_id || '/' || ma.asset_type || '/'
        AND ma.file_size_bytes IS NOT NULL
        AND ma.file_size_bytes >= 1
        AND (
          CASE ma.asset_type
            WHEN 'poster_pdf' THEN
              ma.mime_type = 'application/pdf'
              AND ma.file_size_bytes <= 20971520
              AND ma.gallery_position IS NULL
            WHEN 'poster_image' THEN
              ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
              AND ma.file_size_bytes <= 5242880
              AND ma.gallery_position IS NULL
            ELSE
              ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
              AND ma.file_size_bytes <= 5242880
              AND ma.gallery_position BETWEEN 1 AND 10
          END
        )
    ),
    pg_catalog.count(*) FILTER (WHERE ma.asset_type = 'poster_image'),
    pg_catalog.count(*) FILTER (WHERE ma.asset_type = 'poster_pdf'),
    pg_catalog.count(*) FILTER (WHERE ma.asset_type = 'snapshot_image'),
    pg_catalog.count(DISTINCT ma.gallery_position)
      FILTER (WHERE ma.asset_type = 'snapshot_image')
  INTO
    v_media_total_count,
    v_media_valid_count,
    v_poster_image_count,
    v_poster_pdf_count,
    v_snapshot_total_count,
    v_snapshot_position_count
  FROM public.media_assets ma
  WHERE ma.project_id = v_project_id;

  -- Poster assets are singletons; the gallery is bounded at 10 and every
  -- member must hold a distinct position. Position, not asset type, is
  -- snapshot identity, so a duplicate or absent position is a hard defect.
  IF v_media_valid_count <> v_media_total_count
     OR v_poster_image_count > 1
     OR v_poster_pdf_count > 1
     OR v_snapshot_total_count > 10
     OR v_snapshot_position_count <> v_snapshot_total_count THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'PROJECT_MEDIA_INVALID'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 6c. Task 3 multi-image accessibility gate.
  --
  -- Every snapshot in the now-validated gallery must carry usable
  -- authoritative alt text. No private-only prefilter here: the gate above
  -- already proved the complete set is private and well-formed.
  ---------------------------------------------------------------------------

  IF EXISTS (
    SELECT 1
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id
       AND ma.asset_type = 'snapshot_image'
       AND (
         pg_catalog.btrim(
           COALESCE(ma.alt_text_public, '')
         ) = ''
         OR pg_catalog.length(
           pg_catalog.btrim(ma.alt_text_public)
         ) > 2000
       )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode',
      'MEDIA_ACCESSIBILITY_REQUIRED'
    );
  END IF;

  ---------------------------------------------------------------------------
  -- 7. Immutable project snapshot.
  ---------------------------------------------------------------------------

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
      'teamMembers',
        pg_catalog.to_jsonb(
          COALESCE(p.team_members, '{}'::text[])
        ),
      'posterText', p.poster_text_public,
      'accessibilityText', p.accessibility_text_public,
      'videoUrl', p.video_url,
      'demoUrl', p.demo_url,
      'repositoryUrl', p.repository_url,
      'citations',
        pg_catalog.to_jsonb(
          COALESCE(p.citations, '{}'::text[])
        ),
      'externalLinks',
        COALESCE(
          p.external_links,
          '[]'::jsonb
        ),
      'disciplines',
        COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              d.name
              ORDER BY d.name
            )
              FROM public.project_disciplines pd
              JOIN public.disciplines d
                ON d.id = pd.discipline_id
             WHERE pd.project_id = p.id
          ),
          '[]'::jsonb
        ),
      'industryCategories',
        COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              ic.name
              ORDER BY ic.name
            )
              FROM public.project_industry_categories pic
              JOIN public.industry_categories ic
                ON ic.id = pic.industry_category_id
             WHERE pic.project_id = p.id
          ),
          '[]'::jsonb
        )
    )
    INTO v_snapshot
    FROM public.projects p
   WHERE p.id = v_project_id;

  ---------------------------------------------------------------------------
  -- Task 3 immutable media snapshot.
  --
  -- galleryPosition is structurally present for every media element:
  --
  --   poster_image  -> null
  --   poster_pdf    -> null
  --   snapshot_image -> authoritative gallery_position
  --
  -- Snapshot images are captured in numeric gallery order. The order becomes
  -- immutable evidence of exactly what the participant was asked to confirm.
  ---------------------------------------------------------------------------

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mediaAssetId',
          ma.id,

        'assetType',
          ma.asset_type,

        'galleryPosition',
          CASE
            WHEN ma.asset_type = 'snapshot_image'
              THEN ma.gallery_position
            ELSE NULL
          END,

        'fileName',
          ma.file_name,

        'storageBucket',
          ma.storage_bucket,

        'storagePath',
          ma.storage_path,

        'mimeType',
          ma.mime_type,

        'altText',
          ma.alt_text_public
      )
      ORDER BY
        CASE ma.asset_type
          WHEN 'poster_image' THEN 1
          WHEN 'poster_pdf' THEN 2
          WHEN 'snapshot_image' THEN 3
          ELSE 4
        END,

        CASE
          WHEN ma.asset_type = 'snapshot_image'
            THEN ma.gallery_position
          ELSE NULL
        END,

        ma.id
    ),
    '[]'::jsonb
  )
  INTO v_media_snapshot
  FROM public.media_assets ma
  -- No private-only prefilter: gate 6b already proved every row for this
  -- project is valid private staged media, so the evidence captured here is
  -- the complete expected set rather than whatever happened to conform.
  WHERE ma.project_id = v_project_id;

  ---------------------------------------------------------------------------
  -- Store immutable preview.
  ---------------------------------------------------------------------------

  v_now := pg_catalog.now();

  v_expires_at :=
    v_now
    + pg_catalog.make_interval(
        secs => v_expires_in
      );

  BEGIN

    INSERT INTO public.participant_previews (
      project_id,
      token_hash,
      snapshot,
      media_snapshot,
      status,
      created_by,
      created_at,
      expires_at
    )
    VALUES (
      v_project_id,
      p_token_hash,
      v_snapshot,
      v_media_snapshot,
      'active',
      p_admin_id,
      v_now,
      v_expires_at
    )
    RETURNING id
         INTO v_preview_id;

  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'resultCode',
        'ACTIVE_PREVIEW_EXISTS'
      );
  END;

  ---------------------------------------------------------------------------
  -- 8. Correction reissue resolution.
  ---------------------------------------------------------------------------

  IF COALESCE(p_is_correction_reissue, false)
     AND v_in_progress_correction_id IS NOT NULL THEN

    UPDATE public.participant_preview_correction_requests
       SET status = 'resolved',
           resolved_at = v_now,
           resolved_by = p_admin_id,
           replacement_preview_id = v_preview_id
     WHERE id = v_in_progress_correction_id;

  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode',
      'SUCCESS',

    'previewId',
      v_preview_id,

    'publicId',
      v_public_id,

    'createdAt',
      pg_catalog.to_jsonb(v_now)::text,

    'expiresAt',
      pg_catalog.to_jsonb(v_expires_at)::text
  );
END;
$$;

-------------------------------------------------------------------------------
-- Keep participant-preview generation service-role-only.
-------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
FROM anon;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
FROM authenticated;

GRANT EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text,
    boolean
  )
TO service_role;

-------------------------------------------------------------------------------
-- The existing 5-argument wrapper delegates to the 6-argument implementation.
-- Re-assert its privileges so the legacy callable path cannot bypass the new
-- gallery-aware implementation.
-------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
FROM anon;

REVOKE EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
FROM authenticated;

GRANT EXECUTE ON FUNCTION
  public.generate_participant_preview(
    text,
    uuid,
    text,
    integer,
    text
  )
TO service_role;

-------------------------------------------------------------------------------
-- 2. Normal publication readiness gate.
-------------------------------------------------------------------------------

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
  v_snapshot_total_count integer;
  v_snapshot_valid_count integer;
  v_snapshot_position_count integer;
  v_snapshot_missing_alt_count integer;
  v_snapshot_long_alt_count integer;
  v_current_snapshot jsonb;
  v_comparable_snapshot jsonb;
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

  -- 4c. Snapshot gallery accessibility and structural validity, evaluated against the CURRENT
  -- media rows for the same reason as 4b: a snapshot whose alt was already absent when the preview
  -- was issued would otherwise match its own stored snapshot and pass unnoticed. Every current
  -- gallery row is inspected -- never an arbitrary first row of a multi-row gallery -- and no
  -- private-only prefilter is applied, so a contradictory row fails closed here instead of being
  -- silently skipped by the filter that was meant to find it.
  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE ma.storage_bucket = v_private_bucket
        AND ma.is_public_approved = false
        AND ma.public_url IS NULL
        AND ma.public_storage_bucket IS NULL
        AND ma.public_storage_path IS NULL
        AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
        AND pg_catalog.strpos(ma.storage_path, '..') = 0
        AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
        AND ma.file_name = pg_catalog.btrim(ma.file_name)
        AND ma.file_name <> ''
        AND pg_catalog.strpos(ma.file_name, '..') = 0
        AND pg_catalog.strpos(ma.file_name, '/') = 0
        AND pg_catalog.strpos(ma.file_name, E'\\') = 0
        AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
        AND pg_catalog.left(
              ma.storage_path,
              pg_catalog.length('drafts/' || v_project.public_id || '/snapshot_image/')
            ) = 'drafts/' || v_project.public_id || '/snapshot_image/'
        AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
        AND ma.file_size_bytes BETWEEN 1 AND 5242880
        AND ma.gallery_position BETWEEN 1 AND 10
    ),
    pg_catalog.count(DISTINCT ma.gallery_position),
    pg_catalog.count(*) FILTER (
      WHERE pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.alt_text_public IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(ma.alt_text_public)) > 2000
    )
    INTO
      v_snapshot_total_count,
      v_snapshot_valid_count,
      v_snapshot_position_count,
      v_snapshot_missing_alt_count,
      v_snapshot_long_alt_count
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.asset_type = 'snapshot_image';

  -- A zero-snapshot gallery stays publishable. A populated one must be wholly
  -- valid: bounded at 10, every member privately staged and well-formed, and
  -- every member holding a distinct position. Position, not asset type, is
  -- snapshot identity.
  IF v_snapshot_total_count > 0 THEN
    IF v_snapshot_total_count > 10
       OR v_snapshot_valid_count <> v_snapshot_total_count
       OR v_snapshot_position_count <> v_snapshot_total_count THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot gallery media state is invalid'
      );
    END IF;

    IF v_snapshot_missing_alt_count > 0 THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot image alt text is missing'
      );
    END IF;

    IF v_snapshot_long_alt_count > 0 THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot image alt text exceeds the 2,000 character safety limit'
      );
    END IF;
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
      'videoUrl', p.video_url,
      'demoUrl', p.demo_url,
      'repositoryUrl', p.repository_url,
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
  -- Historical-snapshot compatibility for controlled project links.
  --
  -- Previews issued before controlled project links became participant evidence carry none
  -- of the three keys. Such a preview stays equivalent ONLY while the project still has no
  -- controlled link at all. Any populated controlled URL is public-eligible content the
  -- participant was never shown, so it invalidates the confirmation rather than being
  -- grandfathered. Stored snapshots are never rewritten or backfilled to reach this result.
  v_comparable_snapshot := v_current_snapshot;

  IF NOT (v_active_preview.snapshot ? 'videoUrl')
     AND NOT (v_active_preview.snapshot ? 'demoUrl')
     AND NOT (v_active_preview.snapshot ? 'repositoryUrl')
     AND v_current_snapshot->>'videoUrl' IS NULL
     AND v_current_snapshot->>'demoUrl' IS NULL
     AND v_current_snapshot->>'repositoryUrl' IS NULL
  THEN
    v_comparable_snapshot := v_comparable_snapshot - 'videoUrl' - 'demoUrl' - 'repositoryUrl';
  END IF;

  IF v_comparable_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project information changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 10. Re-derive the current canonical private media snapshot.
  --
  -- galleryPosition is now part of the immutable participant-confirmed evidence.
  -- This makes add/remove/replace/reorder operations visible to the stale-media
  -- comparison instead of treating gallery order as mutable display metadata.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mediaAssetId', ma.id,
        'assetType', ma.asset_type,
        'galleryPosition',
          CASE
            WHEN ma.asset_type = 'snapshot_image'
              THEN ma.gallery_position
            ELSE NULL
          END,
        'fileName', ma.file_name,
        'storageBucket', ma.storage_bucket,
        'storagePath', ma.storage_path,
        'mimeType', ma.mime_type,
        'altText', ma.alt_text_public
      )
      ORDER BY
        CASE ma.asset_type
          WHEN 'poster_image' THEN 1
          WHEN 'poster_pdf' THEN 2
          WHEN 'snapshot_image' THEN 3
          ELSE 4
        END,
        CASE
          WHEN ma.asset_type = 'snapshot_image'
            THEN ma.gallery_position
          ELSE NULL
        END,
        ma.id
    ),
    '[]'::jsonb
  )
  INTO v_current_media_snapshot
  FROM public.media_assets ma
  WHERE ma.project_id = v_project.id
    AND ma.storage_bucket = v_private_bucket
    AND ma.is_public_approved = false
    AND ma.public_url IS NULL;

  -- Canonicalization remains identity-based. Gallery order itself is carried
  -- explicitly by galleryPosition, so changing a snapshot's position changes
  -- the compared immutable object.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
  INTO v_canonical_current_media
  FROM pg_catalog.jsonb_array_elements(
    v_current_media_snapshot
  ) elem;

  v_stored_media_snapshot :=
    COALESCE(
      v_active_preview.media_snapshot,
      '[]'::jsonb
    );

  -- Every stored media element must use the current immutable contract.
  --
  -- snapshot_image:
  --   galleryPosition = integer 1..10
  --   altText         = usable string
  --
  -- other media:
  --   galleryPosition = JSON null
  --   altText         = JSON null
  SELECT pg_catalog.count(*)
    INTO v_invalid_media_element_count
    FROM pg_catalog.jsonb_array_elements(
      v_stored_media_snapshot
    ) elem
   WHERE
      pg_catalog.jsonb_typeof(elem) <> 'object'

      OR pg_catalog.jsonb_typeof(
           elem->'mediaAssetId'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'assetType'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'fileName'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'storageBucket'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'storagePath'
         ) <> 'string'

      OR pg_catalog.jsonb_typeof(
           elem->'mimeType'
         ) <> 'string'

      OR NOT (elem ? 'galleryPosition')

      OR NOT (elem ? 'altText')

      OR (
        elem->>'assetType' = 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(
            elem->'galleryPosition'
          ) <> 'number'

          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(
                elem->'galleryPosition'
              ) = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric
                <> pg_catalog.trunc(
                     (elem->>'galleryPosition')::numeric
                   )
              )
              ELSE false
            END
          )

          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(
                elem->'galleryPosition'
              ) = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric < 1
                OR
                (elem->>'galleryPosition')::numeric > 10
              )
              ELSE false
            END
          )

          OR pg_catalog.jsonb_typeof(
               elem->'altText'
             ) <> 'string'

          OR pg_catalog.btrim(
               COALESCE(
                 elem->>'altText',
                 ''
               )
             ) = ''

          OR pg_catalog.length(
               pg_catalog.btrim(
                 elem->>'altText'
               )
             ) > 2000
        )
      )

      OR (
        elem->>'assetType' <> 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(
            elem->'galleryPosition'
          ) <> 'null'

          OR pg_catalog.jsonb_typeof(
               elem->'altText'
             ) <> 'null'
        )
      );

  IF v_invalid_media_element_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready',
      false,
      'resultCode',
      'READINESS_UNAVAILABLE',
      'blockers',
      pg_catalog.to_jsonb(
        ARRAY[
          'Stored preview media state is malformed'
        ]
      )
    );
  END IF;

  -- Duplicate gallery positions are malformed immutable evidence.
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT
          elem->>'galleryPosition' AS gallery_position,
          pg_catalog.count(*) AS position_count
        FROM pg_catalog.jsonb_array_elements(
          v_stored_media_snapshot
        ) elem
        WHERE elem->>'assetType' = 'snapshot_image'
        GROUP BY elem->>'galleryPosition'
        HAVING pg_catalog.count(*) > 1
      ) duplicate_positions
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready',
      false,
      'resultCode',
      'READINESS_UNAVAILABLE',
      'blockers',
      pg_catalog.to_jsonb(
        ARRAY[
          'Stored preview media state is malformed'
        ]
      )
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
  INTO v_canonical_stored_media
  FROM pg_catalog.jsonb_array_elements(
    v_stored_media_snapshot
  ) elem;IF v_canonical_current_media IS DISTINCT FROM v_canonical_stored_media THEN
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

-------------------------------------------------------------------------------
-- 3. Deployment reconciliation readiness gate.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_project_reconciliation_readiness(
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
  v_snapshot_total_count integer;
  v_snapshot_valid_count integer;
  v_snapshot_position_count integer;
  v_snapshot_missing_alt_count integer;
  v_snapshot_long_alt_count integer;
  v_incoherent_mapping_count integer;
  v_unexpected_destination_count integer;
  v_invalid_media_element_count integer;
  v_current_snapshot jsonb;
  v_comparable_snapshot jsonb;
  v_current_media_snapshot jsonb;
  v_stored_media_snapshot jsonb;
  v_canonical_current_media jsonb;
  v_canonical_stored_media jsonb;
  v_accessibility_blockers text[];
  v_blockers text[];
BEGIN
  v_blockers := '{}'::text[];

  -- 1. Input validation, identical in strictness to the normal gate.
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

  -- 2. Same serialization key as the normal gate, so reconciliation and preview mutation cannot
  -- interleave for one project.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization.
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

  -- 4. Lock and inspect the authoritative project row.
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

  -- Contradictory persisted state first: a confirmed active preview that also carries a correction.
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

  SELECT pg_catalog.count(*)
    INTO v_unresolved_corr_count
    FROM public.participant_preview_correction_requests r
    JOIN public.participant_previews pp ON pp.id = r.participant_preview_id
   WHERE pp.project_id = v_project.id
     AND r.status IN ('open', 'in_progress');

  IF v_unresolved_corr_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'CORRECTION_UNRESOLVED',
      'blockers', pg_catalog.to_jsonb(ARRAY['Participant correction must be resolved']),
      'confirmedPreviewId', null,
      'confirmedAt', null
    );
  END IF;

  -- 5. Reconciliation targets a project that is ALREADY published. Any other status is refused
  -- here rather than by relaxing the normal approved-only gate.
  IF v_project.status <> 'published' THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'INVALID_PROJECT_STATE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project status must be published to evaluate deployment reconciliation readiness'])
    );
  END IF;

  -- 6. Accessible content, evaluated against the CURRENT project row.
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

  -- 7. Gallery structural validity against CURRENT snapshot rows.
  --
  -- The normal gate additionally requires each row to be UNPROMOTED (is_public_approved = false,
  -- public_url IS NULL, ...). A published project legitimately carries those publication mappings,
  -- so requiring their absence here would report expected publication state as participant-content
  -- drift. Instead the PRIVATE SOURCE identity is validated exactly as strictly as the normal gate
  -- validates it, and the public mapping is validated separately in step 8.
  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (
      WHERE ma.storage_bucket = v_private_bucket
        AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
        AND pg_catalog.strpos(ma.storage_path, '..') = 0
        AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
        AND ma.file_name = pg_catalog.btrim(ma.file_name)
        AND ma.file_name <> ''
        AND pg_catalog.strpos(ma.file_name, '..') = 0
        AND pg_catalog.strpos(ma.file_name, '/') = 0
        AND pg_catalog.strpos(ma.file_name, E'\\') = 0
        AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
        AND pg_catalog.left(
              ma.storage_path,
              pg_catalog.length('drafts/' || v_project.public_id || '/snapshot_image/')
            ) = 'drafts/' || v_project.public_id || '/snapshot_image/'
        AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
        AND ma.file_size_bytes BETWEEN 1 AND 5242880
        AND ma.gallery_position BETWEEN 1 AND 10
    ),
    pg_catalog.count(DISTINCT ma.gallery_position),
    pg_catalog.count(*) FILTER (
      WHERE pg_catalog.btrim(COALESCE(ma.alt_text_public, '')) = ''
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.alt_text_public IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(ma.alt_text_public)) > 2000
    )
    INTO
      v_snapshot_total_count,
      v_snapshot_valid_count,
      v_snapshot_position_count,
      v_snapshot_missing_alt_count,
      v_snapshot_long_alt_count
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.asset_type = 'snapshot_image';

  IF v_snapshot_total_count > 0 THEN
    IF v_snapshot_total_count > 10
       OR v_snapshot_valid_count <> v_snapshot_total_count
       OR v_snapshot_position_count <> v_snapshot_total_count THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot gallery media state is invalid'
      );
    END IF;

    IF v_snapshot_missing_alt_count > 0 THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot image alt text is missing'
      );
    END IF;

    IF v_snapshot_long_alt_count > 0 THEN
      v_accessibility_blockers := pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot image alt text exceeds the 2,000 character safety limit'
      );
    END IF;
  END IF;

  IF pg_catalog.cardinality(v_accessibility_blockers) > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED',
      'blockers', pg_catalog.to_jsonb(v_accessibility_blockers)
    );
  END IF;

  -- 8. Published media mapping must be coherent, and where present must name the deterministic
  -- destination for that exact asset. A half-written mapping, or one pointing somewhere other than
  -- published/<publicId>/<assetType>/<fileName>, is refused instead of being re-derived.
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE NOT (
        (
          ma.public_url IS NULL
          AND ma.public_storage_bucket IS NULL
          AND ma.public_storage_path IS NULL
          AND ma.is_public_approved = false
        )
        OR (
          ma.public_url IS NOT NULL
          AND ma.public_storage_bucket IS NOT NULL
          AND ma.public_storage_path IS NOT NULL
          AND ma.is_public_approved = true
        )
      )
    ),
    pg_catalog.count(*) FILTER (
      WHERE ma.public_storage_path IS NOT NULL
        AND ma.public_storage_path IS DISTINCT FROM
            'published/' || v_project.public_id || '/' || ma.asset_type || '/' || ma.file_name
    )
    INTO v_incoherent_mapping_count, v_unexpected_destination_count
    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.storage_bucket = v_private_bucket;

  IF v_incoherent_mapping_count > 0 OR v_unexpected_destination_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PUBLISHED_MEDIA_MAPPING_INVALID',
      'blockers', pg_catalog.to_jsonb(ARRAY['Published media mapping does not match its authoritative source asset'])
    );
  END IF;

  -- 9. Exactly one active participant preview, carrying a confirmation.
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

  SELECT c.*
    INTO v_confirmation
    FROM public.participant_preview_confirmations c
   WHERE c.participant_preview_id = v_active_preview.id;

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

  SELECT pg_catalog.count(*)
    INTO v_replacement_count
    FROM public.participant_preview_correction_requests r
   WHERE r.status = 'resolved'
     AND r.replacement_preview_id = v_active_preview.id;

  IF v_confirmation.id IS NULL THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Waiting for participant confirmation');
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

  -- 10. Current participant-facing scalar and taxonomy content, projected exactly as the normal
  -- gate projects it so one confirmed snapshot serves both authorities.
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
      'videoUrl', p.video_url,
      'demoUrl', p.demo_url,
      'repositoryUrl', p.repository_url,
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

  -- Historical-snapshot compatibility for controlled project links.
  --
  -- Previews issued before controlled project links became participant evidence carry none
  -- of the three keys. Such a preview stays equivalent ONLY while the project still has no
  -- controlled link at all. Any populated controlled URL is public-eligible content the
  -- participant was never shown, so it invalidates the confirmation rather than being
  -- grandfathered. Stored snapshots are never rewritten or backfilled to reach this result.
  v_comparable_snapshot := v_current_snapshot;

  IF NOT (v_active_preview.snapshot ? 'videoUrl')
     AND NOT (v_active_preview.snapshot ? 'demoUrl')
     AND NOT (v_active_preview.snapshot ? 'repositoryUrl')
     AND v_current_snapshot->>'videoUrl' IS NULL
     AND v_current_snapshot->>'demoUrl' IS NULL
     AND v_current_snapshot->>'repositoryUrl' IS NULL
  THEN
    v_comparable_snapshot := v_comparable_snapshot - 'videoUrl' - 'demoUrl' - 'repositoryUrl';
  END IF;

  IF v_comparable_snapshot IS DISTINCT FROM v_active_preview.snapshot THEN
    v_blockers := pg_catalog.array_append(v_blockers, 'Project information changed after participant confirmation');
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(v_blockers),
      'confirmedPreviewId', v_active_preview.id,
      'confirmedAt', v_confirmation.confirmed_at::text
    );
  END IF;

  -- 11. Current media identity, projected with the SAME keys and semantics as the normal gate --
  -- including galleryPosition and altText -- so an add, a removal, a reorder, a replacement or an
  -- alt-text edit all change the compared object. The only difference is the row filter: the
  -- publication mapping columns are deliberately not part of the participant-content comparison,
  -- because publication is expected to have populated them. They were proved coherent in step 8.
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'mediaAssetId', ma.id,
        'assetType', ma.asset_type,
        'galleryPosition',
          CASE
            WHEN ma.asset_type = 'snapshot_image'
              THEN ma.gallery_position
            ELSE NULL
          END,
        'fileName', ma.file_name,
        'storageBucket', ma.storage_bucket,
        'storagePath', ma.storage_path,
        'mimeType', ma.mime_type,
        'altText', ma.alt_text_public
      )
      ORDER BY
        CASE ma.asset_type
          WHEN 'poster_image' THEN 1
          WHEN 'poster_pdf' THEN 2
          WHEN 'snapshot_image' THEN 3
          ELSE 4
        END,
        CASE
          WHEN ma.asset_type = 'snapshot_image'
            THEN ma.gallery_position
          ELSE NULL
        END,
        ma.id
    ),
    '[]'::jsonb
  )
  INTO v_current_media_snapshot
  FROM public.media_assets ma
  WHERE ma.project_id = v_project.id
    AND ma.storage_bucket = v_private_bucket;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
  INTO v_canonical_current_media
  FROM pg_catalog.jsonb_array_elements(v_current_media_snapshot) elem;

  v_stored_media_snapshot := COALESCE(v_active_preview.media_snapshot, '[]'::jsonb);

  -- Stored evidence must use the current immutable gallery contract.
  SELECT pg_catalog.count(*)
    INTO v_invalid_media_element_count
    FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem
   WHERE
      pg_catalog.jsonb_typeof(elem) <> 'object'
      OR pg_catalog.jsonb_typeof(elem->'mediaAssetId') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'assetType') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'fileName') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storageBucket') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'storagePath') <> 'string'
      OR pg_catalog.jsonb_typeof(elem->'mimeType') <> 'string'
      OR NOT (elem ? 'galleryPosition')
      OR NOT (elem ? 'altText')
      OR (
        elem->>'assetType' = 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(elem->'galleryPosition') <> 'number'
          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(elem->'galleryPosition') = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric
                <> pg_catalog.trunc((elem->>'galleryPosition')::numeric)
              )
              ELSE false
            END
          )
          OR (
            CASE
              WHEN pg_catalog.jsonb_typeof(elem->'galleryPosition') = 'number'
              THEN (
                (elem->>'galleryPosition')::numeric < 1
                OR (elem->>'galleryPosition')::numeric > 10
              )
              ELSE false
            END
          )
          OR pg_catalog.jsonb_typeof(elem->'altText') <> 'string'
          OR pg_catalog.btrim(COALESCE(elem->>'altText', '')) = ''
          OR pg_catalog.length(pg_catalog.btrim(elem->>'altText')) > 2000
        )
      )
      OR (
        elem->>'assetType' <> 'snapshot_image'
        AND (
          pg_catalog.jsonb_typeof(elem->'galleryPosition') <> 'null'
          OR pg_catalog.jsonb_typeof(elem->'altText') <> 'null'
        )
      );

  IF v_invalid_media_element_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview media state is malformed'])
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        SELECT
          elem->>'galleryPosition' AS gallery_position,
          pg_catalog.count(*) AS position_count
        FROM pg_catalog.jsonb_array_elements(v_stored_media_snapshot) elem
        WHERE elem->>'assetType' = 'snapshot_image'
        GROUP BY elem->>'galleryPosition'
        HAVING pg_catalog.count(*) > 1
      ) duplicate_positions
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Stored preview media state is malformed'])
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      elem
      ORDER BY (elem->>'mediaAssetId')
    ),
    '[]'::jsonb
  )
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

  -- 12. Every relevant fact is established from authoritative persisted state.
  RETURN pg_catalog.jsonb_build_object(
    'ready', true,
    'resultCode', 'READY',
    'blockers', '[]'::jsonb,
    'confirmedPreviewId', v_active_preview.id,
    'confirmedAt', v_confirmation.confirmed_at::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) TO service_role;

COMMIT;
