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
  v_has_review boolean;
  v_project RECORD;
  v_active_preview RECORD;
  v_active_preview_count integer;
  v_confirmation RECORD;
  v_active_corr_count integer;
  v_unresolved_corr_count integer;
  v_replacement_count integer;
  v_invalid_media_element_count integer;
  v_snapshot_count integer;
  v_valid_snapshot_count integer;
  v_distinct_snapshot_positions integer;
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

  -- 4c. Current authoritative snapshot-gallery integrity.
  --
  -- Zero snapshots is valid. If snapshots exist, every authoritative row
  -- must remain valid private staged media with a unique bounded position.
  -- This gate prevents contradictory rows from being filtered out of the
  -- current media snapshot used for participant-confirmation comparison.
  SELECT
    pg_catalog.count(*),

    pg_catalog.count(*) FILTER (
      WHERE
        ma.storage_bucket = v_private_bucket
        AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
        AND pg_catalog.left(
              ma.storage_path,
              pg_catalog.length(
                'drafts/' || v_public_id || '/snapshot_image/'
              )
            ) =
            'drafts/' || v_public_id || '/snapshot_image/'
        AND pg_catalog.right(
              ma.storage_path,
              pg_catalog.length(ma.file_name)
            ) = ma.file_name
        AND pg_catalog.strpos(ma.storage_path, '..') = 0
        AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
        AND ma.file_name = pg_catalog.btrim(ma.file_name)
        AND ma.file_name <> ''
        AND pg_catalog.strpos(ma.file_name, '..') = 0
        AND pg_catalog.strpos(ma.file_name, '/') = 0
        AND pg_catalog.strpos(ma.file_name, E'\\') = 0
        AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
        AND ma.file_size_bytes BETWEEN 1 AND 5242880
        AND ma.is_public_approved = false
        AND ma.public_url IS NULL
        AND ma.public_storage_bucket IS NULL
        AND ma.public_storage_path IS NULL
        AND ma.gallery_position BETWEEN 1 AND 10
    ),

    pg_catalog.count(DISTINCT ma.gallery_position)

    INTO
      v_snapshot_count,
      v_valid_snapshot_count,
      v_distinct_snapshot_positions

    FROM public.media_assets ma
   WHERE ma.project_id = v_project.id
     AND ma.asset_type = 'snapshot_image';

  IF v_snapshot_count > 10
     OR v_valid_snapshot_count <> v_snapshot_count
     OR v_distinct_snapshot_positions <> v_snapshot_count
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'READINESS_UNAVAILABLE',
      'blockers',
        pg_catalog.to_jsonb(
          ARRAY['Current snapshot media state is malformed']
        )
    );
  END IF;

  -- Accessibility is evaluated over the whole authoritative gallery.
  IF EXISTS (
    SELECT 1
      FROM public.media_assets ma
     WHERE ma.project_id = v_project.id
       AND ma.asset_type = 'snapshot_image'
       AND pg_catalog.btrim(
             COALESCE(ma.alt_text_public, '')
           ) = ''
  ) THEN
    v_accessibility_blockers :=
      pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot image alt text is missing'
      );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.media_assets ma
     WHERE ma.project_id = v_project.id
       AND ma.asset_type = 'snapshot_image'
       AND pg_catalog.length(
             pg_catalog.btrim(
               COALESCE(ma.alt_text_public, '')
             )
           ) > 2000
  ) THEN
    v_accessibility_blockers :=
      pg_catalog.array_append(
        v_accessibility_blockers,
        'Snapshot image alt text exceeds the 2,000 character safety limit'
      );
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

COMMIT;
