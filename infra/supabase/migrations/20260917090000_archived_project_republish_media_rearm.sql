-- Migration 0060: rearm retained media for normal republishing after a published-origin restore.
--
-- Migration 0059 remains the authority for restore state, archive provenance, completed-removal
-- evidence and current-feed absence. This wrapper adds the established staff-lifecycle authority
-- before M59's writer path, then acts only after M59 has completed a successful restore and written
-- its immutable audit evidence. The media update is in the same transaction, so any failure rolls
-- the lifecycle change and audit back with it. Public Storage objects and all history are retained.

BEGIN;

ALTER FUNCTION public.perform_project_review_action(text, text, text, uuid)
  RENAME TO perform_project_review_action_without_media_rearm;

REVOKE ALL ON FUNCTION public.perform_project_review_action_without_media_rearm(text, text, text, uuid)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.perform_project_review_action(
  p_public_id text,
  p_action text,
  p_comments text,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_public_id text;
  v_comments text;
  v_project_id uuid;
  v_archive_origin text;
  v_republish_required boolean;
BEGIN
  IF p_action IS DISTINCT FROM 'restore' THEN
    RETURN public.perform_project_review_action_without_media_rearm(
      p_public_id,
      p_action,
      p_comments,
      p_admin_id
    );
  END IF;

  -- Preserve M59's validation/error ordering before adding the stronger lifecycle authority check.
  IF p_public_id IS NULL THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' THEN RAISE EXCEPTION 'REVIEW_PUBLIC_ID_REQUIRED'; END IF;
  IF pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'REVIEW_PUBLIC_ID_INVALID';
  END IF;
  v_comments := NULLIF(pg_catalog.btrim(COALESCE(p_comments, '')), '');
  IF v_comments IS NOT NULL AND pg_catalog.length(v_comments) > 4000 THEN
    RAISE EXCEPTION 'REVIEW_COMMENTS_TOO_LONG';
  END IF;
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'REVIEW_ADMIN_ID_REQUIRED'; END IF;

  -- The canonical helper holds the staff-lifecycle advisory lock and actor FOR SHARE lock. Acquire
  -- it before the writer lock so a role/lifecycle transition cannot be captured before a wait and
  -- used afterward. The participant-preview lock follows the writer lock, matching normal publish.
  IF NOT public.public_feed_actor_is_admin(p_admin_id) THEN
    RAISE EXCEPTION 'REVIEW_PERMISSION_DENIED';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('participant_preview:' || v_public_id)
  );

  -- This call performs every M59 proof and reacquires its transaction-scoped writer lock before its
  -- project lock. A refusal result returns before any media or participant-preview row can change.
  v_result := public.perform_project_review_action_without_media_rearm(
    p_public_id,
    p_action,
    p_comments,
    p_admin_id
  );

  IF v_result->>'auditRecordId' IS NULL THEN
    RETURN v_result;
  END IF;

  -- Trust only the restore audit written by the successful inner authority in this transaction.
  -- Missing or contradictory success evidence raises and rolls the entire restore back.
  SELECT
    audit.project_id,
    audit.event_details->>'archivedFromStatus',
    (audit.event_details->>'republishRequired')::boolean
    INTO v_project_id, v_archive_origin, v_republish_required
    FROM public.approval_records audit
    JOIN public.projects project ON project.id = audit.project_id
   WHERE audit.id::text = v_result->>'auditRecordId'
     AND audit.action_taken = 'restore'
     AND audit.from_status = 'archived'
     AND audit.to_status = v_result->>'status'
     AND audit.event_details->>'type' = 'archived_project_restore'
     AND audit.event_details->>'restoredStatus' = v_result->>'status'
     AND project.public_id = v_result->>'publicId'
     AND project.status = v_result->>'status';

  IF v_project_id IS NULL
     OR v_archive_origin NOT IN ('submitted', 'in_review', 'approved', 'published')
     OR v_republish_required IS DISTINCT FROM (v_archive_origin = 'published')
  THEN
    RAISE EXCEPTION 'RESTORE_AUDIT_EVIDENCE_INVALID';
  END IF;

  IF v_archive_origin = 'published' THEN
    -- Stabilize child media in deterministic order after M59's project lock. The parent FOR UPDATE
    -- lock also prevents a concurrent child insert from completing its foreign-key check.
    PERFORM media.id
      FROM public.media_assets media
     WHERE media.project_id = v_project_id
     ORDER BY media.id
     FOR UPDATE;

    -- A published-origin restore must produce one coherent private workflow mapping for every
    -- retained source row or fail atomically. Partial publication mappings are never guessed at.
    IF NOT EXISTS (
      SELECT 1 FROM public.media_assets media WHERE media.project_id = v_project_id
    ) OR EXISTS (
      SELECT 1
        FROM public.media_assets media
       WHERE media.project_id = v_project_id
         AND (
           pg_catalog.btrim(COALESCE(media.storage_bucket, '')) = ''
           OR pg_catalog.btrim(COALESCE(media.storage_path, '')) = ''
           OR NOT (
             (
               media.is_public_approved IS TRUE
               AND pg_catalog.btrim(COALESCE(media.public_url, '')) <> ''
               AND pg_catalog.btrim(COALESCE(media.public_storage_bucket, '')) <> ''
               AND pg_catalog.btrim(COALESCE(media.public_storage_path, '')) <> ''
             )
             OR (
               media.is_public_approved IS FALSE
               AND media.public_url IS NULL
               AND media.public_storage_bucket IS NULL
               AND media.public_storage_path IS NULL
             )
           )
         )
    ) THEN
      RAISE EXCEPTION 'RESTORE_MEDIA_EVIDENCE_INVALID';
    END IF;

    UPDATE public.media_assets
       SET is_public_approved = false,
           public_url = NULL,
           public_storage_bucket = NULL,
           public_storage_path = NULL
     WHERE project_id = v_project_id
       AND (
         is_public_approved IS DISTINCT FROM false
         OR public_url IS NOT NULL
         OR public_storage_bucket IS NOT NULL
         OR public_storage_path IS NOT NULL
        );

    -- A published-origin restore is a new participant-authorization generation. Retain the preview,
    -- confirmation and access evidence, but make every pre-restore token permanently non-authorizing.
    UPDATE public.participant_previews
       SET status = 'revoked',
           revoked_at = pg_catalog.now(),
           revoked_by = p_admin_id
     WHERE project_id = v_project_id
       AND status = 'active';
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.perform_project_review_action(text, text, text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid)
TO service_role;

-- PostgreSQL versions used by disposable and hosted Supabase do not all expose
-- pg_input_is_valid. Keep malformed candidate text fail-closed behind this owner-only parser.
CREATE FUNCTION public.parse_archived_republish_candidate_json(p_content text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN p_content::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.parse_archived_republish_candidate_json(text)
FROM PUBLIC, anon, authenticated, service_role;

-- M59 was already deployed before this hotfix. Keep the one-time repair decision callable only by
-- the database owner so the migration can reconcile that exact state and disposable verification
-- can prove replay is idempotent. Application roles cannot invoke this invoker-rights helper.
CREATE FUNCTION public.reconcile_archived_project_republish_media()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_project public.projects%ROWTYPE;
  v_restore public.approval_records%ROWTYPE;
  v_archive public.approval_records%ROWTYPE;
  v_operation public.public_feed_operations%ROWTYPE;
  v_baseline_version public.public_feed_versions%ROWTYPE;
  v_removal_version public.public_feed_versions%ROWTYPE;
  v_candidate jsonb;
  v_baseline jsonb;
  v_expected_candidate jsonb;
  v_count integer;
  v_target_baseline_count integer;
  v_expected_event_count integer;
  v_finalized_sequence integer;
  v_completed_sequence integer;
  v_changed_rows integer;
  v_rearmed_rows integer := 0;
  v_no_feed_change boolean;
BEGIN
  -- Canonical writer first. Project and media rows are locked below in stable identifier order,
  -- matching writer/review authorities and preventing stale eligibility decisions after lock waits.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_canonical_writer')
  );

  IF EXISTS (
    SELECT 1
      FROM public.public_feed_operations operation
     WHERE operation.state IN (
       'RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED',
       'DB_FINALIZED', 'RECOVERY_REQUIRED'
     )
  ) OR EXISTS (
    SELECT 1 FROM public.publication_attempts attempt
     WHERE attempt.state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
  ) OR EXISTS (
    SELECT 1 FROM public.public_removal_attempts attempt
     WHERE attempt.state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
  ) THEN
    RETURN 0;
  END IF;

  -- Lock every currently plausible project before any child media row. READ COMMITTED row-lock
  -- re-evaluation drops a project archived or tombstoned while this statement was waiting.
  PERFORM project.id
    FROM public.projects project
   WHERE project.status = 'approved'
     AND project.deleted_at IS NULL
     AND project.archived_at IS NULL
     AND project.archived_from_status IS NULL
     AND project.archive_reason IS NULL
     AND project.pending_removal_from_public IS FALSE
     AND project.public_removal_completed_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.media_assets media
        WHERE media.project_id = project.id
          AND (
            media.is_public_approved IS DISTINCT FROM false
            OR media.public_url IS NOT NULL
            OR media.public_storage_bucket IS NOT NULL
            OR media.public_storage_path IS NOT NULL
          )
     )
   ORDER BY project.id
   FOR UPDATE;

  FOR v_project_id IN
    SELECT project.id
      FROM public.projects project
     WHERE project.status = 'approved'
       AND project.deleted_at IS NULL
       AND project.archived_at IS NULL
       AND project.archived_from_status IS NULL
       AND project.archive_reason IS NULL
       AND project.pending_removal_from_public IS FALSE
       AND project.public_removal_completed_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.media_assets media
          WHERE media.project_id = project.id
            AND (
              media.is_public_approved IS DISTINCT FROM false
              OR media.public_url IS NOT NULL
              OR media.public_storage_bucket IS NOT NULL
              OR media.public_storage_path IS NOT NULL
            )
       )
     ORDER BY project.id
  LOOP
    PERFORM media.id
      FROM public.media_assets media
     WHERE media.project_id = v_project_id
     ORDER BY media.id
     FOR UPDATE;

    -- Re-read every mutable eligibility field after both lock waits. Direct media edits that did
    -- not take the parent lock are now visible and stable for the rest of this transaction.
    SELECT * INTO v_project
      FROM public.projects project
     WHERE project.id = v_project_id;
    IF v_project.id IS NULL
       OR v_project.status <> 'approved'
       OR v_project.deleted_at IS NOT NULL
       OR v_project.archived_at IS NOT NULL
       OR v_project.archived_from_status IS NOT NULL
       OR v_project.archive_reason IS NOT NULL
       OR v_project.pending_removal_from_public IS DISTINCT FROM false
       OR v_project.public_removal_completed_at IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.public_feed_head head WHERE head.singleton = true)
       OR EXISTS (
         SELECT 1
           FROM public.public_feed_head head
           JOIN public.public_feed_version_members member
             ON member.version_id = head.current_version_id
          WHERE head.singleton = true
            AND member.public_id = v_project.public_id
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.media_assets media WHERE media.project_id = v_project.id
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.media_assets media
          WHERE media.project_id = v_project.id
            AND (
              media.is_public_approved IS DISTINCT FROM false
              OR media.public_url IS NOT NULL
              OR media.public_storage_bucket IS NOT NULL
              OR media.public_storage_path IS NOT NULL
            )
       )
       OR EXISTS (
         SELECT 1
           FROM public.media_assets media
          WHERE media.project_id = v_project.id
            AND (
              pg_catalog.btrim(COALESCE(media.storage_bucket, '')) = ''
              OR pg_catalog.btrim(COALESCE(media.storage_path, '')) = ''
              OR NOT (
                (
                  media.is_public_approved IS TRUE
                  AND pg_catalog.btrim(COALESCE(media.public_url, '')) <> ''
                  AND pg_catalog.btrim(COALESCE(media.public_storage_bucket, '')) <> ''
                  AND pg_catalog.btrim(COALESCE(media.public_storage_path, '')) <> ''
                )
                OR (
                  media.is_public_approved IS FALSE
                  AND media.public_url IS NULL
                  AND media.public_storage_bucket IS NULL
                  AND media.public_storage_path IS NULL
                )
              )
            )
       )
    THEN
      CONTINUE;
    END IF;

    SELECT pg_catalog.count(*) INTO v_count
      FROM public.approval_records restore_count
     WHERE restore_count.project_id = v_project.id
       AND restore_count.action_taken = 'restore';
    IF v_count <> 1 THEN CONTINUE; END IF;
    SELECT * INTO v_restore
      FROM public.approval_records restore
     WHERE restore.project_id = v_project.id
       AND restore.action_taken = 'restore';
    IF v_restore.from_status IS DISTINCT FROM 'archived'
       OR v_restore.to_status IS DISTINCT FROM 'approved'
       OR v_restore.event_details IS DISTINCT FROM pg_catalog.jsonb_build_object(
         'version', 1,
         'type', 'archived_project_restore',
         'archivedFromStatus', 'published',
         'restoredStatus', 'approved',
         'republishRequired', true
       )
    THEN CONTINUE; END IF;

    SELECT pg_catalog.count(*) INTO v_count
      FROM public.approval_records archive_count
     WHERE archive_count.project_id = v_project.id
       AND archive_count.action_taken = 'archive';
    IF v_count <> 1 THEN CONTINUE; END IF;
    SELECT * INTO v_archive
      FROM public.approval_records archive
     WHERE archive.project_id = v_project.id
       AND archive.action_taken = 'archive';
    IF v_archive.from_status IS DISTINCT FROM 'published'
       OR v_archive.to_status IS DISTINCT FROM 'archived'
       OR v_archive.created_at > v_restore.created_at
    THEN CONTINUE; END IF;

    -- Never choose a matching completed removal from a larger history. One project/public-id pair,
    -- one completed removal and one project completion timestamp must identify the same operation.
    SELECT pg_catalog.count(*) INTO v_count
      FROM public.public_feed_operations operation
     WHERE operation.project_id = v_project.id
       AND operation.public_id = v_project.public_id
       AND operation.kind = 'removal'
       AND operation.state = 'COMPLETED'
       AND operation.completed_at IS NOT NULL;
    IF v_count <> 1 THEN CONTINUE; END IF;
    SELECT * INTO v_operation
      FROM public.public_feed_operations operation
     WHERE operation.project_id = v_project.id
       AND operation.public_id = v_project.public_id
       AND operation.kind = 'removal'
       AND operation.state = 'COMPLETED'
       AND operation.completed_at IS NOT NULL;
    IF v_operation.completed_at IS DISTINCT FROM v_project.public_removal_completed_at
       OR v_operation.finalized_at IS NULL
       OR v_operation.completed_at < v_operation.finalized_at
       OR v_operation.finalized_at < v_archive.created_at
       OR v_operation.completed_at > v_restore.created_at
       OR v_operation.failure_code IS NOT NULL
       OR v_operation.completion_actor_id IS NULL
       OR v_archive.admin_id IS DISTINCT FROM v_operation.authorizing_actor_id
       OR v_operation.baseline_version_id IS NULL
       OR v_operation.baseline_storage_existed IS DISTINCT FROM true
       OR v_operation.baseline_feed_content IS NULL
       OR v_operation.baseline_feed_hash IS NULL
       OR v_operation.baseline_record_count IS NULL
       OR v_operation.candidate_feed_content IS NULL
       OR v_operation.candidate_feed_hash IS NULL
       OR v_operation.candidate_record_count IS NULL
       OR v_operation.candidate_byte_count IS DISTINCT FROM
          pg_catalog.octet_length(v_operation.candidate_feed_content)
       OR v_operation.candidate_feed_hash IS DISTINCT FROM pg_catalog.encode(
         extensions.digest(
           pg_catalog.convert_to(v_operation.candidate_feed_content, 'UTF8'),
           'sha256'
         ),
         'hex'
       )
       OR v_operation.baseline_feed_hash IS DISTINCT FROM pg_catalog.encode(
         extensions.digest(
           pg_catalog.convert_to(v_operation.baseline_feed_content, 'UTF8'),
           'sha256'
         ),
         'hex'
       )
       OR v_operation.observed_storage_hash IS DISTINCT FROM v_operation.candidate_feed_hash
       OR v_operation.observed_storage_record_count IS DISTINCT FROM
          v_operation.candidate_record_count
    THEN CONTINUE; END IF;

    v_candidate := public.parse_archived_republish_candidate_json(
      v_operation.candidate_feed_content
    );
    v_baseline := public.parse_archived_republish_candidate_json(
      v_operation.baseline_feed_content
    );
    IF pg_catalog.jsonb_typeof(v_candidate) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(v_operation.candidate_members) IS DISTINCT FROM 'array'
    THEN CONTINUE; END IF;
    IF pg_catalog.jsonb_array_length(v_candidate) <> v_operation.candidate_record_count
       OR pg_catalog.jsonb_array_length(v_baseline) <> v_operation.baseline_record_count
       OR pg_catalog.jsonb_array_length(v_operation.candidate_members) <>
          v_operation.candidate_record_count
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_candidate) item
          WHERE pg_catalog.jsonb_typeof(item) <> 'object'
             OR COALESCE(item->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
       )
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_baseline) item
          WHERE pg_catalog.jsonb_typeof(item) <> 'object'
             OR COALESCE(item->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
       )
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_candidate)) <>
          (SELECT pg_catalog.count(DISTINCT item->>'publicId')
             FROM pg_catalog.jsonb_array_elements(v_candidate) item)
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(v_baseline)) <>
          (SELECT pg_catalog.count(DISTINCT item->>'publicId')
             FROM pg_catalog.jsonb_array_elements(v_baseline) item)
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(v_operation.candidate_members)
             WITH ORDINALITY member(value, ordinality)
          WHERE pg_catalog.jsonb_typeof(member.value) <> 'object'
             OR COALESCE(member.value->>'publicId', '') !~ '^[A-Za-z0-9_-]{1,100}$'
             OR COALESCE(member.value->>'recordHash', '') !~ '^[0-9a-f]{64}$'
             OR CASE
               -- At most ten decimal digits can be converted to bigint without throwing. Values
               -- above the table's integer domain remain invalid, including 2147483648.
               WHEN COALESCE(member.value->>'ordinal', '') ~ '^[0-9]{1,10}$'
               THEN (member.value->>'ordinal')::bigint > 2147483647
                 OR (member.value->>'ordinal')::bigint <> member.ordinality - 1
               ELSE true
             END
             OR NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.jsonb_array_elements(v_candidate)
                   WITH ORDINALITY candidate_item(value, ordinality)
                WHERE candidate_item.ordinality = member.ordinality
                  AND candidate_item.value->>'publicId' = member.value->>'publicId'
             )
       )
    THEN CONTINUE; END IF;

    SELECT pg_catalog.count(*) INTO v_target_baseline_count
      FROM pg_catalog.jsonb_array_elements(v_baseline) item
     WHERE item->>'publicId' = v_project.public_id;
    IF v_target_baseline_count > 1 THEN CONTINUE; END IF;
    SELECT COALESCE(
      pg_catalog.jsonb_agg(item.value ORDER BY item.ordinality),
      '[]'::jsonb
    ) INTO v_expected_candidate
      FROM pg_catalog.jsonb_array_elements(v_baseline)
        WITH ORDINALITY item(value, ordinality)
     WHERE item.value->>'publicId' <> v_project.public_id;
    IF v_candidate IS DISTINCT FROM v_expected_candidate THEN CONTINUE; END IF;

    SELECT * INTO v_baseline_version
      FROM public.public_feed_versions version
     WHERE version.id = v_operation.baseline_version_id;
    IF v_baseline_version.id IS NULL
       OR v_baseline_version.artifact_content IS DISTINCT FROM v_operation.baseline_feed_content
       OR v_baseline_version.feed_hash IS DISTINCT FROM v_operation.baseline_feed_hash
       OR v_baseline_version.record_count IS DISTINCT FROM v_operation.baseline_record_count
       OR v_baseline_version.byte_count IS DISTINCT FROM
          pg_catalog.octet_length(v_baseline_version.artifact_content)
       OR v_baseline_version.feed_hash IS DISTINCT FROM pg_catalog.encode(
         extensions.digest(
           pg_catalog.convert_to(v_baseline_version.artifact_content, 'UTF8'),
           'sha256'
         ),
         'hex'
       )
       OR (SELECT pg_catalog.count(*) FROM public.public_feed_version_members member
            WHERE member.version_id = v_baseline_version.id) <>
          v_baseline_version.record_count
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.jsonb_array_elements(v_baseline)
             WITH ORDINALITY item(value, ordinality)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.public_feed_version_members member
             WHERE member.version_id = v_baseline_version.id
               AND member.ordinal = item.ordinality - 1
               AND member.public_id = item.value->>'publicId'
          )
       )
    THEN CONTINUE; END IF;

    v_no_feed_change := v_target_baseline_count = 0;
    SELECT pg_catalog.count(*) INTO v_count
      FROM public.public_feed_versions version
     WHERE version.operation_id = v_operation.id;
    IF (v_no_feed_change AND v_count <> 0)
       OR (NOT v_no_feed_change AND v_count <> 1)
    THEN CONTINUE; END IF;

    IF v_no_feed_change THEN
      IF v_operation.candidate_feed_content IS DISTINCT FROM v_operation.baseline_feed_content
         OR v_operation.candidate_feed_hash IS DISTINCT FROM v_operation.baseline_feed_hash
         OR v_operation.candidate_record_count IS DISTINCT FROM v_operation.baseline_record_count
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_operation.candidate_members)
               WITH ORDINALITY manifest(value, ordinality)
            WHERE NOT EXISTS (
              SELECT 1 FROM public.public_feed_version_members member
               WHERE member.version_id = v_baseline_version.id
                 AND member.ordinal = manifest.ordinality - 1
                 AND member.public_id = manifest.value->>'publicId'
                 AND member.record_hash = manifest.value->>'recordHash'
            )
         )
         OR EXISTS (
           SELECT 1
             FROM public.public_feed_versions later
            WHERE later.id <> v_baseline_version.id
              AND later.created_at >= v_operation.completed_at
              AND (
                (
                  later.operation = 'publication'
                  AND later.project_id = v_project.id
                  AND later.affected_public_id = v_project.public_id
                )
                OR EXISTS (
                  SELECT 1 FROM public.public_feed_version_members member
                   WHERE member.version_id = later.id
                     AND member.public_id = v_project.public_id
                )
              )
         )
      THEN CONTINUE; END IF;
    ELSE
      SELECT * INTO v_removal_version
        FROM public.public_feed_versions version
       WHERE version.operation_id = v_operation.id;
      IF v_removal_version.operation IS DISTINCT FROM 'removal'
         OR v_removal_version.previous_version_id IS DISTINCT FROM v_baseline_version.id
         OR v_removal_version.project_id IS DISTINCT FROM v_project.id
         OR v_removal_version.affected_public_id IS DISTINCT FROM v_project.public_id
         OR v_removal_version.authorizing_actor_id IS DISTINCT FROM
            v_operation.authorizing_actor_id
         OR v_removal_version.completion_actor_id IS DISTINCT FROM
            v_operation.completion_actor_id
         OR v_removal_version.audit_record_id IS DISTINCT FROM v_archive.id
         OR v_removal_version.artifact_content IS DISTINCT FROM
            v_operation.candidate_feed_content
         OR v_removal_version.feed_hash IS DISTINCT FROM v_operation.candidate_feed_hash
         OR v_removal_version.record_count IS DISTINCT FROM
            v_operation.candidate_record_count
         OR v_removal_version.byte_count IS DISTINCT FROM
            pg_catalog.octet_length(v_removal_version.artifact_content)
         OR v_removal_version.feed_hash IS DISTINCT FROM pg_catalog.encode(
           extensions.digest(
             pg_catalog.convert_to(v_removal_version.artifact_content, 'UTF8'),
             'sha256'
           ),
           'hex'
         )
         OR (SELECT pg_catalog.count(*) FROM public.public_feed_version_members member
              WHERE member.version_id = v_removal_version.id) <>
            v_removal_version.record_count
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.jsonb_array_elements(v_operation.candidate_members)
               WITH ORDINALITY manifest(value, ordinality)
            WHERE NOT EXISTS (
              SELECT 1 FROM public.public_feed_version_members member
               WHERE member.version_id = v_removal_version.id
                 AND member.ordinal = manifest.ordinality - 1
                 AND member.public_id = manifest.value->>'publicId'
                 AND member.record_hash = manifest.value->>'recordHash'
            )
         )
         OR EXISTS (
           SELECT 1
             FROM public.public_feed_version_members candidate_member
             LEFT JOIN public.public_feed_version_members baseline_member
               ON baseline_member.version_id = v_baseline_version.id
              AND baseline_member.public_id = candidate_member.public_id
            WHERE candidate_member.version_id = v_removal_version.id
              AND (
                baseline_member.public_id IS NULL
                OR baseline_member.record_hash IS DISTINCT FROM candidate_member.record_hash
              )
         )
         OR EXISTS (
           SELECT 1
             FROM public.public_feed_versions later
            WHERE later.version_number > v_removal_version.version_number
              AND (
                (
                  later.operation = 'publication'
                  AND later.project_id = v_project.id
                  AND later.affected_public_id = v_project.public_id
                )
                OR EXISTS (
                  SELECT 1 FROM public.public_feed_version_members member
                   WHERE member.version_id = later.id
                     AND member.public_id = v_project.public_id
                )
              )
         )
      THEN CONTINUE; END IF;
    END IF;

    -- Validate the entire clean canonical event chain, not a matching subset. Recovery, retry,
    -- owner-transfer, missing, duplicate or contradictory histories remain untouched rather than
    -- being guessed through during this one-time repair.
    v_expected_event_count := CASE WHEN v_no_feed_change THEN 5 ELSE 6 END;
    SELECT pg_catalog.count(*) INTO v_count
      FROM public.public_feed_operation_events event
     WHERE event.operation_id = v_operation.id;
    IF v_count <> v_expected_event_count
       OR v_count <> (
          SELECT pg_catalog.max(event.sequence)
            FROM public.public_feed_operation_events event
           WHERE event.operation_id = v_operation.id
       )
       OR EXISTS (
         SELECT 1
           FROM (
             SELECT event.sequence,
                     event.from_state,
                     event.created_at,
                     pg_catalog.lag(event.to_state) OVER (ORDER BY event.sequence) AS prior_state,
                     pg_catalog.lag(event.created_at) OVER (ORDER BY event.sequence) AS prior_created_at
                FROM public.public_feed_operation_events event
               WHERE event.operation_id = v_operation.id
            ) chain
           WHERE (chain.sequence = 1 AND chain.from_state IS NOT NULL)
              OR (chain.sequence > 1 AND chain.from_state IS DISTINCT FROM chain.prior_state)
              OR chain.created_at < chain.prior_created_at
        )
       OR EXISTS (
         SELECT 1
           FROM public.public_feed_operation_events event
          WHERE event.operation_id = v_operation.id
            AND (
              event.from_state IS DISTINCT FROM CASE
                WHEN event.sequence = 1 THEN NULL::text
                WHEN event.sequence = 2 THEN 'RESERVED'
                WHEN event.sequence = 3 THEN 'PREPARED'
                WHEN v_no_feed_change AND event.sequence = 4 THEN 'CANDIDATE_OBSERVED'
                WHEN v_no_feed_change AND event.sequence = 5 THEN 'DB_FINALIZED'
                WHEN NOT v_no_feed_change AND event.sequence = 4 THEN 'WRITE_STARTED'
                WHEN NOT v_no_feed_change AND event.sequence = 5 THEN 'CANDIDATE_OBSERVED'
                WHEN NOT v_no_feed_change AND event.sequence = 6 THEN 'DB_FINALIZED'
                ELSE NULL::text
              END
              OR event.to_state IS DISTINCT FROM CASE
                WHEN event.sequence = 1 THEN 'RESERVED'
                WHEN event.sequence = 2 THEN 'PREPARED'
                WHEN v_no_feed_change AND event.sequence = 3 THEN 'CANDIDATE_OBSERVED'
                WHEN v_no_feed_change AND event.sequence = 4 THEN 'DB_FINALIZED'
                WHEN v_no_feed_change AND event.sequence = 5 THEN 'COMPLETED'
                WHEN NOT v_no_feed_change AND event.sequence = 3 THEN 'WRITE_STARTED'
                WHEN NOT v_no_feed_change AND event.sequence = 4 THEN 'CANDIDATE_OBSERVED'
                WHEN NOT v_no_feed_change AND event.sequence = 5 THEN 'DB_FINALIZED'
                WHEN NOT v_no_feed_change AND event.sequence = 6 THEN 'COMPLETED'
                ELSE NULL::text
              END
              OR event.actor_id IS DISTINCT FROM CASE
                WHEN event.sequence <= 2 THEN v_operation.authorizing_actor_id
                ELSE v_operation.completion_actor_id
              END
              OR event.owner_epoch IS DISTINCT FROM v_operation.owner_epoch
              OR event.observed_storage_hash IS DISTINCT FROM CASE
                WHEN (v_no_feed_change AND event.sequence >= 3)
                  OR (NOT v_no_feed_change AND event.sequence >= 4)
                THEN v_operation.candidate_feed_hash
                ELSE NULL::text
              END
              OR event.observed_storage_record_count IS DISTINCT FROM CASE
                WHEN (v_no_feed_change AND event.sequence >= 3)
                  OR (NOT v_no_feed_change AND event.sequence >= 4)
                THEN v_operation.candidate_record_count
                ELSE NULL::integer
              END
              OR event.code IS DISTINCT FROM CASE
                WHEN v_no_feed_change AND event.sequence = 4 THEN 'NO_FEED_CHANGE'
                ELSE NULL::text
              END
            )
        )
    THEN CONTINUE; END IF;

    SELECT pg_catalog.count(*) INTO v_count
      FROM public.public_feed_operation_events event
     WHERE event.operation_id = v_operation.id
       AND event.to_state = 'DB_FINALIZED';
    IF v_count <> 1 THEN CONTINUE; END IF;
    SELECT event.sequence INTO v_finalized_sequence
      FROM public.public_feed_operation_events event
     WHERE event.operation_id = v_operation.id
       AND event.from_state = 'CANDIDATE_OBSERVED'
       AND event.to_state = 'DB_FINALIZED'
       AND event.actor_id = v_operation.completion_actor_id
       AND event.owner_epoch = v_operation.owner_epoch
       AND event.observed_storage_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
       AND event.observed_storage_record_count IS NOT DISTINCT FROM
           v_operation.candidate_record_count
       AND event.code IS NOT DISTINCT FROM
           CASE WHEN v_no_feed_change THEN 'NO_FEED_CHANGE' ELSE NULL END
       AND event.created_at IS NOT DISTINCT FROM v_operation.finalized_at;
    IF v_finalized_sequence IS NULL THEN CONTINUE; END IF;

    SELECT pg_catalog.count(*) INTO v_count
      FROM public.public_feed_operation_events event
     WHERE event.operation_id = v_operation.id
       AND event.to_state = 'COMPLETED';
    IF v_count <> 1 THEN CONTINUE; END IF;
    SELECT event.sequence INTO v_completed_sequence
      FROM public.public_feed_operation_events event
     WHERE event.operation_id = v_operation.id
       AND event.from_state = 'DB_FINALIZED'
       AND event.to_state = 'COMPLETED'
       AND event.actor_id = v_operation.completion_actor_id
       AND event.owner_epoch = v_operation.owner_epoch
       AND event.observed_storage_hash IS NOT DISTINCT FROM v_operation.candidate_feed_hash
       AND event.observed_storage_record_count IS NOT DISTINCT FROM
           v_operation.candidate_record_count
       AND event.code IS NULL
       AND event.created_at IS NOT DISTINCT FROM v_operation.completed_at;
    IF v_completed_sequence IS NULL
       OR v_completed_sequence <> v_finalized_sequence + 1
       OR v_completed_sequence <> (
         SELECT pg_catalog.max(event.sequence)
           FROM public.public_feed_operation_events event
          WHERE event.operation_id = v_operation.id
       )
    THEN CONTINUE; END IF;

    UPDATE public.media_assets
       SET is_public_approved = false,
           public_url = NULL,
           public_storage_bucket = NULL,
           public_storage_path = NULL
     WHERE project_id = v_project.id
       AND (
         is_public_approved IS DISTINCT FROM false
         OR public_url IS NOT NULL
         OR public_storage_bucket IS NOT NULL
         OR public_storage_path IS NOT NULL
       );
    GET DIAGNOSTICS v_changed_rows = ROW_COUNT;
    IF v_changed_rows > 0 THEN
      v_rearmed_rows := v_rearmed_rows + v_changed_rows;
      UPDATE public.participant_previews
         SET status = 'revoked',
             revoked_at = pg_catalog.now(),
             revoked_by = v_restore.admin_id
       WHERE project_id = v_project.id
         AND status = 'active'
         AND created_at <= v_restore.created_at;
    END IF;
  END LOOP;

  RETURN v_rearmed_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_archived_project_republish_media()
FROM PUBLIC, anon, authenticated, service_role;

-- Reconcile only evidence-complete projects that M59 already restored before M60 existed.
SELECT public.reconcile_archived_project_republish_media();

CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT '20260917090000_archived_project_republish_media_rearm|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1|archived_project_republish_media_rearm_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel()
TO service_role;

COMMIT;
