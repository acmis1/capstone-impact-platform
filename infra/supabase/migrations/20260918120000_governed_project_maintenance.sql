-- Migration 0062: governed project maintenance, deleted-project recovery and taxonomy lifecycle.
--
-- This migration is forward-only. It adds no data backfill and does not rewrite project, media,
-- preview, publication or participant rows while the migration is installed.

BEGIN;

ALTER TABLE public.approval_records
  DROP CONSTRAINT IF EXISTS check_audit_action;

ALTER TABLE public.approval_records
  ADD CONSTRAINT check_audit_action
  CHECK (action_taken IN (
    'request_changes', 'approve', 'publish', 'archive', 'unpublish', 'restore', 'soft_delete',
    'update_metadata', 'submit_for_review', 'update_layout', 'project_recovery'
  ));

ALTER TABLE public.programs
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.disciplines
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.industry_categories
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.programs
  ADD CONSTRAINT programs_lifecycle_version_valid CHECK (lifecycle_version >= 1);
ALTER TABLE public.disciplines
  ADD CONSTRAINT disciplines_lifecycle_version_valid CHECK (lifecycle_version >= 1);
ALTER TABLE public.industry_categories
  ADD CONSTRAINT industry_categories_lifecycle_version_valid CHECK (lifecycle_version >= 1);

CREATE TABLE public.taxonomy_lifecycle_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  taxonomy_kind text NOT NULL CHECK (taxonomy_kind IN ('program', 'discipline', 'industryCategory')),
  taxonomy_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('retire', 'reactivate', 'rename')),
  before_name text NOT NULL,
  after_name text NOT NULL,
  before_retired_at timestamptz,
  after_retired_at timestamptz,
  before_lifecycle_version integer NOT NULL,
  after_lifecycle_version integer NOT NULL,
  actor_admin_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX taxonomy_lifecycle_audit_events_lookup_idx
  ON public.taxonomy_lifecycle_audit_events(taxonomy_kind, taxonomy_id, occurred_at DESC);

ALTER TABLE public.taxonomy_lifecycle_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.taxonomy_lifecycle_audit_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.taxonomy_lifecycle_audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.taxonomy_lifecycle_audit_events TO service_role;

CREATE FUNCTION public.guard_taxonomy_lifecycle_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'TAXONOMY_LIFECYCLE_AUDIT_IMMUTABLE';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_taxonomy_lifecycle_audit_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER taxonomy_lifecycle_audit_immutable
  BEFORE UPDATE OR DELETE ON public.taxonomy_lifecycle_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_taxonomy_lifecycle_audit_immutable();

CREATE FUNCTION public.guard_governed_project_maintenance_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Invoker-security trigger: legitimate owner-executed SECURITY DEFINER RPCs may append;
    -- a direct service-role/PostgREST insert cannot impersonate those audit authorities.
    IF NEW.action_taken IN ('update_layout', 'project_recovery', 'soft_delete')
       AND NOT pg_catalog.pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'PROJECT_MAINTENANCE_AUDIT_INSERT_FORBIDDEN';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.action_taken IN ('update_layout', 'project_recovery', 'soft_delete')
     OR (TG_OP='UPDATE' AND NEW.action_taken IN ('update_layout', 'project_recovery', 'soft_delete')) THEN
    RAISE EXCEPTION 'PROJECT_MAINTENANCE_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_governed_project_maintenance_audit_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER governed_project_maintenance_audit_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.approval_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_governed_project_maintenance_audit_immutable();

CREATE FUNCTION public.project_maintenance_actor_is_admin(p_actor_id uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.public_feed_actor_is_admin(p_actor_id)
    AND EXISTS (
      SELECT 1
      FROM public.admin_users actor
      WHERE actor.id = p_actor_id
        AND actor.lifecycle_status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.staff_provisioning_requests request
      WHERE request.admin_user_id = p_actor_id
        AND request.status = 'pending_activation'
    );
$$;

REVOKE ALL ON FUNCTION public.project_maintenance_actor_is_admin(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.update_project_layout_if_current(
  p_public_id text,
  p_expected_updated_at timestamptz,
  p_layout_config jsonb,
  p_recipe_version_id uuid,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_project public.projects%ROWTYPE;
  v_recipe public.layout_recipe_versions%ROWTYPE;
  v_actor_full_name text;
  v_actor_email text;
  v_old_config jsonb;
  v_decision jsonb;
  v_new_updated_at timestamptz;
  v_audit_id uuid;
  v_revoked_count integer := 0;
  v_recipe_details jsonb := '{}'::jsonb;
BEGIN
  IF NOT public.project_maintenance_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF v_public_id = '' OR v_public_id !~ '^[A-Za-z0-9_-]{1,100}$' OR p_expected_updated_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;
  IF p_layout_config IS NULL
     OR pg_catalog.jsonb_typeof(p_layout_config) IS DISTINCT FROM 'object'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_LAYOUT_CONFIG');
  END IF;
  IF NOT p_layout_config ?& ARRAY['templateId', 'featuredMedia', 'sectionOrder', 'hiddenSections']
     OR p_layout_config - ARRAY['templateId', 'featuredMedia', 'sectionOrder', 'hiddenSections'] <> '{}'::jsonb
     OR pg_catalog.jsonb_typeof(p_layout_config->'templateId') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(p_layout_config->'featuredMedia') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(p_layout_config->'sectionOrder') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(p_layout_config->'hiddenSections') IS DISTINCT FROM 'array'
     OR NOT public.layout_recipe_config_valid(p_layout_config)
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_LAYOUT_CONFIG');
  END IF;

  SELECT staff.full_name, staff.email
    INTO v_actor_full_name, v_actor_email
    FROM public.admin_users staff
   WHERE staff.id = p_admin_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED'); END IF;

  -- Match the existing publish/restore ordering: actor, canonical writer, preview advisory, project.
  -- Preview generation/correction cannot cross the layout snapshot or recovery boundary.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));
  SELECT project.* INTO v_project
    FROM public.projects project
   WHERE project.public_id = v_public_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND'); END IF;

  IF v_project.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION', 'publicId', v_public_id);
  END IF;
  IF v_project.status NOT IN ('draft', 'changes_requested') OR v_project.deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'LAYOUT_STATUS_INELIGIBLE',
      'status', v_project.status,
      'reason', 'Layout changes are available only while a project is Draft or Changes requested.'
    );
  END IF;
  v_decision := public.project_soft_delete_decision(
    v_project.id, v_project.public_id, v_project.status, v_project.deleted_at,
    v_project.pending_removal_from_public, v_project.public_removal_completed_at,
    v_project.archived_at, v_project.archived_from_status
  );
  IF v_decision->>'resultCode' IS DISTINCT FROM 'ELIGIBLE' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'LAYOUT_EVIDENCE_' || COALESCE(v_decision->>'resultCode', 'AMBIGUOUS'),
      'reason', COALESCE(v_decision->>'reason', 'The retained project lifecycle evidence is ambiguous.')
    );
  END IF;
  IF v_project.pending_removal_from_public IS DISTINCT FROM false
     OR EXISTS (
       SELECT 1
       FROM public.public_feed_head head
       JOIN public.public_feed_version_members member ON member.version_id = head.current_version_id
       WHERE head.singleton = true AND member.public_id = v_project.public_id
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'LAYOUT_PUBLIC_OR_REMOVAL_ACTIVE');
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.public_feed_operations operation
       WHERE operation.state IN ('RESERVED', 'PREPARED', 'WRITE_STARTED', 'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED')
     ) OR EXISTS (
       SELECT 1 FROM public.publication_attempts attempt
       WHERE attempt.state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
     ) OR EXISTS (
       SELECT 1 FROM public.public_removal_attempts attempt
       WHERE attempt.state IN ('reserved', 'prepared', 'storage_written', 'compensation_failed')
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLICATION_OR_REMOVAL_PENDING');
  END IF;

  IF p_recipe_version_id IS NOT NULL THEN
    SELECT recipe.* INTO v_recipe
      FROM public.layout_recipe_versions recipe
     WHERE recipe.id = p_recipe_version_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'RECIPE_NOT_FOUND'); END IF;
    IF v_recipe.status <> 'active' OR NOT public.layout_recipe_config_valid(v_recipe.layout_config)
       OR v_recipe.layout_config IS DISTINCT FROM p_layout_config
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'RECIPE_VERSION_INACTIVE_OR_CHANGED');
    END IF;
    v_recipe_details := pg_catalog.jsonb_build_object(
      'id', v_recipe.id::text, 'name', v_recipe.name, 'version', v_recipe.version
    );
  END IF;

  -- New audit records must never invent a resolved previous layout for malformed legacy data.
  IF public.layout_recipe_config_valid(v_project.layout_config) IS DISTINCT FROM true
     OR pg_catalog.jsonb_typeof(v_project.layout_config->'templateId') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_project.layout_config->'featuredMedia') IS DISTINCT FROM 'string'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode','LAYOUT_EVIDENCE_INVALID','reason','The previous layout has no valid resolved evidence. Request a corrected project package before changing layout.');
  END IF;
  v_old_config := v_project.layout_config;
  IF v_old_config IS NOT DISTINCT FROM p_layout_config THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'UNCHANGED', 'publicId', v_public_id, 'status', v_project.status);
  END IF;

  UPDATE public.projects
     SET layout_config = p_layout_config
   WHERE id = v_project.id
     AND updated_at IS NOT DISTINCT FROM p_expected_updated_at
     AND status IN ('draft', 'changes_requested')
     AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION'); END IF;
  SELECT updated_at INTO v_new_updated_at FROM public.projects WHERE id = v_project.id;

  UPDATE public.participant_previews
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = p_admin_id
   WHERE project_id = v_project.id AND status = 'active';
  GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

  INSERT INTO public.approval_records(
    project_id, admin_id, action_taken, from_status, to_status, comments,
    actor_full_name_snapshot, actor_email_snapshot, event_details
  ) VALUES (
    v_project.id, p_admin_id, 'update_layout', v_project.status, v_project.status,
    'Updated the project layout configuration. Participant-owned content and physical media were retained.',
    v_actor_full_name, v_actor_email,
    pg_catalog.jsonb_build_object(
      'version', 1,
      'type', 'project_layout',
      'before', v_old_config,
      'after', p_layout_config,
      'recipe', CASE WHEN p_recipe_version_id IS NULL THEN NULL ELSE v_recipe_details END,
      'revokedActivePreviewCount', v_revoked_count
    )
  ) RETURNING id INTO v_audit_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'UPDATED', 'publicId', v_public_id, 'status', v_project.status,
    'updatedAt', v_new_updated_at, 'auditRecordId', v_audit_id::text,
    'revokedActivePreviewCount', v_revoked_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.update_project_layout_if_current(text, timestamptz, jsonb, uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_project_layout_if_current(text, timestamptz, jsonb, uuid, uuid) TO service_role;

CREATE FUNCTION public.project_deleted_recovery_readiness(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_delete_count integer;
  v_delete_id uuid;
  v_decision jsonb;
BEGIN
  SELECT project.* INTO v_project FROM public.projects project WHERE project.id = p_project_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('code', 'PROJECT_NOT_FOUND', 'reason', 'The project record was not found.'); END IF;
  IF (v_project.status = 'deleted') IS DISTINCT FROM (v_project.deleted_at IS NOT NULL) THEN
    RETURN pg_catalog.jsonb_build_object('code', 'DELETE_STATE_AMBIGUOUS', 'reason', 'The tombstone state is inconsistent.');
  END IF;
  IF v_project.status <> 'deleted' OR v_project.deleted_at IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('code', 'NOT_DELETED', 'reason', 'The project is not a coherent deleted project.');
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_delete_count
    FROM public.approval_records audit
   WHERE audit.project_id = v_project.id
     AND audit.action_taken = 'soft_delete'
     AND audit.from_status IN ('draft','submitted','in_review','changes_requested','approved','archived')
     AND audit.to_status = 'deleted'
     AND audit.created_at IS NOT DISTINCT FROM v_project.deleted_at
     AND audit.event_details->>'type' = 'project_soft_delete'
     AND audit.event_details->'version' = '1'::jsonb
     AND audit.event_details->>'fromStatus' = audit.from_status
     AND audit.event_details->>'toStatus' = 'deleted'
     AND pg_catalog.jsonb_typeof(audit.event_details->'previouslyPublished') = 'boolean'
     AND audit.event_details->'deletedAt' = pg_catalog.to_jsonb(v_project.deleted_at);
  IF v_delete_count <> 1 OR (SELECT count(*) FROM public.approval_records audit
      WHERE audit.project_id=v_project.id AND audit.action_taken='soft_delete'
        AND (audit.created_at IS NOT DISTINCT FROM v_project.deleted_at OR audit.event_details->'deletedAt'=pg_catalog.to_jsonb(v_project.deleted_at))) <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('code', 'RECOVERY_EVIDENCE_REQUIRED', 'reason', 'Exactly one matching immutable soft-delete audit is required.');
  END IF;
  SELECT audit.id INTO v_delete_id
    FROM public.approval_records audit
   WHERE audit.project_id = v_project.id
     AND audit.action_taken = 'soft_delete'
     AND audit.from_status IN ('draft','submitted','in_review','changes_requested','approved','archived')
     AND audit.to_status = 'deleted'
     AND audit.created_at IS NOT DISTINCT FROM v_project.deleted_at
     AND audit.event_details->>'type' = 'project_soft_delete'
     AND audit.event_details->'version' = '1'::jsonb
     AND audit.event_details->>'fromStatus' = audit.from_status
     AND audit.event_details->>'toStatus' = 'deleted'
     AND pg_catalog.jsonb_typeof(audit.event_details->'previouslyPublished') = 'boolean'
     AND audit.event_details->'deletedAt' = pg_catalog.to_jsonb(v_project.deleted_at);

  v_decision := public.project_soft_delete_decision(
    v_project.id, v_project.public_id, 'draft', NULL,
    v_project.pending_removal_from_public, v_project.public_removal_completed_at, v_project.archived_at, v_project.archived_from_status
  );
  IF v_decision->>'resultCode' IS DISTINCT FROM 'ELIGIBLE' THEN
    RETURN pg_catalog.jsonb_build_object(
      'code', 'RECOVERY_' || COALESCE(v_decision->>'resultCode', 'EVIDENCE_AMBIGUOUS'),
      'reason', COALESCE(v_decision->>'reason', 'The retained public-removal evidence is ambiguous.'),
      'softDeleteAuditId', v_delete_id::text
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'code', 'READY_FOR_RECOVERY',
    'reason', 'The tombstone and exact removal evidence support recovery to a private Draft.',
    'softDeleteAuditId', v_delete_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.project_deleted_recovery_readiness(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.recover_deleted_project_if_current(
  p_public_id text,
  p_expected_updated_at timestamptz,
  p_expected_deleted_at timestamptz,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_project public.projects%ROWTYPE;
  v_readiness jsonb;
  v_delete_audit_id uuid;
  v_recovery_audit_id uuid;
  v_recovery_count integer;
  v_actor_full_name text;
  v_actor_email text;
  v_rearmed_count integer := 0;
  v_updated_at timestamptz;
BEGIN
  IF NOT public.project_maintenance_actor_is_admin(p_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF v_public_id = '' OR v_public_id !~ '^[A-Za-z0-9_-]{1,100}$'
     OR p_expected_updated_at IS NULL OR p_expected_deleted_at IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT staff.full_name, staff.email INTO v_actor_full_name, v_actor_email
    FROM public.admin_users staff WHERE staff.id = p_admin_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED'); END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public_feed_canonical_writer'));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));
  SELECT project.* INTO v_project
    FROM public.projects project WHERE project.public_id = v_public_id FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND'); END IF;

  IF (v_project.status = 'deleted') IS DISTINCT FROM (v_project.deleted_at IS NOT NULL) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'DELETE_STATE_AMBIGUOUS');
  END IF;
  IF v_project.status <> 'deleted' OR v_project.deleted_at IS NULL THEN
    SELECT count(*), (array_agg(audit.id))[1] INTO v_recovery_count, v_delete_audit_id
      FROM public.approval_records audit
      JOIN public.approval_records recovery ON recovery.project_id=audit.project_id
        AND recovery.action_taken='project_recovery'
        AND recovery.from_status='deleted' AND recovery.to_status='draft'
        AND recovery.event_details->>'type'='project_recovery'
        AND recovery.event_details->'version'='1'::jsonb
        AND recovery.event_details->>'softDeleteAuditId'=audit.id::text
        AND recovery.event_details->'deletedAt'=pg_catalog.to_jsonb(p_expected_deleted_at)
      WHERE audit.project_id=v_project.id AND audit.action_taken='soft_delete'
        AND audit.from_status IN ('draft','submitted','in_review','changes_requested','approved','archived')
        AND audit.to_status='deleted'
        AND audit.created_at IS NOT DISTINCT FROM p_expected_deleted_at
        AND audit.event_details->>'type'='project_soft_delete'
        AND audit.event_details->'version'='1'::jsonb
        AND audit.event_details->>'fromStatus'=audit.from_status
        AND audit.event_details->>'toStatus'='deleted'
        AND audit.event_details->'deletedAt'=pg_catalog.to_jsonb(p_expected_deleted_at);
    IF v_recovery_count > 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode','RECOVERY_EVIDENCE_REQUIRED');
    END IF;
    IF v_recovery_count = 1 AND (SELECT count(*) FROM public.approval_records audit
         WHERE audit.project_id=v_project.id AND audit.action_taken='soft_delete'
           AND (audit.created_at IS NOT DISTINCT FROM p_expected_deleted_at OR audit.event_details->'deletedAt'=pg_catalog.to_jsonb(p_expected_deleted_at))) = 1 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode','ALREADY_RECOVERED','publicId',v_public_id,'status',v_project.status);
    END IF;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'RECOVERY_NOT_DELETED');
  END IF;
  IF v_project.deleted_at IS DISTINCT FROM p_expected_deleted_at THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_DELETED_TIMESTAMP');
  END IF;
  IF v_project.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION');
  END IF;

  v_readiness := public.project_deleted_recovery_readiness(v_project.id);
  IF v_readiness->>'code' IS DISTINCT FROM 'READY_FOR_RECOVERY' THEN
    RETURN v_readiness || pg_catalog.jsonb_build_object('resultCode', v_readiness->>'code');
  END IF;
  v_delete_audit_id := (v_readiness->>'softDeleteAuditId')::uuid;

  PERFORM media.id
    FROM public.media_assets media
   WHERE media.project_id = v_project.id
   ORDER BY media.id
   FOR UPDATE;

  -- Recovery never deletes or moves an object. These are the only four publication-mapping
  -- fields it may rearm, and only after exact feed-removal proof has passed.
  UPDATE public.media_assets
     SET is_public_approved = false,
         public_url = NULL,
         public_storage_bucket = NULL,
         public_storage_path = NULL
   WHERE project_id = v_project.id
     AND (is_public_approved IS DISTINCT FROM false OR public_url IS NOT NULL
          OR public_storage_bucket IS NOT NULL OR public_storage_path IS NOT NULL);
  GET DIAGNOSTICS v_rearmed_count = ROW_COUNT;

  UPDATE public.participant_previews
     SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = p_admin_id
   WHERE project_id = v_project.id AND status = 'active';

  UPDATE public.projects
     SET status = 'draft',
         deleted_at = NULL,
         archived_at = NULL,
         archived_from_status = NULL,
         archive_reason = NULL,
         pending_removal_from_public = false
   WHERE id = v_project.id
     AND status = 'deleted'
     AND deleted_at IS NOT DISTINCT FROM p_expected_deleted_at
     AND updated_at IS NOT DISTINCT FROM p_expected_updated_at;
  -- Earlier mapping/preview writes must never survive a suppressed final CAS update.
  IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_ATOMIC_CAS_FAILED'; END IF;
  SELECT updated_at INTO v_updated_at FROM public.projects WHERE id = v_project.id;

  INSERT INTO public.approval_records(
    project_id, admin_id, action_taken, from_status, to_status, comments,
    actor_full_name_snapshot, actor_email_snapshot, event_details
  ) VALUES (
    v_project.id, p_admin_id, 'project_recovery', 'deleted', 'draft',
    'Recovered a deleted project to a private Draft after exact removal evidence. Physical media and history were retained.',
    v_actor_full_name, v_actor_email,
    pg_catalog.jsonb_build_object(
      'version', 1, 'type', 'project_recovery',
      'softDeleteAuditId', v_delete_audit_id::text,
      'deletedAt', p_expected_deleted_at,
      'before', pg_catalog.jsonb_build_object('status', 'deleted', 'deletedAt', p_expected_deleted_at),
      'after', pg_catalog.jsonb_build_object('status', 'draft', 'deletedAt', NULL),
      'rearmedPublicMappingRows', v_rearmed_count
    )
  ) RETURNING id INTO v_recovery_audit_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RECOVERED', 'publicId', v_public_id, 'status', 'draft',
    'updatedAt', v_updated_at, 'auditRecordId', v_recovery_audit_id::text,
    'rearmedPublicMappingRows', v_rearmed_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_deleted_project_if_current(text, timestamptz, timestamptz, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_deleted_project_if_current(text, timestamptz, timestamptz, uuid) TO service_role;

CREATE FUNCTION public.list_deleted_projects(
  p_admin_id uuid,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page integer := COALESCE(p_page, 1);
  v_page_size integer := COALESCE(p_page_size, 20);
  v_search text := NULLIF(pg_catalog.btrim(COALESCE(p_search, '')), '');
  v_total integer;
  v_items jsonb;
BEGIN
  IF NOT public.project_maintenance_actor_is_admin(p_admin_id) THEN RAISE EXCEPTION 'PROJECT_MAINTENANCE_PERMISSION_DENIED'; END IF;
  IF v_page < 1 OR v_page > 100000 OR v_page_size NOT IN (20, 50)
     OR (v_search IS NOT NULL AND (pg_catalog.length(v_search) > 100 OR v_search ~ '[\u0000-\u001f\u007f]'))
  THEN RAISE EXCEPTION 'PROJECT_MAINTENANCE_INPUT_INVALID'; END IF;

  SELECT pg_catalog.count(*) INTO v_total
    FROM public.projects project
   WHERE (project.status = 'deleted' OR project.deleted_at IS NOT NULL)
     AND (v_search IS NULL OR project.public_id ILIKE '%' || v_search || '%' OR project.title ILIKE '%' || v_search || '%');

  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY item->>'deletedAt' DESC NULLS LAST, item->>'publicId'), '[]'::jsonb)
    INTO v_items
    FROM (
      SELECT pg_catalog.jsonb_build_object(
        'publicId', project.public_id,
        'title', project.title,
        'status', project.status,
        'deletedAt', project.deleted_at,
        'updatedAt', project.updated_at,
        'createdAt', project.created_at,
        'recovery', public.project_deleted_recovery_readiness(project.id)
      ) AS item
      FROM public.projects project
      WHERE (project.status = 'deleted' OR project.deleted_at IS NOT NULL)
        AND (v_search IS NULL OR project.public_id ILIKE '%' || v_search || '%' OR project.title ILIKE '%' || v_search || '%')
      ORDER BY project.deleted_at DESC NULLS LAST, project.public_id
      LIMIT v_page_size OFFSET (v_page - 1) * v_page_size
    ) paged;

  RETURN pg_catalog.jsonb_build_object(
    'items', v_items, 'total', v_total, 'page', v_page, 'pageSize', v_page_size,
    'pageCount', CASE WHEN v_total = 0 THEN 0 ELSE CEIL(v_total::numeric / v_page_size)::integer END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_deleted_projects(uuid, integer, integer, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_deleted_projects(uuid, integer, integer, text) TO service_role;

CREATE FUNCTION public.get_deleted_project_detail(p_public_id text, p_admin_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project public.projects%ROWTYPE;
BEGIN
  IF NOT public.project_maintenance_actor_is_admin(p_admin_id) THEN RAISE EXCEPTION 'PROJECT_MAINTENANCE_PERMISSION_DENIED'; END IF;
  IF p_public_id IS NULL OR pg_catalog.btrim(p_public_id) !~ '^[A-Za-z0-9_-]{1,100}$' THEN RAISE EXCEPTION 'PROJECT_MAINTENANCE_INPUT_INVALID'; END IF;
  SELECT project.* INTO v_project
    FROM public.projects project
   WHERE project.public_id = pg_catalog.btrim(p_public_id)
     AND (project.status = 'deleted' OR project.deleted_at IS NOT NULL);
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND'); END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'FOUND',
    'project', pg_catalog.jsonb_build_object(
      'id', v_project.id::text, 'publicId', v_project.public_id, 'title', v_project.title,
      'status', v_project.status, 'deletedAt', v_project.deleted_at, 'updatedAt', v_project.updated_at,
      'createdAt', v_project.created_at, 'summary', v_project.summary, 'background', v_project.background,
      'solution', v_project.solution, 'year', v_project.year, 'program', v_project.program_name,
      'discipline', v_project.discipline, 'industry', v_project.industry, 'groupName', v_project.group_name
    ),
    'recovery', public.project_deleted_recovery_readiness(v_project.id),
    'media', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', media.id::text, 'assetType', media.asset_type, 'fileName', media.file_name,
        'storageBucket', media.storage_bucket, 'storagePath', media.storage_path,
        'mimeType', media.mime_type, 'fileSizeBytes', media.file_size_bytes,
        'isPublicApproved', media.is_public_approved, 'publicUrl', media.public_url,
        'publicStorageBucket', media.public_storage_bucket, 'publicStoragePath', media.public_storage_path,
        'createdAt', media.created_at
      ) ORDER BY media.created_at, media.id)
      FROM public.media_assets media WHERE media.project_id = v_project.id
    ), '[]'::jsonb),
    'approvalHistory', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', audit.id::text, 'action', audit.action_taken, 'fromStatus', audit.from_status,
        'toStatus', audit.to_status, 'comments', audit.comments, 'createdAt', audit.created_at,
        'actorFullName', audit.actor_full_name_snapshot, 'actorEmail', audit.actor_email_snapshot,
        'eventDetails', audit.event_details
      ) ORDER BY audit.created_at DESC NULLS LAST, audit.id DESC)
      FROM public.approval_records audit WHERE audit.project_id = v_project.id
    ), '[]'::jsonb),
    'participantPreviews', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', preview.id::text, 'status', preview.status, 'createdAt', preview.created_at,
        'expiresAt', preview.expires_at, 'revokedAt', preview.revoked_at, 'revokedBy', preview.revoked_by
      ) ORDER BY preview.created_at DESC, preview.id DESC)
      FROM public.participant_previews preview WHERE preview.project_id = v_project.id
    ), '[]'::jsonb),
    'feedHistory', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', operation.id::text, 'kind', operation.kind, 'state', operation.state,
        'createdAt', operation.created_at, 'completedAt', operation.completed_at,
        'finalizedAt', operation.finalized_at, 'failureCode', operation.failure_code
      ) ORDER BY operation.created_at DESC NULLS LAST, operation.id DESC)
      FROM public.public_feed_operations operation WHERE operation.project_id = v_project.id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_deleted_project_detail(text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_deleted_project_detail(text, uuid) TO service_role;

CREATE FUNCTION public.manage_taxonomy_lifecycle(
  p_kind text,
  p_taxonomy_id uuid,
  p_action text,
  p_name text,
  p_expected_lifecycle_version integer,
  p_actor_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text := p_kind;
  v_action text := p_action;
  v_name text := pg_catalog.btrim(COALESCE(p_name, ''));
  v_old_name text;
  v_new_name text;
  v_old_retired_at timestamptz;
  v_new_retired_at timestamptz;
  v_old_version integer;
  v_new_version integer;
  v_references bigint;
  v_id uuid := p_taxonomy_id;
  v_actor_name text;
BEGIN
  IF NOT public.project_maintenance_actor_is_admin(p_actor_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF v_kind IS NULL OR v_action IS NULL OR v_kind NOT IN ('program', 'discipline', 'industryCategory')
     OR v_action NOT IN ('retire', 'reactivate', 'rename')
     OR v_id IS NULL OR p_expected_lifecycle_version IS NULL OR p_expected_lifecycle_version < 1
     OR (v_action = 'rename' AND (v_name = '' OR pg_catalog.length(v_name) > 120 OR v_name ~ '[[:cntrl:]]'))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT staff.full_name INTO v_actor_name FROM public.admin_users staff WHERE staff.id = p_actor_admin_id;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED'); END IF;
  -- Bound reference inspection and mutation together. NOWAIT returns a known safe refusal
  -- instead of waiting in a cycle with an existing project writer.
  LOCK TABLE public.projects, public.project_disciplines, public.project_industry_categories
    IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF v_kind = 'program' THEN
    SELECT name, retired_at, lifecycle_version INTO v_old_name, v_old_retired_at, v_old_version FROM public.programs WHERE id = v_id FOR UPDATE NOWAIT;
  ELSIF v_kind = 'discipline' THEN
    SELECT name, retired_at, lifecycle_version INTO v_old_name, v_old_retired_at, v_old_version FROM public.disciplines WHERE id = v_id FOR UPDATE NOWAIT;
  ELSE
    SELECT name, retired_at, lifecycle_version INTO v_old_name, v_old_retired_at, v_old_version FROM public.industry_categories WHERE id = v_id FOR UPDATE NOWAIT;
  END IF;
  IF v_old_name IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND'); END IF;
  IF v_old_version <> p_expected_lifecycle_version THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION', 'lifecycleVersion', v_old_version);
  END IF;

  v_new_name := v_old_name;
  v_new_retired_at := v_old_retired_at;
  IF v_action = 'retire' THEN
    IF v_old_retired_at IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'UNCHANGED', 'id', v_id, 'name', v_old_name, 'retiredAt', v_old_retired_at, 'lifecycleVersion', v_old_version); END IF;
    v_new_retired_at := pg_catalog.now();
  ELSIF v_action = 'reactivate' THEN
    IF v_old_retired_at IS NULL THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'UNCHANGED', 'id', v_id, 'name', v_old_name, 'retiredAt', v_old_retired_at, 'lifecycleVersion', v_old_version); END IF;
    v_new_retired_at := NULL;
  ELSE
    IF v_name = v_old_name THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'UNCHANGED', 'id', v_id, 'name', v_old_name, 'retiredAt', v_old_retired_at, 'lifecycleVersion', v_old_version); END IF;
    IF v_kind = 'program' THEN SELECT count(*) INTO v_references FROM public.projects WHERE program_id = v_id OR lower(btrim(program_name))=lower(v_old_name) OR lower(btrim(study_program))=lower(v_old_name);
    ELSIF v_kind = 'discipline' THEN SELECT count(*) INTO v_references FROM public.projects project WHERE lower(btrim(project.discipline))=lower(v_old_name) OR EXISTS(SELECT 1 FROM public.project_disciplines ref WHERE ref.project_id=project.id AND ref.discipline_id=v_id);
    ELSE SELECT count(*) INTO v_references FROM public.projects project WHERE lower(btrim(project.industry))=lower(v_old_name) OR EXISTS(SELECT 1 FROM public.project_industry_categories ref WHERE ref.project_id=project.id AND ref.industry_category_id=v_id);
    END IF;
    IF v_references <> 0 THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'REFERENCED_RENAME_BLOCKED', 'referenceCount', v_references);
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.programs WHERE v_kind = 'program' AND lower(name) = lower(v_name) AND id <> v_id
      UNION ALL SELECT 1 FROM public.disciplines WHERE v_kind = 'discipline' AND lower(name) = lower(v_name) AND id <> v_id
      UNION ALL SELECT 1 FROM public.industry_categories WHERE v_kind = 'industryCategory' AND lower(name) = lower(v_name) AND id <> v_id
    ) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'DUPLICATE_NAME');
    END IF;
    v_new_name := v_name;
  END IF;

  v_new_version := v_old_version + 1;
  IF v_kind = 'program' THEN
    UPDATE public.programs SET name = v_new_name, retired_at = v_new_retired_at, lifecycle_version = v_new_version WHERE id = v_id;
  ELSIF v_kind = 'discipline' THEN
    UPDATE public.disciplines SET name = v_new_name, retired_at = v_new_retired_at, lifecycle_version = v_new_version WHERE id = v_id;
  ELSE
    UPDATE public.industry_categories SET name = v_new_name, retired_at = v_new_retired_at, lifecycle_version = v_new_version WHERE id = v_id;
  END IF;

  INSERT INTO public.taxonomy_lifecycle_audit_events(
    taxonomy_kind, taxonomy_id, action, before_name, after_name, before_retired_at, after_retired_at,
    before_lifecycle_version, after_lifecycle_version, actor_admin_id
  ) VALUES (
    v_kind, v_id, v_action, v_old_name, v_new_name, v_old_retired_at, v_new_retired_at,
    v_old_version, v_new_version, p_actor_admin_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', CASE v_action WHEN 'retire' THEN 'RETIRED' WHEN 'reactivate' THEN 'REACTIVATED' ELSE 'RENAMED' END,
    'id', v_id::text, 'name', v_new_name, 'retiredAt', v_new_retired_at, 'lifecycleVersion', v_new_version
  );
EXCEPTION
  WHEN lock_not_available THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'BUSY');
  WHEN unique_violation THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'DUPLICATE_NAME');
END;
$$;

REVOKE ALL ON FUNCTION public.manage_taxonomy_lifecycle(text, uuid, text, text, integer, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_taxonomy_lifecycle(text, uuid, text, text, integer, uuid) TO service_role;

-- New assignments must use active taxonomy. Existing references remain valid after retirement.
-- A category row lock fences new references against retire/rename; lifecycle also takes NOWAIT
-- reference-table locks so legacy text references participate without introducing a lock cycle.
CREATE FUNCTION public.guard_retired_project_taxonomy_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE candidate record;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    IF TG_OP = 'INSERT' OR NEW.program_id IS DISTINCT FROM OLD.program_id
       OR NEW.program_name IS DISTINCT FROM OLD.program_name OR NEW.study_program IS DISTINCT FROM OLD.study_program THEN
      FOR candidate IN SELECT p.id, p.name, p.retired_at FROM public.programs p
        WHERE p.id = NEW.program_id OR lower(p.name) = lower(btrim(NEW.program_name))
           OR lower(p.name) = lower(btrim(NEW.study_program)) ORDER BY p.id FOR KEY SHARE LOOP
        IF TG_OP = 'UPDATE' THEN
          IF candidate.id = OLD.program_id OR lower(candidate.name) = lower(btrim(OLD.program_name))
             OR lower(candidate.name) = lower(btrim(OLD.study_program)) THEN CONTINUE; END IF;
        END IF;
        IF candidate.retired_at IS NOT NULL THEN RAISE EXCEPTION 'RETIRED_PROGRAM_NOT_AVAILABLE'; END IF;
        -- Preserve the established legacy FK/display-name contract; only new retired assignments are refused.
      END LOOP;
    END IF;
    IF TG_OP = 'INSERT' OR NEW.discipline IS DISTINCT FROM OLD.discipline THEN
      FOR candidate IN SELECT d.id, d.name, d.retired_at FROM public.disciplines d
        WHERE lower(d.name) = lower(btrim(NEW.discipline)) ORDER BY d.id FOR KEY SHARE LOOP
        IF TG_OP = 'UPDATE' AND lower(candidate.name) = lower(btrim(OLD.discipline)) THEN CONTINUE; END IF;
        IF candidate.retired_at IS NOT NULL THEN RAISE EXCEPTION 'RETIRED_DISCIPLINE_NOT_AVAILABLE'; END IF;
      END LOOP;
    END IF;
    IF TG_OP = 'INSERT' OR NEW.industry IS DISTINCT FROM OLD.industry THEN
      FOR candidate IN SELECT i.id, i.name, i.retired_at FROM public.industry_categories i
        WHERE lower(i.name) = lower(btrim(NEW.industry)) ORDER BY i.id FOR KEY SHARE LOOP
        IF TG_OP = 'UPDATE' AND lower(candidate.name) = lower(btrim(OLD.industry)) THEN CONTINUE; END IF;
        IF candidate.retired_at IS NOT NULL THEN RAISE EXCEPTION 'RETIRED_INDUSTRY_NOT_AVAILABLE'; END IF;
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'project_disciplines' THEN
    IF TG_OP = 'UPDATE' AND NEW.project_id = OLD.project_id AND NEW.discipline_id = OLD.discipline_id THEN RETURN NEW; END IF;
    -- ON CONFLICT DO NOTHING still fires BEFORE INSERT. This exact retained relation is not a new assignment.
    IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.project_disciplines
      WHERE project_id = NEW.project_id AND discipline_id = NEW.discipline_id) THEN RETURN NEW; END IF;
    SELECT name, retired_at INTO candidate FROM public.disciplines WHERE id = NEW.discipline_id FOR KEY SHARE;
    IF EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND lower(btrim(p.discipline)) = lower(candidate.name)) THEN RETURN NEW; END IF;
    IF candidate.retired_at IS NOT NULL THEN RAISE EXCEPTION 'RETIRED_DISCIPLINE_NOT_AVAILABLE'; END IF;
  ELSIF TG_TABLE_NAME = 'project_industry_categories' THEN
    IF TG_OP = 'UPDATE' AND NEW.project_id = OLD.project_id AND NEW.industry_category_id = OLD.industry_category_id THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.project_industry_categories
      WHERE project_id = NEW.project_id AND industry_category_id = NEW.industry_category_id) THEN RETURN NEW; END IF;
    SELECT name, retired_at INTO candidate FROM public.industry_categories WHERE id = NEW.industry_category_id FOR KEY SHARE;
    IF EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND lower(btrim(p.industry)) = lower(candidate.name)) THEN RETURN NEW; END IF;
    IF candidate.retired_at IS NOT NULL THEN RAISE EXCEPTION 'RETIRED_INDUSTRY_NOT_AVAILABLE'; END IF;
  ELSE RAISE EXCEPTION 'TAXONOMY_REFERENCE_GUARD_TABLE_INVALID';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.guard_retired_project_taxonomy_reference() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER retired_project_taxonomy_reference BEFORE INSERT OR UPDATE OF program_id, program_name, study_program, discipline, industry ON public.projects FOR EACH ROW EXECUTE FUNCTION public.guard_retired_project_taxonomy_reference();
CREATE TRIGGER retired_discipline_reference BEFORE INSERT OR UPDATE ON public.project_disciplines FOR EACH ROW EXECUTE FUNCTION public.guard_retired_project_taxonomy_reference();
CREATE TRIGGER retired_industry_reference BEFORE INSERT OR UPDATE ON public.project_industry_categories FOR EACH ROW EXECUTE FUNCTION public.guard_retired_project_taxonomy_reference();

-- Preserve unchanged retired relations during the existing metadata RPC; all other validation and response contracts are retained.
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
  p_expected_updated_at timestamptz,
  p_admin_id uuid,
  p_poster_text text,
  p_accessibility_text text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_title text := pg_catalog.btrim(COALESCE(p_title, ''));
  v_summary text := pg_catalog.btrim(COALESCE(p_summary, ''));
  v_background text := pg_catalog.btrim(COALESCE(p_background, ''));
  v_solution text := pg_catalog.btrim(COALESCE(p_solution, ''));
  v_poster_text text := pg_catalog.btrim(COALESCE(p_poster_text, ''));
  v_accessibility_text text := pg_catalog.btrim(COALESCE(p_accessibility_text, ''));
  v_project_id uuid;
  v_current_updated_at timestamptz;
  v_status text;
  v_updated_at timestamptz;
  v_program_name text;
  v_discipline_name text;
  v_industry_name text;
  v_old_title text;
  v_old_summary text;
  v_old_background text;
  v_old_solution text;
  v_old_poster_text text;
  v_old_accessibility_text text;
  v_old_year integer;
  v_old_program_id uuid;
  v_old_program_name text;
  v_old_discipline_name text;
  v_old_industry_name text;
  v_audit_record_id uuid;
  v_actor_full_name text;
  v_actor_email text;
  v_changed_fields text[] := ARRAY[]::text[];
  v_before_state jsonb := '{}'::jsonb;
  v_after_state jsonb := '{}'::jsonb;
  v_event_details jsonb;
  v_old_disciplines jsonb;
  v_new_disciplines jsonb;
  v_old_industries jsonb;
  v_new_industries jsonb;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('capstone.staff_lifecycle_admin_invariant', 0));
  SELECT full_name, email INTO v_actor_full_name, v_actor_email
  FROM public.admin_users actor WHERE actor.id = p_admin_id AND actor.lifecycle_status = 'active'
    AND NOT EXISTS (SELECT 1 FROM public.staff_provisioning_requests request WHERE request.admin_user_id = actor.id AND request.status = 'pending_activation')
  FOR SHARE;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_admin_id AND role IN ('admin', 'editor')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- Accessible poster content is required and bounded, exactly like title/summary. A blank value
  -- can never be written back, so the correction path always moves a project toward compliance.
  IF v_public_id = '' OR v_title = '' OR v_summary = '' OR pg_catalog.length(v_title) > 200
    OR pg_catalog.length(v_summary) > 1000 OR pg_catalog.length(v_background) > 10000
    OR pg_catalog.length(v_solution) > 10000
    OR v_poster_text = '' OR pg_catalog.length(v_poster_text) > 20000
    OR v_accessibility_text = '' OR pg_catalog.length(v_accessibility_text) > 2000
    OR p_year IS NULL OR p_year < 2000 OR p_year > 2100
    OR p_program_id IS NULL OR p_expected_updated_at IS NULL OR p_discipline_ids IS NULL
    OR pg_catalog.cardinality(p_discipline_ids) = 0 OR pg_catalog.array_position(p_discipline_ids, NULL) IS NOT NULL
    OR p_industry_category_ids IS NULL OR pg_catalog.cardinality(p_industry_category_ids) = 0
    OR pg_catalog.array_position(p_industry_category_ids, NULL) IS NOT NULL
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_discipline_ids) x) <> pg_catalog.cardinality(p_discipline_ids)
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(p_industry_category_ids) x) <> pg_catalog.cardinality(p_industry_category_ids)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED'); END IF;

  SELECT id, updated_at, status, title, summary, background, solution, year, program_id, program_name, discipline, industry,
         poster_text_public, accessibility_text_public
  INTO v_project_id, v_current_updated_at, v_status, v_old_title, v_old_summary, v_old_background, v_old_solution, v_old_year, v_old_program_id, v_old_program_name, v_old_discipline_name, v_old_industry_name,
       v_old_poster_text, v_old_accessibility_text
  FROM public.projects WHERE public_id = v_public_id AND deleted_at IS NULL FOR UPDATE;

  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND'); END IF;
  IF v_status = 'approved' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'APPROVAL_REOPEN_REQUIRED'); END IF;
  IF v_status = 'published' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'PUBLISHED_PROJECT_LOCKED'); END IF;
  IF v_current_updated_at IS DISTINCT FROM p_expected_updated_at THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'STALE_VERSION'); END IF;

  SELECT name INTO v_program_name FROM public.programs WHERE id = p_program_id;
  SELECT name INTO v_discipline_name FROM public.disciplines WHERE id = p_discipline_ids[1];
  SELECT name INTO v_industry_name FROM public.industry_categories WHERE id = p_industry_category_ids[1];
  IF v_program_name IS NULL OR v_discipline_name IS NULL OR v_industry_name IS NULL
    OR (SELECT count(*) FROM public.disciplines WHERE id = ANY(p_discipline_ids)) <> pg_catalog.cardinality(p_discipline_ids)
    OR (SELECT count(*) FROM public.industry_categories WHERE id = ANY(p_industry_category_ids)) <> pg_catalog.cardinality(p_industry_category_ids)
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED'); END IF;

  IF v_old_title IS DISTINCT FROM v_title THEN
    v_changed_fields := array_append(v_changed_fields, 'title');
    v_before_state := jsonb_set(v_before_state, '{title}', to_jsonb(v_old_title));
    v_after_state := jsonb_set(v_after_state, '{title}', to_jsonb(v_title));
  END IF;
  IF v_old_summary IS DISTINCT FROM v_summary THEN
    v_changed_fields := array_append(v_changed_fields, 'summary');
    v_before_state := jsonb_set(v_before_state, '{summary}', to_jsonb(v_old_summary));
    v_after_state := jsonb_set(v_after_state, '{summary}', to_jsonb(v_summary));
  END IF;
  IF coalesce(v_old_background, '') IS DISTINCT FROM v_background THEN
    v_changed_fields := array_append(v_changed_fields, 'background');
    v_before_state := jsonb_set(v_before_state, '{background}', to_jsonb(coalesce(v_old_background, '')));
    v_after_state := jsonb_set(v_after_state, '{background}', to_jsonb(v_background));
  END IF;
  IF coalesce(v_old_solution, '') IS DISTINCT FROM v_solution THEN
    v_changed_fields := array_append(v_changed_fields, 'solution');
    v_before_state := jsonb_set(v_before_state, '{solution}', to_jsonb(coalesce(v_old_solution, '')));
    v_after_state := jsonb_set(v_after_state, '{solution}', to_jsonb(v_solution));
  END IF;
  -- A NULL column and an empty string are the same absence of accessible content, so an
  -- absent-to-absent save must never fabricate a changed field.
  IF coalesce(v_old_poster_text, '') IS DISTINCT FROM v_poster_text THEN
    v_changed_fields := array_append(v_changed_fields, 'posterText');
    v_before_state := jsonb_set(v_before_state, '{posterText}', to_jsonb(coalesce(v_old_poster_text, '')));
    v_after_state := jsonb_set(v_after_state, '{posterText}', to_jsonb(v_poster_text));
  END IF;
  IF coalesce(v_old_accessibility_text, '') IS DISTINCT FROM v_accessibility_text THEN
    v_changed_fields := array_append(v_changed_fields, 'accessibilityText');
    v_before_state := jsonb_set(v_before_state, '{accessibilityText}', to_jsonb(coalesce(v_old_accessibility_text, '')));
    v_after_state := jsonb_set(v_after_state, '{accessibilityText}', to_jsonb(v_accessibility_text));
  END IF;
  IF coalesce(v_old_year, 0) IS DISTINCT FROM p_year THEN
    v_changed_fields := array_append(v_changed_fields, 'year');
    v_before_state := jsonb_set(v_before_state, '{year}', to_jsonb(v_old_year));
    v_after_state := jsonb_set(v_after_state, '{year}', to_jsonb(p_year));
  END IF;
  IF coalesce(v_old_program_id, '00000000-0000-0000-0000-000000000000'::uuid) IS DISTINCT FROM p_program_id THEN
    v_changed_fields := array_append(v_changed_fields, 'program');
    v_before_state := jsonb_set(v_before_state, '{program}', jsonb_build_object('id', v_old_program_id, 'name', v_old_program_name));
    v_after_state := jsonb_set(v_after_state, '{program}', jsonb_build_object('id', p_program_id, 'name', v_program_name));
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) ORDER BY d.id), '[]'::jsonb) INTO v_old_disciplines
  FROM public.project_disciplines pd JOIN public.disciplines d ON pd.discipline_id = d.id WHERE pd.project_id = v_project_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) ORDER BY d.id), '[]'::jsonb) INTO v_new_disciplines
  FROM public.disciplines d WHERE d.id = ANY(p_discipline_ids);

  IF v_old_disciplines IS NOT DISTINCT FROM v_new_disciplines THEN
    v_discipline_name := v_old_discipline_name;
  ELSE
    v_changed_fields := array_append(v_changed_fields, 'disciplines');
    v_before_state := jsonb_set(v_before_state, '{disciplines}', v_old_disciplines);
    v_after_state := jsonb_set(v_after_state, '{disciplines}', v_new_disciplines);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ic.id, 'name', ic.name) ORDER BY ic.id), '[]'::jsonb) INTO v_old_industries
  FROM public.project_industry_categories pic JOIN public.industry_categories ic ON pic.industry_category_id = ic.id WHERE pic.project_id = v_project_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', ic.id, 'name', ic.name) ORDER BY ic.id), '[]'::jsonb) INTO v_new_industries
  FROM public.industry_categories ic WHERE ic.id = ANY(p_industry_category_ids);

  IF v_old_industries IS NOT DISTINCT FROM v_new_industries THEN
    v_industry_name := v_old_industry_name;
  ELSE
    v_changed_fields := array_append(v_changed_fields, 'industryCategories');
    v_before_state := jsonb_set(v_before_state, '{industryCategories}', v_old_industries);
    v_after_state := jsonb_set(v_after_state, '{industryCategories}', v_new_industries);
  END IF;

  IF array_length(v_changed_fields, 1) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'NO_CHANGES',
      'metadata', pg_catalog.jsonb_build_object(
        'publicId', v_public_id, 'title', v_old_title, 'summary', v_old_summary,
        'background', coalesce(v_old_background, ''), 'solution', coalesce(v_old_solution, ''),
        'posterText', coalesce(v_old_poster_text, ''), 'accessibilityText', coalesce(v_old_accessibility_text, ''),
        'year', v_old_year::text, 'programId', v_old_program_id::text,
        'disciplineIds', (SELECT coalesce(pg_catalog.jsonb_agg(d->>'id'), '[]'::jsonb) FROM jsonb_array_elements(v_old_disciplines) d),
        'industryCategoryIds', (SELECT coalesce(pg_catalog.jsonb_agg(ic->>'id'), '[]'::jsonb) FROM jsonb_array_elements(v_old_industries) ic),
        'expectedUpdatedAt', v_current_updated_at
      )
    );
  END IF;

  UPDATE public.projects SET title = v_title, summary = v_summary, background = v_background, solution = v_solution,
    poster_text_public = v_poster_text, accessibility_text_public = v_accessibility_text,
    year = p_year, program_id = p_program_id, program_name = v_program_name, discipline = v_discipline_name, industry = v_industry_name
  WHERE id = v_project_id RETURNING updated_at INTO v_updated_at;

  DELETE FROM public.project_disciplines WHERE project_id = v_project_id AND NOT (discipline_id = ANY(p_discipline_ids));
  INSERT INTO public.project_disciplines(project_id, discipline_id)
  SELECT v_project_id, x FROM pg_catalog.unnest(p_discipline_ids) x
  WHERE NOT EXISTS (SELECT 1 FROM public.project_disciplines retained WHERE retained.project_id = v_project_id AND retained.discipline_id = x);

  DELETE FROM public.project_industry_categories WHERE project_id = v_project_id AND NOT (industry_category_id = ANY(p_industry_category_ids));
  INSERT INTO public.project_industry_categories(project_id, industry_category_id)
  SELECT v_project_id, x FROM pg_catalog.unnest(p_industry_category_ids) x
  WHERE NOT EXISTS (SELECT 1 FROM public.project_industry_categories retained WHERE retained.project_id = v_project_id AND retained.industry_category_id = x);

  v_event_details := jsonb_build_object(
    'version', 1,
    'type', 'project_metadata',
    'changedFields', to_jsonb(v_changed_fields),
    'before', v_before_state,
    'after', v_after_state
  );

  INSERT INTO public.approval_records(project_id, admin_id, action_taken, from_status, to_status, comments, actor_full_name_snapshot, actor_email_snapshot, event_details)
  VALUES (v_project_id, p_admin_id, 'update_metadata', v_status, v_status, 'Updated project metadata.', v_actor_full_name, v_actor_email, v_event_details)
  RETURNING id INTO v_audit_record_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'metadata', pg_catalog.jsonb_build_object(
      'publicId', v_public_id, 'title', v_title, 'summary', v_summary, 'background', v_background, 'solution', v_solution,
      'posterText', v_poster_text, 'accessibilityText', v_accessibility_text,
      'year', p_year::text, 'programId', p_program_id::text,
      'disciplineIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_discipline_ids) x),
      'industryCategoryIds', (SELECT pg_catalog.jsonb_agg(x::text) FROM pg_catalog.unnest(p_industry_category_ids) x),
      'expectedUpdatedAt', v_updated_at
    ),
    'auditRecordId', v_audit_record_id::text
  );
END; $$;

REVOKE ALL ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid,text,text) TO service_role;


-- Native-title ranking v4 is a new durable run identity. Retain valid v3 evidence/heartbeats;
-- exact run/evidence and requested-worker identity checks remain unchanged. No rows are rewritten.
ALTER TABLE public.assistive_worker_heartbeats DROP CONSTRAINT check_assistive_worker_pipeline_version;
ALTER TABLE public.assistive_worker_heartbeats ADD CONSTRAINT check_assistive_worker_pipeline_version CHECK (pipeline_version IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4'));
ALTER TABLE assistive_execution_control.executor_registrations DROP CONSTRAINT check_execution_control_registration_pipeline;
ALTER TABLE assistive_execution_control.executor_registrations ADD CONSTRAINT check_execution_control_registration_pipeline CHECK (pipeline_version IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4'));

-- Forward definition from 20260828090000_assistive_language_findings.sql; only supported/current pipeline version changes.
CREATE OR REPLACE FUNCTION public.is_valid_assistive_language_evidence(p_evidence jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_suggestion jsonb;
  v_seen text[] := ARRAY[]::text[];
  v_keys text[] := ARRAY[
    'version', 'startOffset', 'endOffset', 'offsetUnit', 'originalSourceSpan',
    'contextExcerpt', 'languageCategory', 'ruleId', 'providerId', 'providerVersion',
    'suggestions', 'explanation', 'inputHash', 'pipelineVersion', 'policySha256'
  ];
BEGIN
  IF pg_catalog.jsonb_typeof(p_evidence) <> 'object'
     OR NOT (p_evidence ?& v_keys)
     OR (p_evidence - v_keys) <> '{}'::jsonb
     OR p_evidence ->> 'version' <> 'assistive-finding-evidence/v3'
     OR pg_catalog.jsonb_typeof(p_evidence -> 'startOffset') <> 'number'
     OR pg_catalog.jsonb_typeof(p_evidence -> 'endOffset') <> 'number'
     OR pg_catalog.length(p_evidence ->> 'startOffset') > 8
     OR pg_catalog.length(p_evidence ->> 'endOffset') > 8
     OR (p_evidence ->> 'startOffset')::numeric <> pg_catalog.trunc((p_evidence ->> 'startOffset')::numeric)
     OR (p_evidence ->> 'endOffset')::numeric <> pg_catalog.trunc((p_evidence ->> 'endOffset')::numeric)
     OR (p_evidence ->> 'startOffset')::numeric NOT BETWEEN 0 AND 10000
     OR (p_evidence ->> 'endOffset')::numeric NOT BETWEEN 0 AND 10000
     OR (p_evidence ->> 'endOffset')::numeric < (p_evidence ->> 'startOffset')::numeric
     OR p_evidence ->> 'offsetUnit' <> 'UNICODE_CODE_POINTS'
     OR pg_catalog.jsonb_typeof(p_evidence -> 'originalSourceSpan') <> 'string'
     OR pg_catalog.length(p_evidence ->> 'originalSourceSpan') > 400
     OR pg_catalog.length(p_evidence ->> 'originalSourceSpan')
          <> (p_evidence ->> 'endOffset')::integer - (p_evidence ->> 'startOffset')::integer
     OR (p_evidence ->> 'originalSourceSpan') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
     OR pg_catalog.jsonb_typeof(p_evidence -> 'contextExcerpt') <> 'string'
     OR pg_catalog.length(p_evidence ->> 'contextExcerpt') > 500
     OR (p_evidence ->> 'contextExcerpt') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
     OR COALESCE(p_evidence ->> 'languageCategory', '') !~ '^[A-Z][A-Z0-9_]{0,63}$'
     OR COALESCE(p_evidence ->> 'ruleId', '') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'
     OR p_evidence ->> 'providerId' <> 'LANGUAGETOOL'
     OR p_evidence ->> 'providerVersion' <> '6.6'
     OR COALESCE(p_evidence ->> 'inputHash', '') !~ '^[a-f0-9]{64}$'
     OR COALESCE(p_evidence ->> 'pipelineVersion', '') NOT IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4')
     OR p_evidence ->> 'policySha256' <> '3984b958741a5103791524d48ba262a81ef829695ddc122a728c12cc3e689148'
     OR pg_catalog.jsonb_typeof(p_evidence -> 'explanation') <> 'string'
     OR pg_catalog.length(p_evidence ->> 'explanation') NOT BETWEEN 1 AND 300
     OR (p_evidence ->> 'explanation') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
     OR pg_catalog.jsonb_typeof(p_evidence -> 'suggestions') <> 'array'
     OR pg_catalog.jsonb_array_length(p_evidence -> 'suggestions') NOT BETWEEN 0 AND 3
  THEN
    RETURN false;
  END IF;

  FOR v_suggestion IN SELECT * FROM pg_catalog.jsonb_array_elements(p_evidence -> 'suggestions') LOOP
    IF pg_catalog.jsonb_typeof(v_suggestion) <> 'string'
       OR pg_catalog.length(v_suggestion #>> '{}') NOT BETWEEN 1 AND 100
       OR pg_catalog.btrim(v_suggestion #>> '{}') = ''
       OR (v_suggestion #>> '{}') ~ U&'[\0001-\001F\007F]'
       OR (v_suggestion #>> '{}') = ANY(v_seen)
    THEN
      RETURN false;
    END IF;
    v_seen := pg_catalog.array_append(v_seen, v_suggestion #>> '{}');
  END LOOP;
  RETURN true;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END;
$$;

-- Forward definition from 20260828090000_assistive_language_findings.sql; only supported/current pipeline version changes.
CREATE OR REPLACE FUNCTION public.finalize_assistive_validation_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_input_hash text,
  p_status text,
  p_completion_code text,
  p_findings jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.assistive_validation_jobs%ROWTYPE;
  v_run public.assistive_validation_runs%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_status text := pg_catalog.btrim(COALESCE(p_status, ''));
  v_completion_code text := NULLIF(pg_catalog.btrim(COALESCE(p_completion_code, '')), '');
  v_existing_run_id uuid;
  v_existing_findings jsonb;
  v_existing_count integer;
  v_finding_count integer;
BEGIN
  IF p_job_id IS NULL OR p_claim_token IS NULL
     OR COALESCE(p_input_hash, '') !~ '^[a-f0-9]{64}$'
     OR v_status NOT IN ('COMPLETED', 'PARTIAL')
     OR (v_status = 'COMPLETED' AND v_completion_code IS NOT NULL)
     OR (v_status = 'PARTIAL' AND v_completion_code NOT IN (
       'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE', 'LANGUAGE_PROVIDER_UNAVAILABLE',
       'OCR_AND_LANGUAGE_INCOMPLETE'))
     OR NOT public.is_valid_assistive_validation_findings(p_findings)
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(p_findings) AS finding
       WHERE finding ->> 'checkType' = 'LANGUAGE_SUGGESTION'
         AND (finding #>> '{evidence,inputHash}' <> p_input_hash
           OR COALESCE(finding #>> '{evidence,pipelineVersion}', '') NOT IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4')))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_job FROM public.assistive_validation_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status NOT IN ('EXTRACTING', 'CHECKING')
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until <= v_now
  THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'CLAIM_LOST'); END IF;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    UPDATE public.assistive_validation_jobs
       SET status = 'CANCELLED', lease_until = NULL, claim_token = NULL,
           cancelled_at = v_now, updated_at = v_now WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'CANCELLED', failure_code = NULL, completed_at = v_now WHERE id = v_job.run_id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CANCELLED');
  END IF;

  SELECT * INTO v_run FROM public.assistive_validation_runs WHERE id = v_job.run_id;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_findings) finding
    WHERE finding->>'checkType' = 'LANGUAGE_SUGGESTION'
      AND finding #>> '{evidence,pipelineVersion}' IS DISTINCT FROM v_run.pipeline_version) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;
  IF p_input_hash IS DISTINCT FROM v_run.input_hash THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INPUT_CHANGED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_run.project_id::text || ':' || v_run.input_hash || ':' || v_run.pipeline_version));

  SELECT r.id INTO v_existing_run_id
    FROM public.assistive_validation_runs AS r
   WHERE r.project_id = v_run.project_id AND r.input_hash = v_run.input_hash
     AND r.pipeline_version = v_run.pipeline_version AND r.status = 'COMPLETED' AND r.id <> v_run.id;

  IF FOUND THEN
    SELECT pg_catalog.count(*), COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'checkType', f.check_type, 'outcome', f.outcome, 'classification', f.classification,
        'reasonCode', f.reason_code, 'affectedField', f.affected_field, 'origin', f.origin,
        'scoreKind', f.score_kind, 'scoreValue', f.score_value, 'evidence', f.evidence)
      ORDER BY f.ordinal), '[]'::jsonb)
    INTO v_existing_count, v_existing_findings
    FROM public.assistive_validation_findings AS f WHERE f.run_id = v_existing_run_id;

    IF v_status = 'COMPLETED' AND v_existing_findings IS NOT DISTINCT FROM p_findings THEN
      UPDATE public.assistive_validation_jobs
         SET status = 'SUPERSEDED', lease_until = NULL, claim_token = NULL, updated_at = v_now
       WHERE id = p_job_id;
      UPDATE public.assistive_validation_runs
         SET status = 'SUPERSEDED', failure_code = NULL, completed_at = v_now WHERE id = v_run.id;
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'ALREADY_COMPLETED', 'runId', v_existing_run_id::text,
        'status', 'COMPLETED', 'findingCount', v_existing_count);
    END IF;

    UPDATE public.assistive_validation_jobs
       SET status = 'FAILED', lease_until = NULL, claim_token = NULL,
           last_error_code = 'IDENTITY_CONFLICT', updated_at = v_now WHERE id = p_job_id;
    UPDATE public.assistive_validation_runs
       SET status = 'FAILED', failure_code = 'IDENTITY_CONFLICT', completed_at = v_now WHERE id = v_run.id;
    RETURN pg_catalog.jsonb_build_object('resultCode', 'IDENTITY_CONFLICT');
  END IF;

  INSERT INTO public.assistive_validation_findings (
    run_id, check_type, outcome, classification, reason_code, affected_field, origin,
    ordinal, score_kind, score_value, evidence)
  SELECT v_run.id, element.value ->> 'checkType', element.value ->> 'outcome', 'NON_BLOCKING',
    element.value ->> 'reasonCode', element.value ->> 'affectedField', element.value ->> 'origin',
    element.position::integer, element.value ->> 'scoreKind',
    CASE WHEN pg_catalog.jsonb_typeof(element.value -> 'scoreValue') = 'number'
      THEN (element.value ->> 'scoreValue')::numeric ELSE NULL END,
    element.value -> 'evidence'
  FROM pg_catalog.jsonb_array_elements(p_findings) WITH ORDINALITY AS element(value, position);

  v_finding_count := pg_catalog.jsonb_array_length(p_findings);
  UPDATE public.assistive_validation_jobs
     SET status = v_status, lease_until = NULL, claim_token = NULL,
         last_error_code = v_completion_code, updated_at = v_now WHERE id = p_job_id;
  UPDATE public.assistive_validation_runs
     SET status = v_status, failure_code = v_completion_code, completed_at = v_now WHERE id = v_run.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'FINALIZED', 'runId', v_run.id::text,
    'status', v_status, 'findingCount', v_finding_count);
EXCEPTION WHEN check_violation OR data_exception THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

-- Forward definition from 20260910120200_assistive_worker_production_identity.sql; only supported/current pipeline version changes.
CREATE OR REPLACE FUNCTION public.upsert_assistive_worker_heartbeat(
  p_worker_instance_id text,
  p_environment text,
  p_pipeline_version text,
  p_deployment_version text,
  p_ocr_capability text,
  p_language_capability text,
  p_health_state text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE(p_worker_instance_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     OR p_environment IS NULL
     OR p_environment NOT IN ('staging', 'production')
     OR (p_pipeline_version IS NULL OR p_pipeline_version NOT IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4'))
     OR COALESCE(p_deployment_version, '') !~ '^[a-f0-9]{40}$'
     OR p_ocr_capability IS DISTINCT FROM 'paddle-title/pp-ocrv6-small@3.7.0'
     OR p_language_capability IS DISTINCT FROM 'languagetool/en-au@6.6'
     OR p_health_state IS NULL
     OR p_health_state NOT IN ('READY', 'STOPPING')
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- A provider instance ID is one immutable environment identity. Never relabel an existing row.
  IF EXISTS (
    SELECT 1
      FROM public.assistive_worker_heartbeats
     WHERE worker_instance_id = p_worker_instance_id
       AND environment <> p_environment
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  INSERT INTO public.assistive_worker_heartbeats AS current_heartbeat (
    worker_instance_id, environment, pipeline_version, deployment_version,
    ocr_capability, language_capability, health_state, heartbeat_at
  ) VALUES (
    p_worker_instance_id, p_environment, p_pipeline_version, p_deployment_version,
    p_ocr_capability, p_language_capability, p_health_state, v_now
  )
  ON CONFLICT (worker_instance_id) DO UPDATE SET
    pipeline_version = EXCLUDED.pipeline_version,
    deployment_version = EXCLUDED.deployment_version,
    ocr_capability = EXCLUDED.ocr_capability,
    language_capability = EXCLUDED.language_capability,
    health_state = EXCLUDED.health_state,
    heartbeat_at = EXCLUDED.heartbeat_at
  WHERE current_heartbeat.environment = EXCLUDED.environment;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- Instance identities change across deploys. Retain only a bounded operational window.
  DELETE FROM public.assistive_worker_heartbeats
   WHERE heartbeat_at < v_now - pg_catalog.make_interval(days => 7);

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'HEARTBEAT_RECORDED',
    'healthState', p_health_state,
    'heartbeatAt', v_now
  );
EXCEPTION WHEN check_violation OR data_exception OR unique_violation THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;

-- Forward definition from 20260910120200_assistive_worker_production_identity.sql; only supported/current pipeline version changes.
CREATE OR REPLACE FUNCTION public.get_assistive_worker_availability(
  p_environment text,
  p_pipeline_version text,
  p_deployment_version text,
  p_ocr_capability text,
  p_language_capability text,
  p_freshness_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_count integer;
  v_latest timestamptz;
BEGIN
  IF p_environment IS NULL
     OR p_environment NOT IN ('staging', 'production')
     OR (p_pipeline_version IS NULL OR p_pipeline_version NOT IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4'))
     OR COALESCE(p_deployment_version, '') !~ '^[a-f0-9]{40}$'
     OR p_ocr_capability IS DISTINCT FROM 'paddle-title/pp-ocrv6-small@3.7.0'
     OR p_language_capability IS DISTINCT FROM 'languagetool/en-au@6.6'
     OR p_freshness_seconds IS NULL
     OR p_freshness_seconds NOT BETWEEN 30 AND 120
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.count(*)::integer, pg_catalog.max(heartbeat_at)
    INTO v_count, v_latest
    FROM public.assistive_worker_heartbeats
   WHERE environment = p_environment
     AND pipeline_version = p_pipeline_version
     AND deployment_version = p_deployment_version
     AND ocr_capability = p_ocr_capability
     AND language_capability = p_language_capability
     AND health_state = 'READY'
     AND heartbeat_at >= v_now - pg_catalog.make_interval(secs => p_freshness_seconds);

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', CASE WHEN v_count > 0 THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END,
    'compatibleWorkerCount', v_count,
    'latestHeartbeatAt', v_latest
  );
END;
$$;

-- Forward definition from 20260828170000_assistive_execution_control.sql; only supported/current pipeline version changes.
-- The original four-argument v3 registration remains unchanged. New callers attest their explicit supported pipeline through this separate overload.
CREATE OR REPLACE FUNCTION public.register_assistive_executor(
  p_deployment_version text,
  p_image_digest text,
  p_configuration_version text,
  p_registration_days integer,
  p_pipeline_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_deployment text := pg_catalog.lower(COALESCE(p_deployment_version, ''));
  v_digest text := pg_catalog.lower(COALESCE(p_image_digest, ''));
  v_expires timestamptz;
BEGIN
  IF p_pipeline_version IS NULL OR p_pipeline_version NOT IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4')
     OR v_deployment !~ '^[a-f0-9]{40}$'
     OR v_digest !~ '^sha256:[a-f0-9]{64}$'
     OR COALESCE(p_configuration_version, '') !~ '^[a-z0-9][a-z0-9./-]{0,63}$'
     OR p_registration_days IS NULL
     OR p_registration_days NOT BETWEEN 1 AND 180
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  v_expires := v_now + pg_catalog.make_interval(days => p_registration_days);

  INSERT INTO assistive_execution_control.executor_registrations (
    environment, execution_mode, pipeline_version, deployment_version, image_digest,
    ocr_capability, language_capability, configuration_version, registered_at, expires_at
  ) VALUES (
    'staging', 'ON_DEMAND', p_pipeline_version, v_deployment, v_digest,
    'paddle-title/pp-ocrv6-small@3.7.0', 'languagetool/en-au@6.6',
    p_configuration_version, v_now, v_expires
  )
  ON CONFLICT (environment, execution_mode) DO UPDATE SET
    pipeline_version = EXCLUDED.pipeline_version,
    deployment_version = EXCLUDED.deployment_version,
    image_digest = EXCLUDED.image_digest,
    ocr_capability = EXCLUDED.ocr_capability,
    language_capability = EXCLUDED.language_capability,
    configuration_version = EXCLUDED.configuration_version,
    registered_at = EXCLUDED.registered_at,
    expires_at = EXCLUDED.expires_at;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'REGISTERED',
    'deploymentVersion', v_deployment,
    'imageDigest', v_digest,
    'expiresAt', v_expires
  );
EXCEPTION WHEN check_violation OR data_exception THEN
  RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
END;
$$;
REVOKE ALL ON FUNCTION public.register_assistive_executor(text,text,text,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.register_assistive_executor(text,text,text,integer,text) TO service_role;


-- Forward definition from 20260828170000_assistive_execution_control.sql; only supported/current pipeline version changes.
CREATE OR REPLACE FUNCTION public.get_assistive_executor_availability(
  p_pipeline_version text,
  p_deployment_version text,
  p_image_digest text,
  p_ocr_capability text,
  p_language_capability text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_guard assistive_execution_control.launch_budget_guard%ROWTYPE;
  v_registration assistive_execution_control.executor_registrations%ROWTYPE;
  v_deployment text := pg_catalog.lower(COALESCE(p_deployment_version, ''));
  v_digest text := pg_catalog.lower(COALESCE(p_image_digest, ''));
  v_consumed integer;
  v_month_starts integer;
  v_active integer;
  v_result_code text;
BEGIN
  IF (p_pipeline_version IS NULL OR p_pipeline_version NOT IN ('assistive-deterministic-checks/v3','assistive-deterministic-checks/v4'))
     OR v_deployment !~ '^[a-f0-9]{40}$'
     OR v_digest !~ '^sha256:[a-f0-9]{64}$'
     OR p_ocr_capability IS DISTINCT FROM 'paddle-title/pp-ocrv6-small@3.7.0'
     OR p_language_capability IS DISTINCT FROM 'languagetool/en-au@6.6'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_guard
    FROM assistive_execution_control.launch_budget_guard
   WHERE environment = 'staging';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.count(*)::integer INTO v_consumed
    FROM assistive_execution_control.launch_reservations
   WHERE counts_against_budget
     AND reserved_at > v_now - pg_catalog.make_interval(days => v_guard.window_days);

  -- Reporting only.
  SELECT pg_catalog.count(*)::integer INTO v_month_starts
    FROM assistive_execution_control.launch_reservations
   WHERE counts_against_budget
     AND reserved_at >= pg_catalog.date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  SELECT pg_catalog.count(*)::integer INTO v_active
    FROM assistive_execution_control.launch_reservations
   WHERE environment = 'staging'
     AND expires_at > v_now
     AND state IN (
       'RESERVED', 'START_REQUESTED', 'START_ACCEPTED',
       'START_RESPONSE_ERROR', 'START_AMBIGUOUS', 'EXECUTION_CLAIMED'
     );

  SELECT * INTO v_registration
    FROM assistive_execution_control.executor_registrations
   WHERE environment = 'staging'
     AND execution_mode = 'ON_DEMAND'
     AND expires_at > v_now
     AND pipeline_version = p_pipeline_version
     AND deployment_version = v_deployment
     AND image_digest = v_digest
     AND ocr_capability = p_ocr_capability
     AND language_capability = p_language_capability;

  IF NOT FOUND THEN
    v_result_code := 'UNAVAILABLE';
  ELSIF v_consumed >= v_guard.launch_limit THEN
    v_result_code := 'BUDGET_EXHAUSTED';
  ELSE
    v_result_code := 'AVAILABLE';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', v_result_code,
    'executionMode', 'ON_DEMAND',
    'launchLimit', v_guard.launch_limit,
    'windowDays', v_guard.window_days,
    'consumedInWindow', v_consumed,
    -- GREATEST is a SQL construct rather than a catalog function, so it needs no qualification.
    'remainingInWindow', GREATEST(v_guard.launch_limit - v_consumed, 0),
    'activeExecutions', v_active,
    'utcCalendarMonthStarts', v_month_starts,
    'lastExecutionAt', v_registration.last_execution_at,
    'registrationExpiresAt', v_registration.expires_at
  );
END;
$$;

-- Preserve existing catalogue rows; serialize only new/changed normalized names.
-- This complements lifecycle NOWAIT reference fencing and also covers ordinary create calls.
CREATE FUNCTION public.guard_taxonomy_normalized_name()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $name_guard$
DECLARE normalized text; duplicate_name boolean; exact_name_exists boolean;
BEGIN
  IF TG_TABLE_NAME NOT IN ('programs','disciplines','industry_categories') THEN RAISE EXCEPTION 'TAXONOMY_NAME_GUARD_TABLE_INVALID'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name THEN RETURN NEW; END IF;
  normalized := pg_catalog.lower(pg_catalog.btrim(NEW.name));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('capstone.taxonomy_name:' || TG_TABLE_NAME || ':' || normalized, 0));
  -- Preserve exact-name ON CONFLICT DO NOTHING imports; ordinary UNIQUE(name) still owns that conflict.
  IF TG_OP = 'INSERT' THEN
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE name=$1)', TG_TABLE_NAME)
      INTO exact_name_exists USING NEW.name;
    IF exact_name_exists THEN RETURN NEW; END IF;
  END IF;
  EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE lower(btrim(name))=$1 AND id IS DISTINCT FROM $2)', TG_TABLE_NAME)
    INTO duplicate_name USING normalized, NEW.id;
  IF duplicate_name THEN RAISE EXCEPTION 'TAXONOMY_NAME_DUPLICATE' USING ERRCODE = '23505'; END IF;
  RETURN NEW;
END; $name_guard$;
REVOKE ALL ON FUNCTION public.guard_taxonomy_normalized_name() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER taxonomy_normalized_name BEFORE INSERT OR UPDATE OF name ON public.programs FOR EACH ROW EXECUTE FUNCTION public.guard_taxonomy_normalized_name();
CREATE TRIGGER taxonomy_normalized_name BEFORE INSERT OR UPDATE OF name ON public.disciplines FOR EACH ROW EXECUTE FUNCTION public.guard_taxonomy_normalized_name();
CREATE TRIGGER taxonomy_normalized_name BEFORE INSERT OR UPDATE OF name ON public.industry_categories FOR EACH ROW EXECUTE FUNCTION public.guard_taxonomy_normalized_name();

CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT '20260918120000_governed_project_maintenance|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1|archived_project_restore_v1|archived_project_republish_media_rearm_v1|governed_project_soft_delete_v1|governed_project_maintenance_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel() TO service_role;

COMMIT;
