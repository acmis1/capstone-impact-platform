-- Migration 0028: require canonical private project media before approval.
--
-- Browser imports and the supported staging-package importer both register poster media in
-- media_assets while the objects remain private. Approval is a workflow decision only: public
-- media mapping and project poster URLs remain owned by controlled publication.

BEGIN;

-- Forward-redefined from 20260814140000_snapshot_image_alt_text.sql, the current authoritative
-- definition. Every inherited transition, authorization, participant-preview correction,
-- accessibility, archive, audit and transaction rule is retained. The only addition is the
-- pre-mutation media gate inside the approve branch.
CREATE OR REPLACE FUNCTION public.perform_project_review_action(p_public_id text, p_action text, p_comments text, p_admin_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_public_id text; v_comments text; v_roles text[]; v_project_id uuid; v_from_status text;
  v_to_status text; v_archive_reason text; v_now timestamptz; v_audit_record_id uuid;
  v_unresolved integer; v_active integer;
  v_poster_text text; v_accessibility_text text;
  v_media_count integer;
  v_valid_media_count integer;
  v_distinct_gallery_positions integer;
  v_missing_snapshot_alt_count integer;
  v_invalid_snapshot_alt_count integer;
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
  IF p_action = 'approve' THEN
    IF pg_catalog.btrim(COALESCE(v_poster_text, '')) = ''
       OR pg_catalog.btrim(COALESCE(v_accessibility_text, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED');
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(v_poster_text)) > 20000
       OR pg_catalog.length(pg_catalog.btrim(v_accessibility_text)) > 2000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_INVALID');
    END IF;

    -- Stabilize this project's current media rows before deriving authority. The locked project row
    -- also prevents a concurrent new child row from completing its foreign-key check until this
    -- transaction ends, so the checks and status mutation observe one coherent project/media state.
    PERFORM ma.id FROM public.media_assets ma
     WHERE ma.project_id = v_project_id
     ORDER BY ma.id
     FOR UPDATE;

    SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE
      ma.storage_bucket = 'project-drafts-private'
      AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
      AND pg_catalog.left(ma.storage_path, pg_catalog.length('drafts/' || v_public_id || '/poster_image/')) = 'drafts/' || v_public_id || '/poster_image/'
      AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
      AND pg_catalog.strpos(ma.storage_path, '..') = 0 AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
      AND ma.file_name = pg_catalog.btrim(ma.file_name) AND ma.file_name <> ''
      AND pg_catalog.strpos(ma.file_name, '..') = 0 AND pg_catalog.strpos(ma.file_name, '/') = 0 AND pg_catalog.strpos(ma.file_name, E'\\') = 0
      AND ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
      AND ma.file_size_bytes BETWEEN 1 AND 5242880
      AND ma.is_public_approved = false AND ma.public_url IS NULL
      AND ma.public_storage_bucket IS NULL AND ma.public_storage_path IS NULL
    ) INTO v_media_count, v_valid_media_count
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id AND ma.asset_type = 'poster_image';
    IF v_media_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_REQUIRED', 'assetType', 'poster_image');
    END IF;
    IF v_media_count <> 1 OR v_valid_media_count <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_INVALID', 'assetType', 'poster_image');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE
      ma.storage_bucket = 'project-drafts-private'
      AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
      AND pg_catalog.left(ma.storage_path, pg_catalog.length('drafts/' || v_public_id || '/poster_pdf/')) = 'drafts/' || v_public_id || '/poster_pdf/'
      AND pg_catalog.right(ma.storage_path, pg_catalog.length(ma.file_name)) = ma.file_name
      AND pg_catalog.strpos(ma.storage_path, '..') = 0 AND pg_catalog.strpos(ma.storage_path, E'\\') = 0
      AND ma.file_name = pg_catalog.btrim(ma.file_name) AND ma.file_name <> ''
      AND pg_catalog.strpos(ma.file_name, '..') = 0 AND pg_catalog.strpos(ma.file_name, '/') = 0 AND pg_catalog.strpos(ma.file_name, E'\\') = 0
      AND ma.mime_type = 'application/pdf'
      AND ma.file_size_bytes BETWEEN 1 AND 20971520
      AND ma.is_public_approved = false AND ma.public_url IS NULL
      AND ma.public_storage_bucket IS NULL AND ma.public_storage_path IS NULL
    ) INTO v_media_count, v_valid_media_count
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id AND ma.asset_type = 'poster_pdf';
    IF v_media_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_REQUIRED', 'assetType', 'poster_pdf');
    END IF;
    IF v_media_count <> 1 OR v_valid_media_count <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_MEDIA_INVALID', 'assetType', 'poster_pdf');
    END IF;

    SELECT
        pg_catalog.count(*),

        pg_catalog.count(*) FILTER (
            WHERE
            ma.storage_bucket = 'project-drafts-private'
            AND ma.storage_path = pg_catalog.btrim(ma.storage_path)
            AND pg_catalog.left(
                ma.storage_path,
                pg_catalog.length('drafts/' || v_public_id || '/snapshot_image/')
            ) = 'drafts/' || v_public_id || '/snapshot_image/'
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

        pg_catalog.count(DISTINCT ma.gallery_position),

        pg_catalog.count(*) FILTER (
            WHERE pg_catalog.btrim(
            COALESCE(ma.alt_text_public, '')
            ) = ''
        ),

        pg_catalog.count(*) FILTER (
            WHERE ma.alt_text_public IS NOT NULL
            AND pg_catalog.length(
                pg_catalog.btrim(ma.alt_text_public)
            ) > 2000
        )

        INTO
        v_media_count,
        v_valid_media_count,
        v_distinct_gallery_positions,
        v_missing_snapshot_alt_count,
        v_invalid_snapshot_alt_count

        FROM public.media_assets ma
        WHERE ma.project_id = v_project_id
        AND ma.asset_type = 'snapshot_image';

        -- Snapshot gallery remains optional.
        IF v_media_count > 0 THEN

        -- Every snapshot must be valid private media and must carry a unique,
        -- authoritative position in the bounded gallery.
        IF v_media_count > 10
            OR v_valid_media_count <> v_media_count
            OR v_distinct_gallery_positions <> v_media_count THEN

            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'PROJECT_MEDIA_INVALID',
            'assetType',
            'snapshot_image'
            );
        END IF;

        -- Every gallery image requires its own authoritative alt text.
        IF v_missing_snapshot_alt_count > 0 THEN
            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'MEDIA_ACCESSIBILITY_REQUIRED'
            );
        END IF;

        IF v_invalid_snapshot_alt_count > 0 THEN
            RETURN pg_catalog.jsonb_build_object(
            'resultCode',
            'MEDIA_ACCESSIBILITY_INVALID'
            );
        END IF;

    END IF;

    SELECT ma.alt_text_public INTO v_snapshot
      FROM public.media_assets ma
     WHERE ma.project_id = v_project_id AND ma.asset_type = 'snapshot_image';
    IF FOUND AND pg_catalog.btrim(COALESCE(v_snapshot.alt_text_public, '')) = '' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'MEDIA_ACCESSIBILITY_REQUIRED');
    END IF;
    IF FOUND AND pg_catalog.length(pg_catalog.btrim(v_snapshot.alt_text_public)) > 2000 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'MEDIA_ACCESSIBILITY_INVALID');
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

COMMIT;
