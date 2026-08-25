-- Issue #186: one fenced, forward-converging canonical-feed writer protocol.

BEGIN;

CREATE OR REPLACE FUNCTION public.public_feed_actor_is_admin(p_actor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_actor_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.admin_users au
    JOIN public.user_roles ur ON ur.user_id = au.id
    WHERE au.id = p_actor_id AND ur.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.public_feed_owner_valid(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.public_feed_operations o
    WHERE o.id = p_operation_id
      AND o.owner_epoch = p_owner_epoch
      AND o.owner_token_hash = pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(COALESCE(p_owner_token, ''), 'UTF8'), 'sha256'),
        'hex'
      )
      AND COALESCE(o.completion_actor_id, o.authorizing_actor_id) = p_actor_id
  );
$$;

CREATE OR REPLACE FUNCTION public.append_public_feed_operation_event(
  p_operation_id uuid,
  p_from_state text,
  p_to_state text,
  p_actor_id uuid,
  p_owner_epoch bigint,
  p_observed_hash text DEFAULT NULL,
  p_observed_count integer DEFAULT NULL,
  p_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_sequence integer;
BEGIN
  SELECT COALESCE(pg_catalog.max(e.sequence), 0) + 1
    INTO v_sequence
    FROM public.public_feed_operation_events e
   WHERE e.operation_id = p_operation_id;
  INSERT INTO public.public_feed_operation_events(
    operation_id, sequence, from_state, to_state, actor_id, owner_epoch,
    observed_storage_hash, observed_storage_record_count, code
  ) VALUES (
    p_operation_id, v_sequence, p_from_state, p_to_state, p_actor_id, p_owner_epoch,
    p_observed_hash, p_observed_count, p_code
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_public_feed_operation_lease(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_operation public.public_feed_operations%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  IF v_operation.state NOT IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED') THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE');
  END IF;
  UPDATE public.public_feed_operations
     SET lease_expires_at = pg_catalog.now() + interval '2 minutes', updated_at = pg_catalog.now()
   WHERE id = p_operation_id;
  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'LEASE_RENEWED', 'leaseExpiresAt', pg_catalog.now() + interval '2 minutes'
  );
END;
$$;

-- Deployment-reconciliation readiness.
--
-- This is a SEPARATE authority from public.get_project_publication_readiness, which is a
-- PRE-publication gate and correctly demands `approved` status plus pre-publication private-media
-- state. A reconciliation target is already lifecycle `published`, so reusing the normal gate would
-- require weakening it. Nothing here relaxes normal readiness; normal-mode semantics are untouched.
--
-- What this proves, entirely from authoritative persisted state:
--   * the project exists, is not deleted, and is lifecycle `published`;
--   * exactly one active participant preview exists and carries a confirmation;
--   * no unresolved or contradictory correction state exists;
--   * the stored preview evidence is well-formed under the current gallery contract;
--   * the CURRENT participant-facing scalar/taxonomy content still equals the confirmed snapshot;
--   * the CURRENT media identity -- including gallery position and per-image alt text -- still
--     equals the confirmed media snapshot;
--   * every public media mapping produced by the earlier publication is coherent and points at the
--     deterministic destination for that exact asset.
--
-- The public feed, current public URLs, and project.status alone are never treated as proof.
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

CREATE OR REPLACE FUNCTION public.mark_public_feed_write_started(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.public_feed_operations%ROWTYPE;
  v_readiness jsonb;
  v_head public.public_feed_head%ROWTYPE;
  v_from_state text;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  IF v_operation.state = 'WRITE_STARTED' THEN
    IF v_operation.storage_uncertainty_until IS NOT NULL
       AND v_operation.storage_uncertainty_until > pg_catalog.now()
    THEN RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'UNCERTAINTY_FENCE_ACTIVE',
      'storageRequestGeneration', v_operation.storage_request_generation,
      'storageRequestDeadlineAt', v_operation.storage_request_deadline_at,
      'storageUncertaintyUntil', v_operation.storage_uncertainty_until
    ); END IF;
    UPDATE public.public_feed_operations
       SET completion_actor_id = p_actor_id,
           storage_request_generation = storage_request_generation + 1,
           storage_request_started_at = pg_catalog.now(),
           storage_request_deadline_at = pg_catalog.now() + interval '45 seconds',
           storage_uncertainty_until = pg_catalog.now() + interval '120 seconds',
           lease_expires_at = pg_catalog.now() + interval '2 minutes',
           updated_at = pg_catalog.now()
     WHERE id = p_operation_id RETURNING * INTO v_operation;
    PERFORM public.append_public_feed_operation_event(
      p_operation_id, 'WRITE_STARTED', 'WRITE_STARTED', p_actor_id, p_owner_epoch,
      NULL, NULL, 'SAME_CANDIDATE_RETRY'
    );
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'WRITE_STARTED', 'storageRequestGeneration', v_operation.storage_request_generation,
      'storageRequestDeadlineAt', v_operation.storage_request_deadline_at,
      'storageUncertaintyUntil', v_operation.storage_uncertainty_until
    );
  END IF;
  IF v_operation.state NOT IN ('PREPARED', 'RECOVERY_REQUIRED') THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE');
  END IF;

  -- Final pre-side-effect authority for deployment reconciliation.
  --
  -- Application-level preparation is never sufficient and the TypeScript preflight is never
  -- trusted here: every fact is re-established from authoritative persisted state inside the same
  -- transaction that moves the operation into WRITE_STARTED, so no public object can be created on
  -- stale authority. The actor was already proved to be an administrator and the owner epoch/token
  -- were already proved current above.
  --
  -- storage_request_generation = 0 means this operation has never legitimately entered
  -- WRITE_STARTED. Once it has, the operation converges forward on the same immutable candidate
  -- and this mutable drift gate deliberately does not run again.
  IF v_operation.kind = 'publication'
     AND v_operation.publication_mode = 'deployment_reconciliation'
     AND v_operation.storage_request_generation = 0 THEN
    SELECT * INTO v_head FROM public.public_feed_head WHERE singleton = true FOR UPDATE;
    IF v_head.singleton IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'HISTORY_NOT_ACTIVE');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.public_feed_version_members m
       WHERE m.version_id = v_head.current_version_id
         AND m.public_id = v_operation.public_id
    ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_DEPLOYED'); END IF;

    v_readiness := public.get_project_reconciliation_readiness(
      v_operation.public_id, p_actor_id, v_operation.private_media_bucket
    );
    IF v_readiness->>'resultCode' <> 'READY'
       OR COALESCE((v_readiness->>'ready')::boolean, false) = false
       OR v_readiness->>'confirmedPreviewId' <> v_operation.confirmed_preview_id::text
       OR (v_readiness->>'confirmedAt')::timestamptz IS DISTINCT FROM v_operation.confirmed_at
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
  END IF;

  -- Permission/readiness freshness is rechecked at the last durable boundary before a request
  -- may reach Storage. After this transition, recovery must converge forward.
  IF v_operation.kind = 'publication' AND v_operation.publication_mode = 'normal' THEN
    v_readiness := public.get_project_publication_readiness(
      v_operation.public_id, p_actor_id, v_operation.private_media_bucket
    );
    IF v_readiness->>'resultCode' <> 'READY'
       OR COALESCE((v_readiness->>'ready')::boolean, false) = false
       OR v_readiness->>'confirmedPreviewId' <> v_operation.confirmed_preview_id::text
       OR (v_readiness->>'confirmedAt')::timestamptz IS DISTINCT FROM v_operation.confirmed_at
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
  END IF;

  v_from_state := v_operation.state;
  UPDATE public.public_feed_operations
     SET state = 'WRITE_STARTED', completion_actor_id = p_actor_id,
         storage_request_generation = storage_request_generation + 1,
         storage_request_started_at = pg_catalog.now(),
         storage_request_deadline_at = pg_catalog.now() + interval '45 seconds',
         storage_uncertainty_until = pg_catalog.now() + interval '120 seconds',
         lease_expires_at = pg_catalog.now() + interval '2 minutes',
         updated_at = pg_catalog.now()
   WHERE id = p_operation_id
   RETURNING * INTO v_operation;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, v_from_state, 'WRITE_STARTED', p_actor_id, p_owner_epoch,
    NULL, NULL, CASE WHEN v_from_state = 'RECOVERY_REQUIRED' THEN 'RECOVERY_WRITE_RETRY' ELSE NULL END
  );
  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'WRITE_STARTED', 'storageRequestGeneration', v_operation.storage_request_generation,
    'storageRequestDeadlineAt', v_operation.storage_request_deadline_at,
    'storageUncertaintyUntil', v_operation.storage_uncertainty_until
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_public_feed_candidate_observed(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid,
  p_observed_hash text,
  p_observed_record_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.public_feed_operations%ROWTYPE;
  v_target_state text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  IF v_operation.state = 'CANDIDATE_OBSERVED' THEN
    IF v_operation.observed_storage_hash = p_observed_hash
       AND v_operation.observed_storage_record_count = p_observed_record_count
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'CANDIDATE_OBSERVED'); END IF;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'OBSERVATION_MISMATCH');
  END IF;
  IF v_operation.state NOT IN ('PREPARED', 'WRITE_STARTED', 'RECOVERY_REQUIRED') THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE');
  END IF;
  IF v_operation.state = 'PREPARED' AND (
    v_operation.baseline_storage_existed IS DISTINCT FROM true
    OR v_operation.baseline_feed_hash IS DISTINCT FROM v_operation.candidate_feed_hash
    OR v_operation.baseline_record_count IS DISTINCT FROM v_operation.candidate_record_count
  ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'WRITE_INTENT_REQUIRED'); END IF;
  IF v_operation.candidate_feed_hash IS DISTINCT FROM p_observed_hash
     OR v_operation.candidate_record_count IS DISTINCT FROM p_observed_record_count
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OBSERVATION_MISMATCH'); END IF;
  v_target_state := CASE
    WHEN v_operation.recovery_from_state = 'DB_FINALIZED' THEN 'DB_FINALIZED'
    ELSE 'CANDIDATE_OBSERVED'
  END;
  UPDATE public.public_feed_operations
     SET state = v_target_state, observed_storage_hash = p_observed_hash,
         observed_storage_record_count = p_observed_record_count,
         failure_code = NULL,
         lease_expires_at = pg_catalog.now() + interval '2 minutes', updated_at = pg_catalog.now()
   WHERE id = p_operation_id;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, v_operation.state, v_target_state, p_actor_id, p_owner_epoch,
    p_observed_hash, p_observed_record_count,
    CASE WHEN v_operation.state = 'RECOVERY_REQUIRED' OR v_operation.recovery_from_state IS NOT NULL
      THEN 'RECOVERY_CANDIDATE_OBSERVED' ELSE NULL END
  );
  RETURN pg_catalog.jsonb_build_object('resultCode', v_target_state);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_public_feed_operation(
  p_operation_id uuid,
  p_admin_id uuid,
  p_new_owner_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_operation public.public_feed_operations%ROWTYPE;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF pg_catalog.length(COALESCE(p_new_owner_token, '')) NOT BETWEEN 32 AND 200 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF v_operation.state NOT IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED') THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE');
  END IF;
  IF v_operation.lease_expires_at > pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLICATION_IN_PROGRESS');
  END IF;
  IF v_operation.state = 'WRITE_STARTED'
     AND v_operation.storage_uncertainty_until IS NOT NULL
     AND v_operation.storage_uncertainty_until > pg_catalog.now()
  THEN RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'UNCERTAINTY_FENCE_ACTIVE', 'retryAfter', v_operation.storage_uncertainty_until
  ); END IF;
  UPDATE public.public_feed_operations
     SET owner_epoch = owner_epoch + 1,
         owner_token_hash = pg_catalog.encode(
           extensions.digest(pg_catalog.convert_to(p_new_owner_token, 'UTF8'), 'sha256'), 'hex'
         ),
         completion_actor_id = p_admin_id,
         lease_expires_at = pg_catalog.now() + interval '2 minutes', updated_at = pg_catalog.now()
   WHERE id = p_operation_id RETURNING * INTO v_operation;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, v_operation.state, v_operation.state, p_admin_id, v_operation.owner_epoch,
    v_operation.observed_storage_hash, v_operation.observed_storage_record_count, 'OWNER_CLAIMED'
  );
  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'OPERATION_CLAIMED', 'ownerEpoch', v_operation.owner_epoch,
    'state', v_operation.state, 'leaseExpiresAt', v_operation.lease_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_public_feed_operation(
  p_operation_key uuid,
  p_kind text,
  p_publication_mode text,
  p_admin_id uuid,
  p_public_id text,
  p_owner_token text,
  p_confirmed_preview_id uuid,
  p_confirmed_at timestamptz,
  p_private_bucket text,
  p_archive_reason text,
  p_rollback_preparation_handle uuid,
  p_rollback_acknowledgement text,
  p_storage_bucket text,
  p_storage_path text,
  p_rollback_capability boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text := pg_catalog.btrim(COALESCE(p_kind, ''));
  v_mode text := NULLIF(pg_catalog.btrim(COALESCE(p_publication_mode, '')), '');
  v_public_id text := NULLIF(pg_catalog.btrim(COALESCE(p_public_id, '')), '');
  v_key uuid := p_operation_key;
  v_project public.projects%ROWTYPE;
  v_existing public.public_feed_operations%ROWTYPE;
  v_operation public.public_feed_operations%ROWTYPE;
  v_head public.public_feed_head%ROWTYPE;
  v_preparation public.feed_rollback_preparations%ROWTYPE;
  v_readiness jsonb;
  v_legacy_state text;
  v_token_hash text;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF v_kind NOT IN ('activation', 'publication', 'removal', 'rollback')
     OR pg_catalog.length(COALESCE(p_owner_token, '')) < 32
     OR pg_catalog.length(COALESCE(p_owner_token, '')) > 200
     OR pg_catalog.btrim(COALESCE(p_storage_bucket, '')) = ''
     OR pg_catalog.btrim(COALESCE(p_storage_path, '')) = ''
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  IF (v_kind = 'publication' AND v_mode NOT IN ('normal', 'deployment_reconciliation'))
     OR (v_kind <> 'publication' AND v_mode IS NOT NULL)
     OR (v_kind IN ('publication', 'removal') AND (
       v_public_id IS NULL OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$'
     ))
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;

  v_token_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_owner_token, 'UTF8'), 'sha256'), 'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));

  IF v_kind = 'rollback' THEN
    SELECT * INTO v_preparation
      FROM public.feed_rollback_preparations
     WHERE handle = p_rollback_preparation_handle
     FOR UPDATE;
    IF v_preparation.handle IS NULL
       OR v_preparation.actor_id IS DISTINCT FROM p_admin_id
       OR v_preparation.expires_at <= pg_catalog.now()
       OR v_preparation.consumed_at IS NOT NULL
       OR v_preparation.acknowledgement_digest IS DISTINCT FROM pg_catalog.encode(
         extensions.digest(pg_catalog.convert_to(COALESCE(p_rollback_acknowledgement, ''), 'UTF8'), 'sha256'), 'hex'
       )
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_PREPARATION'); END IF;
    v_key := v_preparation.operation_key;
  ELSIF v_key IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT');
  END IF;

  SELECT * INTO v_existing FROM public.public_feed_operations WHERE operation_key = v_key FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.kind IS DISTINCT FROM v_kind
       OR v_existing.publication_mode IS DISTINCT FROM v_mode
       OR v_existing.authorizing_actor_id IS DISTINCT FROM p_admin_id
       OR v_existing.public_id IS DISTINCT FROM v_public_id
       OR v_existing.rollback_preparation_id IS DISTINCT FROM p_rollback_preparation_handle
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'IDEMPOTENCY_KEY_MISMATCH'); END IF;
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'OPERATION_RESERVED', 'operationId', v_existing.id::text,
      'ownerEpoch', v_existing.owner_epoch, 'state', v_existing.state,
      'leaseExpiresAt', v_existing.lease_expires_at
    );
  END IF;

  SELECT * INTO v_existing
    FROM public.public_feed_operations
   WHERE state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED')
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', CASE WHEN v_existing.state = 'RECOVERY_REQUIRED' THEN 'RECOVERY_REQUIRED' ELSE 'PUBLICATION_IN_PROGRESS' END
    );
  END IF;

  SELECT state INTO v_legacy_state FROM public.publication_attempts
   WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_legacy_state IS NULL THEN
    SELECT state INTO v_legacy_state FROM public.public_removal_attempts
     WHERE state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
     ORDER BY created_at LIMIT 1 FOR UPDATE;
  END IF;
  IF v_legacy_state IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'LEGACY_RECOVERY_REQUIRED');
  END IF;

  SELECT * INTO v_head FROM public.public_feed_head WHERE singleton = true FOR UPDATE;
  IF v_kind = 'activation' THEN
    IF v_head.singleton IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_ACTIVE');
    END IF;
  ELSIF v_head.singleton IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'HISTORY_NOT_ACTIVE');
  END IF;

  IF v_kind = 'publication' THEN
    SELECT * INTO v_project FROM public.projects
     WHERE public_id = v_public_id AND deleted_at IS NULL FOR UPDATE;
    IF v_project.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
    IF v_mode = 'normal' THEN
      IF v_project.status <> 'approved' OR p_confirmed_preview_id IS NULL OR p_confirmed_at IS NULL
         OR pg_catalog.btrim(COALESCE(p_private_bucket, '')) = ''
      THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
      v_readiness := public.get_project_publication_readiness(v_public_id, p_admin_id, p_private_bucket);
      IF v_readiness->>'resultCode' <> 'READY'
         OR COALESCE((v_readiness->>'ready')::boolean, false) = false
         OR v_readiness->>'confirmedPreviewId' <> p_confirmed_preview_id::text
         OR (v_readiness->>'confirmedAt')::timestamptz IS DISTINCT FROM p_confirmed_at
      THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
    ELSE
      -- Deployment reconciliation. Lifecycle `published` alone is never deployment authority:
      -- the same exact participant confirmation evidence that normal publication binds must still
      -- be authoritative for the CURRENT content, and it is bound into the immutable operation
      -- intent below exactly as normal publication binds it.
      IF v_project.status <> 'published'
         OR p_confirmed_preview_id IS NULL
         OR p_confirmed_at IS NULL
         OR pg_catalog.btrim(COALESCE(p_private_bucket, '')) = ''
      THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
      v_readiness := public.get_project_reconciliation_readiness(v_public_id, p_admin_id, p_private_bucket);
      IF v_readiness->>'resultCode' <> 'READY'
         OR COALESCE((v_readiness->>'ready')::boolean, false) = false
         OR v_readiness->>'confirmedPreviewId' <> p_confirmed_preview_id::text
         OR (v_readiness->>'confirmedAt')::timestamptz IS DISTINCT FROM p_confirmed_at
      THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.public_feed_version_members m
      WHERE m.version_id = v_head.current_version_id AND m.public_id = v_public_id
    ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_DEPLOYED'); END IF;
  ELSIF v_kind = 'removal' THEN
    SELECT * INTO v_project FROM public.projects
     WHERE public_id = v_public_id AND deleted_at IS NULL AND status IN ('published', 'archived') FOR UPDATE;
    IF v_project.id IS NULL OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_archive_reason, ''))) NOT BETWEEN 1 AND 4000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_PUBLISHED');
    END IF;
  ELSIF v_kind = 'rollback' THEN
    IF v_head.rollback_enabled IS DISTINCT FROM true
       OR v_head.current_version_id IS DISTINCT FROM v_preparation.baseline_version_id
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_PREPARATION'); END IF;
  END IF;

  INSERT INTO public.public_feed_operations(
    operation_key, kind, publication_mode, authorizing_actor_id, project_id, public_id,
    rollback_preparation_id, confirmed_preview_id, confirmed_at, private_media_bucket,
    archive_reason, rollback_capability_requested, state, owner_epoch, owner_token_hash,
    lease_expires_at, storage_bucket, storage_path
  ) VALUES (
    v_key, v_kind, v_mode, p_admin_id, v_project.id, v_public_id,
    p_rollback_preparation_handle, p_confirmed_preview_id, p_confirmed_at,
    NULLIF(pg_catalog.btrim(COALESCE(p_private_bucket, '')), ''),
    NULLIF(pg_catalog.btrim(COALESCE(p_archive_reason, '')), ''),
    v_kind = 'activation' AND p_rollback_capability,
    'RESERVED', 1, v_token_hash, pg_catalog.now() + interval '2 minutes',
    p_storage_bucket, p_storage_path
  ) RETURNING * INTO v_operation;

  IF v_kind = 'rollback' THEN
    UPDATE public.feed_rollback_preparations
       SET consumed_at = pg_catalog.now(), operation_id = v_operation.id
     WHERE handle = v_preparation.handle;
  END IF;

  PERFORM public.append_public_feed_operation_event(
    v_operation.id, NULL, 'RESERVED', p_admin_id, v_operation.owner_epoch
  );
  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'OPERATION_RESERVED', 'operationId', v_operation.id::text,
    'ownerEpoch', v_operation.owner_epoch, 'state', v_operation.state,
    'leaseExpiresAt', v_operation.lease_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_public_feed_operation(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid,
  p_baseline_version_id uuid,
  p_baseline_storage_existed boolean,
  p_baseline_feed_hash text,
  p_baseline_record_count integer,
  p_baseline_feed_content text,
  p_candidate_feed_hash text,
  p_candidate_record_count integer,
  p_candidate_feed_content text,
  p_candidate_members jsonb,
  p_feed_public_url text,
  p_media_manifest jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.public_feed_operations%ROWTYPE;
  v_head public.public_feed_head%ROWTYPE;
  v_baseline_version public.public_feed_versions%ROWTYPE;
  v_candidate jsonb;
  v_baseline jsonb;
  v_candidate_hash text;
BEGIN
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  IF p_baseline_storage_existed IS NULL
     OR p_candidate_feed_content IS NULL
     OR pg_catalog.octet_length(p_candidate_feed_content) > 10485760
     OR p_candidate_feed_hash !~ '^[0-9a-f]{64}$'
     OR p_candidate_record_count < 0
     OR p_candidate_members IS NULL OR pg_catalog.jsonb_typeof(p_candidate_members) <> 'array'
     OR pg_catalog.btrim(COALESCE(p_feed_public_url, '')) = ''
     OR p_media_manifest IS NULL OR pg_catalog.jsonb_typeof(p_media_manifest) <> 'array'
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  IF p_baseline_storage_existed AND (
    p_baseline_feed_content IS NULL OR pg_catalog.octet_length(p_baseline_feed_content) > 10485760
    OR p_baseline_feed_hash !~ '^[0-9a-f]{64}$' OR p_baseline_record_count < 0
  ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  IF NOT p_baseline_storage_existed AND (
    p_baseline_feed_content IS NOT NULL OR p_baseline_feed_hash IS NOT NULL OR p_baseline_record_count IS NOT NULL
  ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;

  BEGIN v_candidate := p_candidate_feed_content::jsonb;
  EXCEPTION WHEN others THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT'); END;
  v_candidate_hash := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_candidate_feed_content, 'UTF8'), 'sha256'), 'hex'
  );
  IF pg_catalog.jsonb_typeof(v_candidate) <> 'array'
     OR pg_catalog.jsonb_array_length(v_candidate) <> p_candidate_record_count
     OR v_candidate_hash <> p_candidate_feed_hash
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) item
        WHERE pg_catalog.jsonb_typeof(item) <> 'object'
           OR COALESCE(item->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
     )
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_candidate)) <>
        (SELECT pg_catalog.count(DISTINCT item->>'publicId') FROM pg_catalog.jsonb_array_elements(v_candidate) item)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT'); END IF;
  IF pg_catalog.jsonb_array_length(p_candidate_members) <> p_candidate_record_count
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(p_candidate_members) WITH ORDINALITY AS member(value, ordinality)
       WHERE pg_catalog.jsonb_typeof(member.value) <> 'object'
          OR COALESCE(member.value->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
          OR COALESCE(member.value->>'recordHash', '') !~ '^[0-9a-f]{64}$'
          OR CASE WHEN COALESCE(member.value->>'ordinal', '') ~ '^[0-9]+$'
               THEN (member.value->>'ordinal')::integer <> member.ordinality - 1
               ELSE true END
          OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_candidate) WITH ORDINALITY AS candidate(value, ordinality)
            WHERE candidate.ordinality = member.ordinality
              AND candidate.value->>'publicId' = member.value->>'publicId'
          )
     )
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_MEMBER_MANIFEST'); END IF;

  IF p_baseline_storage_existed THEN
    BEGIN v_baseline := p_baseline_feed_content::jsonb;
    EXCEPTION WHEN others THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_BASELINE'); END;
    IF pg_catalog.jsonb_typeof(v_baseline) <> 'array'
       OR pg_catalog.jsonb_array_length(v_baseline) <> p_baseline_record_count
       OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_baseline_feed_content, 'UTF8'), 'sha256'), 'hex') <> p_baseline_feed_hash
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_BASELINE'); END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF v_operation.state = 'PREPARED' THEN
    IF v_operation.baseline_version_id IS NOT DISTINCT FROM p_baseline_version_id
       AND v_operation.baseline_storage_existed IS NOT DISTINCT FROM p_baseline_storage_existed
       AND v_operation.candidate_feed_hash = p_candidate_feed_hash
       AND v_operation.candidate_record_count = p_candidate_record_count
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_BOUND'); END IF;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH');
  END IF;
  IF v_operation.state <> 'RESERVED' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE'); END IF;

  SELECT * INTO v_head FROM public.public_feed_head WHERE singleton = true FOR UPDATE;
  IF v_operation.kind = 'activation' THEN
    IF v_head.singleton IS NOT NULL OR p_baseline_version_id IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_BASELINE');
    END IF;
  ELSE
    IF v_head.singleton IS NULL OR v_head.current_version_id IS DISTINCT FROM p_baseline_version_id
       OR p_baseline_storage_existed IS DISTINCT FROM true
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_BASELINE'); END IF;
    SELECT * INTO v_baseline_version FROM public.public_feed_versions WHERE id = p_baseline_version_id;
    IF v_baseline_version.id IS NULL
       OR v_baseline_version.feed_hash IS DISTINCT FROM p_baseline_feed_hash
       OR v_baseline_version.record_count IS DISTINCT FROM p_baseline_record_count
       OR v_baseline_version.artifact_content IS DISTINCT FROM p_baseline_feed_content
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_BASELINE'); END IF;
  END IF;

  UPDATE public.public_feed_operations
     SET baseline_version_id = p_baseline_version_id,
         baseline_storage_existed = p_baseline_storage_existed,
         baseline_feed_hash = p_baseline_feed_hash,
         baseline_record_count = p_baseline_record_count,
         baseline_feed_content = p_baseline_feed_content,
         candidate_feed_hash = p_candidate_feed_hash,
         candidate_record_count = p_candidate_record_count,
         candidate_byte_count = pg_catalog.octet_length(p_candidate_feed_content),
         candidate_feed_content = p_candidate_feed_content,
         candidate_members = p_candidate_members,
         feed_public_url = p_feed_public_url,
         media_manifest = p_media_manifest,
         state = 'PREPARED', updated_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now() + interval '2 minutes'
   WHERE id = p_operation_id;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, 'RESERVED', 'PREPARED', p_actor_id, p_owner_epoch
  );
  RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_BOUND');
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_public_feed_operation(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_completion_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.public_feed_operations%ROWTYPE;
  v_head public.public_feed_head%ROWTYPE;
  v_candidate jsonb;
  v_baseline jsonb;
  v_project public.projects%ROWTYPE;
  v_preparation public.feed_rollback_preparations%ROWTYPE;
  v_version_id uuid;
  v_version_number bigint;
  v_version_operation text;
  v_restored_from uuid;
  v_snapshot_id uuid;
  v_audit_id uuid;
  v_manifest_item jsonb;
  v_no_feed_change boolean := false;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_completion_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF NOT public.public_feed_owner_valid(
    p_operation_id, p_owner_epoch, p_owner_token, p_completion_actor_id
  ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER'); END IF;
  IF v_operation.state = 'DB_FINALIZED' THEN
    SELECT id, version_number, published_snapshot_id, audit_record_id
      INTO v_version_id, v_version_number, v_snapshot_id, v_audit_id
      FROM public.public_feed_versions WHERE operation_id = p_operation_id;
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'DB_FINALIZED', 'versionId', v_version_id::text,
      'versionNumber', v_version_number, 'snapshotId', v_snapshot_id::text,
      'auditRecordId', v_audit_id::text
    );
  END IF;
  IF v_operation.state <> 'CANDIDATE_OBSERVED' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE');
  END IF;

  BEGIN v_candidate := v_operation.candidate_feed_content::jsonb;
  EXCEPTION WHEN others THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT'); END;
  IF pg_catalog.jsonb_typeof(v_candidate) <> 'array'
     OR pg_catalog.jsonb_array_length(v_candidate) <> v_operation.candidate_record_count
     OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_operation.candidate_feed_content, 'UTF8'), 'sha256'), 'hex') <> v_operation.candidate_feed_hash
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) item
        WHERE pg_catalog.jsonb_typeof(item) <> 'object'
           OR COALESCE(item->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
     )
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_candidate)) <>
        (SELECT pg_catalog.count(DISTINCT item->>'publicId') FROM pg_catalog.jsonb_array_elements(v_candidate) item)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_ARTIFACT'); END IF;

  SELECT * INTO v_head FROM public.public_feed_head WHERE singleton = true FOR UPDATE;
  IF v_operation.kind = 'activation' THEN
    IF v_head.singleton IS NOT NULL OR v_operation.baseline_version_id IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_BASELINE');
    END IF;
  ELSE
    IF v_head.singleton IS NULL OR v_head.current_version_id IS DISTINCT FROM v_operation.baseline_version_id THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_BASELINE');
    END IF;
    BEGIN v_baseline := v_operation.baseline_feed_content::jsonb;
    EXCEPTION WHEN others THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_BASELINE'); END;
  END IF;

  IF v_operation.kind = 'publication' THEN
    SELECT * INTO v_project FROM public.projects WHERE id = v_operation.project_id FOR UPDATE;
    IF v_project.id IS NULL OR v_project.deleted_at IS NOT NULL
       OR (v_operation.publication_mode = 'normal' AND v_project.status <> 'approved')
       OR (v_operation.publication_mode = 'deployment_reconciliation' AND v_project.status <> 'published')
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_candidate) item WHERE item->>'publicId' = v_operation.public_id) <> 1
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_baseline) old_item
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) new_item
             WHERE new_item->>'publicId' = old_item->>'publicId' AND new_item = old_item
          )
       )
       OR pg_catalog.jsonb_array_length(v_candidate) <> pg_catalog.jsonb_array_length(v_baseline) + 1
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;

    PERFORM pg_catalog.set_config('app.public_feed_operation_id', v_operation.id::text, true);
    FOR v_manifest_item IN SELECT * FROM pg_catalog.jsonb_array_elements(v_operation.media_manifest)
    LOOP
      IF pg_catalog.jsonb_typeof(v_manifest_item) <> 'object'
         OR COALESCE(v_manifest_item->>'mediaAssetId', '') !~ '^[0-9a-fA-F-]{36}$'
         OR COALESCE(v_manifest_item->>'publicBucket', '') = ''
         OR COALESCE(v_manifest_item->>'publicPath', '') = ''
         OR COALESCE(v_manifest_item->>'publicUrl', '') = ''
         OR COALESCE(v_manifest_item->>'sourceSha256', '') !~ '^[0-9a-f]{64}$'
      THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'MEDIA_MANIFEST_INVALID'); END IF;
      UPDATE public.media_assets
         SET is_public_approved = true,
             public_storage_bucket = v_manifest_item->>'publicBucket',
             public_storage_path = v_manifest_item->>'publicPath',
             public_url = v_manifest_item->>'publicUrl'
       WHERE id = (v_manifest_item->>'mediaAssetId')::uuid
         AND project_id = v_project.id
         AND storage_bucket = v_operation.private_media_bucket
         AND (
           is_public_approved = false
           OR (
             -- Deployment reconciliation republishes a project whose media was already promoted by
             -- its original publication. Re-asserting the SAME bound destination is idempotent; a
             -- row pointing anywhere else is refused as stale rather than overwritten.
             v_operation.publication_mode = 'deployment_reconciliation'
             AND is_public_approved = true
             AND public_storage_bucket IS NOT DISTINCT FROM v_manifest_item->>'publicBucket'
             AND public_storage_path IS NOT DISTINCT FROM v_manifest_item->>'publicPath'
             AND public_url IS NOT DISTINCT FROM v_manifest_item->>'publicUrl'
           )
         );
      IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'MEDIA_MANIFEST_STALE'); END IF;
    END LOOP;

    IF v_operation.publication_mode = 'normal' THEN
      UPDATE public.projects SET status = 'published' WHERE id = v_project.id AND status = 'approved';
      IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_READY'); END IF;
      INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments)
      VALUES (v_project.id, v_operation.authorizing_actor_id, 'publish', 'approved', 'published', NULL)
      RETURNING id INTO v_audit_id;
    END IF;
    INSERT INTO public.published_snapshots(
      feed_file_name, storage_bucket, storage_path, public_url, record_count, feed_hash, created_by
    ) VALUES (
      v_operation.storage_path, v_operation.storage_bucket,
      v_operation.storage_bucket || '/' || v_operation.storage_path,
      v_operation.feed_public_url, v_operation.candidate_record_count,
      v_operation.candidate_feed_hash, v_operation.authorizing_actor_id
    ) RETURNING id INTO v_snapshot_id;
    v_version_operation := 'publication';

  ELSIF v_operation.kind = 'removal' THEN
    SELECT * INTO v_project FROM public.projects WHERE id = v_operation.project_id FOR UPDATE;
    IF v_project.id IS NULL OR v_project.deleted_at IS NOT NULL OR v_project.status NOT IN ('published', 'archived')
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_PUBLISHED'); END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) item WHERE item->>'publicId' = v_operation.public_id)
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_baseline) old_item
          WHERE old_item->>'publicId' <> v_operation.public_id
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) new_item
               WHERE new_item->>'publicId' = old_item->>'publicId' AND new_item = old_item
            )
       )
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) new_item
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_baseline) old_item
             WHERE old_item->>'publicId' = new_item->>'publicId' AND old_item = new_item
          )
       )
       OR pg_catalog.jsonb_array_length(v_candidate) <> pg_catalog.jsonb_array_length(v_baseline)
          - (CASE WHEN EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(v_baseline) item
               WHERE item->>'publicId' = v_operation.public_id
            ) THEN 1 ELSE 0 END)
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ARTIFACT_MISMATCH'); END IF;
    v_no_feed_change := v_operation.candidate_feed_hash = v_operation.baseline_feed_hash;
    IF v_project.status = 'published' THEN
      PERFORM pg_catalog.set_config('app.public_feed_operation_id', v_operation.id::text, true);
      UPDATE public.projects
         SET status = 'archived', archived_at = pg_catalog.now(), archived_from_status = 'published',
             archive_reason = v_operation.archive_reason, pending_removal_from_public = true,
             public_removal_completed_at = NULL
       WHERE id = v_project.id AND status = 'published';
      INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments)
      VALUES (
        v_project.id, v_operation.authorizing_actor_id, 'archive', 'published', 'archived', v_operation.archive_reason
      ) RETURNING id INTO v_audit_id;
    END IF;
    v_version_operation := 'removal';

  ELSIF v_operation.kind = 'rollback' THEN
    SELECT * INTO v_preparation FROM public.feed_rollback_preparations
     WHERE handle = v_operation.rollback_preparation_id FOR UPDATE;
    IF v_preparation.handle IS NULL OR v_preparation.operation_id IS DISTINCT FROM v_operation.id
       OR v_preparation.baseline_version_id IS DISTINCT FROM v_operation.baseline_version_id
       OR NOT EXISTS (
         SELECT 1 FROM public.public_feed_versions target
          WHERE target.id = v_preparation.target_version_id
            AND target.feed_hash = v_operation.candidate_feed_hash
            AND target.record_count = v_operation.candidate_record_count
            AND target.artifact_content = v_operation.candidate_feed_content
       )
       OR EXISTS (
         SELECT 1 FROM public.public_feed_version_members m
         LEFT JOIN public.projects p ON p.public_id = m.public_id AND p.deleted_at IS NULL
         WHERE m.version_id = v_preparation.target_version_id AND p.id IS NULL
       )
    THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_PREPARATION'); END IF;
    v_restored_from := v_preparation.target_version_id;
    v_version_operation := 'rollback';

  ELSE
    v_version_operation := 'baseline';
  END IF;

  IF NOT v_no_feed_change THEN
    INSERT INTO public.public_feed_versions(
      operation, publication_mode, operation_id, previous_version_id, restored_from_version_id,
      project_id, affected_public_id, authorizing_actor_id, completion_actor_id,
      artifact_content, byte_count, feed_hash, record_count, published_snapshot_id, audit_record_id
    ) VALUES (
      v_version_operation, v_operation.publication_mode, v_operation.id,
      v_operation.baseline_version_id, v_restored_from, v_operation.project_id,
      v_operation.public_id, v_operation.authorizing_actor_id, p_completion_actor_id,
      v_operation.candidate_feed_content, v_operation.candidate_byte_count,
      v_operation.candidate_feed_hash, v_operation.candidate_record_count,
      v_snapshot_id, v_audit_id
    ) RETURNING id, version_number INTO v_version_id, v_version_number;

    INSERT INTO public.public_feed_version_members(version_id, ordinal, public_id, record_hash)
    SELECT
      v_version_id, (member.value->>'ordinal')::integer,
      member.value->>'publicId', member.value->>'recordHash'
    FROM pg_catalog.jsonb_array_elements(v_operation.candidate_members) AS member(value);

    IF v_operation.kind = 'activation' THEN
      INSERT INTO public.public_feed_head(
        singleton, current_version_id, generation, activated_by_id, activated_at,
        transitioned_by_id, transitioned_at, rollback_enabled, last_operation_id
      ) VALUES (
        true, v_version_id, 1, v_operation.authorizing_actor_id, pg_catalog.now(),
        p_completion_actor_id, pg_catalog.now(), v_operation.rollback_capability_requested, v_operation.id
      );
    ELSE
      UPDATE public.public_feed_head
         SET current_version_id = v_version_id, generation = generation + 1,
             transitioned_by_id = p_completion_actor_id, transitioned_at = pg_catalog.now(),
             last_operation_id = v_operation.id
       WHERE singleton = true AND current_version_id = v_operation.baseline_version_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'PUBLIC_FEED_HEAD_CHANGED'; END IF;
    END IF;
  END IF;

  UPDATE public.public_feed_operations
     SET state = 'DB_FINALIZED', completion_actor_id = p_completion_actor_id,
         finalized_at = pg_catalog.now(), updated_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now() + interval '2 minutes'
   WHERE id = p_operation_id;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, 'CANDIDATE_OBSERVED', 'DB_FINALIZED', p_completion_actor_id, p_owner_epoch,
    v_operation.candidate_feed_hash, v_operation.candidate_record_count,
    CASE WHEN v_no_feed_change THEN 'NO_FEED_CHANGE' ELSE NULL END
  );
  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'DB_FINALIZED', 'versionId', v_version_id::text,
    'versionNumber', v_version_number, 'snapshotId', v_snapshot_id::text,
    'auditRecordId', v_audit_id::text, 'feedChanged', NOT v_no_feed_change
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_public_feed_operation(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid,
  p_observed_hash text,
  p_observed_record_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_operation public.public_feed_operations%ROWTYPE;
  v_head_version public.public_feed_versions%ROWTYPE;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF v_operation.state = 'COMPLETED' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPLETED'); END IF;
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  IF v_operation.state <> 'DB_FINALIZED' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_OPERATION_STATE'); END IF;
  SELECT v.* INTO v_head_version
    FROM public.public_feed_head h JOIN public.public_feed_versions v ON v.id = h.current_version_id
   WHERE h.singleton = true;
  IF v_head_version.id IS NULL
     OR v_head_version.feed_hash IS DISTINCT FROM p_observed_hash
     OR v_head_version.record_count IS DISTINCT FROM p_observed_record_count
     OR v_operation.candidate_feed_hash IS DISTINCT FROM p_observed_hash
     OR v_operation.candidate_record_count IS DISTINCT FROM p_observed_record_count
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OBSERVATION_MISMATCH'); END IF;
  UPDATE public.public_feed_operations
     SET state = 'COMPLETED', observed_storage_hash = p_observed_hash,
         observed_storage_record_count = p_observed_record_count,
         completed_at = pg_catalog.now(), updated_at = pg_catalog.now(),
         lease_expires_at = pg_catalog.now(), recovery_from_state = NULL
   WHERE id = p_operation_id;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, 'DB_FINALIZED', 'COMPLETED', p_actor_id, p_owner_epoch,
    p_observed_hash, p_observed_record_count
  );
  RETURN pg_catalog.jsonb_build_object('resultCode', 'COMPLETED');
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_public_feed_operation(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid,
  p_failure_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_operation public.public_feed_operations%ROWTYPE; v_code text := pg_catalog.btrim(COALESCE(p_failure_code, ''));
BEGIN
  IF v_code !~ '^[A-Z0-9_]{1,64}$' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  IF v_operation.state NOT IN ('RESERVED', 'PREPARED') THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'RECOVERY_REQUIRED');
  END IF;
  UPDATE public.public_feed_operations
     SET state = 'FAILED', failure_code = v_code, failed_at = pg_catalog.now(),
         updated_at = pg_catalog.now(), lease_expires_at = pg_catalog.now()
   WHERE id = p_operation_id;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, v_operation.state, 'FAILED', p_actor_id, p_owner_epoch, NULL, NULL, v_code
  );
  RETURN pg_catalog.jsonb_build_object('resultCode', 'FAILED');
END;
$$;

CREATE OR REPLACE FUNCTION public.require_public_feed_recovery(
  p_operation_id uuid,
  p_owner_epoch bigint,
  p_owner_token text,
  p_actor_id uuid,
  p_failure_code text,
  p_observed_hash text,
  p_observed_record_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_operation public.public_feed_operations%ROWTYPE; v_code text := pg_catalog.btrim(COALESCE(p_failure_code, ''));
BEGIN
  IF v_code !~ '^[A-Z0-9_]{1,64}$'
     OR (p_observed_hash IS NOT NULL AND p_observed_hash !~ '^[0-9a-f]{64}$')
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  SELECT * INTO v_operation FROM public.public_feed_operations WHERE id = p_operation_id FOR UPDATE;
  IF v_operation.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'OPERATION_NOT_FOUND'); END IF;
  IF NOT public.public_feed_owner_valid(p_operation_id, p_owner_epoch, p_owner_token, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_OWNER');
  END IF;
  UPDATE public.public_feed_operations
     SET state = 'RECOVERY_REQUIRED', failure_code = v_code,
         recovery_from_state = CASE
           WHEN v_operation.state = 'RECOVERY_REQUIRED' THEN v_operation.recovery_from_state
           ELSE v_operation.state
         END,
         observed_storage_hash = p_observed_hash,
         observed_storage_record_count = p_observed_record_count,
         updated_at = pg_catalog.now(), lease_expires_at = pg_catalog.now()
   WHERE id = p_operation_id;
  PERFORM public.append_public_feed_operation_event(
    p_operation_id, v_operation.state, 'RECOVERY_REQUIRED', p_actor_id, p_owner_epoch,
    p_observed_hash, p_observed_record_count, v_code
  );
  RETURN pg_catalog.jsonb_build_object('resultCode', 'RECOVERY_REQUIRED');
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_public_feed_rollback(
  p_admin_id uuid,
  p_target_version_number bigint,
  p_observed_storage_hash text,
  p_observed_storage_record_count integer,
  p_lifecycle_drift jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_head public.public_feed_head%ROWTYPE;
  v_baseline public.public_feed_versions%ROWTYPE;
  v_target public.public_feed_versions%ROWTYPE;
  v_handle uuid := gen_random_uuid();
  v_operation_key uuid := gen_random_uuid();
  v_acknowledgement text;
  v_diff jsonb;
  v_lifecycle jsonb;
BEGIN
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF p_target_version_number IS NULL OR p_target_version_number <= 0
     OR p_observed_storage_hash !~ '^[0-9a-f]{64}$'
     OR p_observed_storage_record_count < 0
     OR p_lifecycle_drift IS NULL OR pg_catalog.jsonb_typeof(p_lifecycle_drift) <> 'object'
     OR pg_catalog.octet_length(p_lifecycle_drift::text) > 32768
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_INPUT'); END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  IF EXISTS (
    SELECT 1 FROM public.public_feed_operations
     WHERE state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED')
  ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLICATION_IN_PROGRESS'); END IF;

  SELECT * INTO v_head FROM public.public_feed_head WHERE singleton = true FOR UPDATE;
  IF v_head.singleton IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'HISTORY_NOT_ACTIVE'); END IF;
  IF v_head.rollback_enabled IS DISTINCT FROM true THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ROLLBACK_UNAVAILABLE'); END IF;
  SELECT * INTO v_baseline FROM public.public_feed_versions WHERE id = v_head.current_version_id;
  SELECT * INTO v_target FROM public.public_feed_versions WHERE version_number = p_target_version_number;
  IF v_target.id IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'VERSION_NOT_FOUND'); END IF;
  IF v_target.id = v_baseline.id THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_CURRENT'); END IF;
  IF v_baseline.feed_hash IS DISTINCT FROM p_observed_storage_hash
     OR v_baseline.record_count IS DISTINCT FROM p_observed_storage_record_count
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_BASELINE'); END IF;
  IF EXISTS (
    SELECT 1 FROM public.public_feed_version_members m
    LEFT JOIN public.projects p ON p.public_id = m.public_id AND p.deleted_at IS NULL
    WHERE m.version_id = v_target.id AND p.id IS NULL
  ) THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ROLLBACK_TARGET_UNAVAILABLE'); END IF;

  SELECT pg_catalog.jsonb_build_object(
    'addedPublicIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(t.public_id ORDER BY t.ordinal)
      FROM public.public_feed_version_members t
      WHERE t.version_id = v_target.id AND NOT EXISTS (
        SELECT 1 FROM public.public_feed_version_members b
        WHERE b.version_id = v_baseline.id AND b.public_id = t.public_id
      )
    ), '[]'::jsonb),
    'removedPublicIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(b.public_id ORDER BY b.ordinal)
      FROM public.public_feed_version_members b
      WHERE b.version_id = v_baseline.id AND NOT EXISTS (
        SELECT 1 FROM public.public_feed_version_members t
        WHERE t.version_id = v_target.id AND t.public_id = b.public_id
      )
    ), '[]'::jsonb),
    'retainedUnchangedPublicIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(t.public_id ORDER BY t.ordinal)
      FROM public.public_feed_version_members t
      JOIN public.public_feed_version_members b
        ON b.version_id = v_baseline.id AND b.public_id = t.public_id
      WHERE t.version_id = v_target.id AND t.record_hash = b.record_hash
    ), '[]'::jsonb),
    'changedPublicIds', COALESCE((
      SELECT pg_catalog.jsonb_agg(t.public_id ORDER BY t.ordinal)
      FROM public.public_feed_version_members t
      JOIN public.public_feed_version_members b
        ON b.version_id = v_baseline.id AND b.public_id = t.public_id
      WHERE t.version_id = v_target.id AND t.record_hash <> b.record_hash
    ), '[]'::jsonb)
  ) INTO v_diff;

  SELECT pg_catalog.jsonb_build_object(
    'archivedTargetMembers', COALESCE((
      SELECT pg_catalog.jsonb_agg(m.public_id ORDER BY m.ordinal)
      FROM public.public_feed_version_members m
      JOIN public.projects p ON p.public_id = m.public_id AND p.deleted_at IS NULL
      WHERE m.version_id = v_target.id AND p.status = 'archived'
    ), '[]'::jsonb),
    'lifecyclePublishedOutsideTarget', COALESCE((
      SELECT pg_catalog.jsonb_agg(p.public_id ORDER BY p.public_id)
      FROM public.projects p
      WHERE p.deleted_at IS NULL AND p.status = 'published' AND NOT EXISTS (
        SELECT 1 FROM public.public_feed_version_members m
        WHERE m.version_id = v_target.id AND m.public_id = p.public_id
      )
    ), '[]'::jsonb),
    'currentRecordDrift', p_lifecycle_drift
  ) INTO v_lifecycle;

  v_acknowledgement := 'ROLL BACK PUBLIC FEED TO VERSION '
    || v_target.version_number::text || ' WITH HASH ' || v_target.feed_hash;

  INSERT INTO public.feed_rollback_preparations(
    handle, actor_id, target_version_id, target_feed_hash, target_record_count,
    baseline_version_id, baseline_feed_hash, baseline_record_count,
    diff_evidence, lifecycle_drift, acknowledgement_digest, operation_key,
    created_at, expires_at
  ) VALUES (
    v_handle, p_admin_id, v_target.id, v_target.feed_hash, v_target.record_count,
    v_baseline.id, v_baseline.feed_hash, v_baseline.record_count,
    v_diff, v_lifecycle,
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_acknowledgement, 'UTF8'), 'sha256'), 'hex'),
    v_operation_key, pg_catalog.now(), pg_catalog.now() + interval '10 minutes'
  );

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'PREPARED', 'preparationHandle', v_handle::text,
    'targetVersionNumber', v_target.version_number,
    'targetHash', v_target.feed_hash, 'targetRecordCount', v_target.record_count,
    'currentVersionNumber', v_baseline.version_number,
    'currentHash', v_baseline.feed_hash, 'currentRecordCount', v_baseline.record_count,
    'diff', v_diff, 'lifecycleDrift', v_lifecycle,
    'requiredAcknowledgement', v_acknowledgement,
    'expiresAt', pg_catalog.now() + interval '10 minutes'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_active_public_feed_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_other_project_id uuid;
  v_operation_id uuid;
  v_marker text;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    v_project_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME IN ('media_assets', 'participant_previews', 'project_disciplines', 'project_industry_categories') THEN
    v_project_id := COALESCE(NEW.project_id, OLD.project_id);
    IF TG_OP = 'UPDATE' THEN v_other_project_id := OLD.project_id; END IF;
  ELSIF TG_TABLE_NAME IN ('participant_preview_confirmations', 'participant_preview_correction_requests') THEN
    SELECT pp.project_id INTO v_project_id FROM public.participant_previews pp
     WHERE pp.id = COALESCE(NEW.participant_preview_id, OLD.participant_preview_id);
  END IF;

  v_marker := pg_catalog.current_setting('app.public_feed_operation_id', true);
  SELECT o.id INTO v_operation_id
    FROM public.public_feed_operations o
   WHERE o.project_id = v_project_id
     AND o.state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED')
   LIMIT 1;
  IF v_operation_id IS NOT NULL AND COALESCE(v_marker, '') <> v_operation_id::text THEN
    RAISE EXCEPTION 'PUBLIC_FEED_OPERATION_IN_PROGRESS';
  END IF;

  IF v_other_project_id IS NOT NULL AND v_other_project_id IS DISTINCT FROM v_project_id THEN
    SELECT o.id INTO v_operation_id
      FROM public.public_feed_operations o
     WHERE o.project_id = v_other_project_id
       AND o.state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED')
     LIMIT 1;
    IF v_operation_id IS NOT NULL AND COALESCE(v_marker, '') <> v_operation_id::text THEN
      RAISE EXCEPTION 'PUBLIC_FEED_OPERATION_IN_PROGRESS';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_projects_during_public_feed_operation
  BEFORE UPDATE OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_operation();
CREATE TRIGGER guard_media_during_public_feed_operation
  BEFORE INSERT OR UPDATE OR DELETE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_operation();
CREATE TRIGGER guard_previews_during_public_feed_operation
  BEFORE INSERT OR UPDATE OR DELETE ON public.participant_previews
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_operation();
CREATE TRIGGER guard_confirmations_during_public_feed_operation
  BEFORE INSERT OR UPDATE OR DELETE ON public.participant_preview_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_operation();
CREATE TRIGGER guard_corrections_during_public_feed_operation
  BEFORE INSERT OR UPDATE OR DELETE ON public.participant_preview_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_operation();
CREATE TRIGGER guard_disciplines_during_public_feed_operation
  BEFORE INSERT OR UPDATE OR DELETE ON public.project_disciplines
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_operation();
CREATE TRIGGER guard_industries_during_public_feed_operation
  BEFORE INSERT OR UPDATE OR DELETE ON public.project_industry_categories
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_operation();

-- The pre-ledger RPC family remains only as historical evidence. Every entry point now fails
-- closed so no caller can establish a competing writer authority or run reverse compensation.
CREATE OR REPLACE FUNCTION public.reserve_publication_attempt(
  p_public_id text, p_admin_id uuid, p_private_bucket text,
  p_confirmed_preview_id uuid, p_confirmed_at timestamptz
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.prepare_publication_attempt(
  p_attempt_id uuid, p_execution_token uuid, p_private_bucket text,
  p_candidate_record_count integer, p_candidate_feed_hash text, p_candidate_feed_content text,
  p_feed_storage_bucket text, p_feed_storage_path text, p_feed_public_url text,
  p_previous_feed_existed boolean, p_previous_feed_content text, p_media_manifest jsonb
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.claim_publication_attempt(p_public_id text, p_admin_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.mark_publication_attempt_storage_written(
  p_attempt_id uuid, p_execution_token uuid,
  p_verified_feed_hash text, p_verified_record_count integer
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.finalize_publication_attempt(
  p_attempt_id uuid, p_execution_token uuid, p_private_bucket text
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.fail_publication_attempt(
  p_attempt_id uuid, p_execution_token uuid,
  p_failure_code text, p_compensation_failure_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.reserve_public_removal_attempt(
  p_public_id text, p_admin_id uuid, p_archive_reason text
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.prepare_public_removal_attempt(
  p_attempt_id uuid, p_execution_token uuid, p_candidate_record_count integer,
  p_candidate_feed_hash text, p_candidate_feed_content text,
  p_feed_storage_bucket text, p_feed_storage_path text, p_feed_public_url text,
  p_previous_feed_existed boolean, p_previous_feed_content text
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.claim_public_removal_attempt(p_public_id text, p_admin_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.mark_public_removal_storage_written(
  p_attempt_id uuid, p_execution_token uuid,
  p_verified_feed_hash text, p_verified_record_count integer
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.finalize_public_removal_attempt(
  p_attempt_id uuid, p_execution_token uuid
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;
CREATE OR REPLACE FUNCTION public.fail_public_removal_attempt(
  p_attempt_id uuid, p_execution_token uuid,
  p_failure_code text, p_compensation_failure_code text DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.jsonb_build_object('resultCode', 'LEDGER_PROTOCOL_REQUIRED') $$;

REVOKE ALL ON FUNCTION public.public_feed_actor_is_admin(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.public_feed_owner_valid(uuid,bigint,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_public_feed_operation_event(uuid,text,text,uuid,bigint,text,integer,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_active_public_feed_operation() FROM PUBLIC, anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.reserve_public_feed_operation(uuid,text,text,uuid,text,text,uuid,timestamptz,text,text,uuid,text,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_public_feed_operation(uuid,bigint,text,uuid,uuid,boolean,text,integer,text,text,integer,text,jsonb,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_public_feed_operation_lease(uuid,bigint,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_public_feed_write_started(uuid,bigint,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_public_feed_candidate_observed(uuid,bigint,text,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_public_feed_operation(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_public_feed_operation(uuid,bigint,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_public_feed_operation(uuid,bigint,text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.require_public_feed_recovery(uuid,bigint,text,uuid,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_public_feed_rollback(uuid,bigint,text,integer,jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_public_feed_operation(uuid,text,text,uuid,text,text,uuid,timestamptz,text,text,uuid,text,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_public_feed_operation(uuid,bigint,text,uuid,uuid,boolean,text,integer,text,text,integer,text,jsonb,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_public_feed_operation_lease(uuid,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_public_feed_write_started(uuid,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_public_feed_candidate_observed(uuid,bigint,text,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_public_feed_operation(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_public_feed_operation(uuid,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_public_feed_operation(uuid,bigint,text,uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_public_feed_operation(uuid,bigint,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.require_public_feed_recovery(uuid,bigint,text,uuid,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_public_feed_rollback(uuid,bigint,text,integer,jsonb) TO service_role;

COMMIT;
