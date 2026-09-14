-- Named, reusable layout recipes compiled into the existing LayoutConfig wire by value.
-- Recipe administration state never enters project, participant-preview, or public-feed records.
-- Only the resolved existing LayoutConfig value is copied into new project/preview evidence.

BEGIN;

CREATE OR REPLACE FUNCTION public.layout_recipe_config_valid(p_config jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_section_count integer;
  v_distinct_section_count integer;
  v_hidden_count integer;
  v_distinct_hidden_count integer;
BEGIN
  IF p_config IS NULL
     OR pg_catalog.jsonb_typeof(p_config) <> 'object'
     OR NOT (p_config ?& ARRAY['templateId', 'featuredMedia', 'sectionOrder', 'hiddenSections'])
     OR p_config - ARRAY['templateId', 'featuredMedia', 'sectionOrder', 'hiddenSections'] <> '{}'::jsonb
     OR p_config->>'templateId' NOT IN ('poster_showcase', 'technical_detail', 'media_rich')
     OR p_config->>'featuredMedia' NOT IN ('auto', 'poster', 'snapshots', 'video', 'none')
     OR pg_catalog.jsonb_typeof(p_config->'sectionOrder') <> 'array'
     OR pg_catalog.jsonb_typeof(p_config->'hiddenSections') <> 'array'
  THEN
    RETURN false;
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT value)
    INTO v_section_count, v_distinct_section_count
    FROM pg_catalog.jsonb_array_elements_text(p_config->'sectionOrder');

  IF v_section_count <> 8
     OR v_distinct_section_count <> 8
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements_text(p_config->'sectionOrder') AS section(value)
       WHERE section.value NOT IN (
         'background', 'solution', 'snapshots', 'video',
         'team', 'links', 'citations', 'accessibilityText'
       )
     )
  THEN
    RETURN false;
  END IF;

  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT value)
    INTO v_hidden_count, v_distinct_hidden_count
    FROM pg_catalog.jsonb_array_elements_text(p_config->'hiddenSections');

  IF v_hidden_count > 5
     OR v_distinct_hidden_count <> v_hidden_count
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements_text(p_config->'hiddenSections') AS section(value)
       WHERE section.value NOT IN ('background', 'solution', 'video', 'links', 'citations')
     )
     OR (p_config->>'featuredMedia' = 'video' AND p_config->'hiddenSections' ? 'video')
  THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.layout_recipe_config_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.layout_recipe_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  name text NOT NULL CHECK (
    name = pg_catalog.btrim(name)
    AND pg_catalog.length(name) BETWEEN 1 AND 120
    AND name !~ '[[:cntrl:]]'
  ),
  layout_config jsonb NOT NULL CHECK (public.layout_recipe_config_valid(layout_config)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retired')),
  source_version_id uuid NULL REFERENCES public.layout_recipe_versions(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  retired_by uuid NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  retired_at timestamptz NULL,
  CONSTRAINT uq_layout_recipe_version UNIQUE (recipe_id, version),
  CONSTRAINT ck_layout_recipe_retirement_consistent CHECK (
    (status = 'retired' AND retired_by IS NOT NULL AND retired_at IS NOT NULL)
    OR (status <> 'retired' AND retired_by IS NULL AND retired_at IS NULL)
  )
);

CREATE UNIQUE INDEX uq_layout_recipe_active_name
  ON public.layout_recipe_versions (pg_catalog.lower(name))
  WHERE status = 'active';

CREATE INDEX idx_layout_recipe_versions_lineage
  ON public.layout_recipe_versions (recipe_id, version DESC);

CREATE TABLE public.layout_recipe_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL,
  recipe_version_id uuid NOT NULL REFERENCES public.layout_recipe_versions(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('create', 'duplicate', 'version', 'retire')),
  actor_admin_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  source_version_id uuid NULL REFERENCES public.layout_recipe_versions(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.layout_recipe_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layout_recipe_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.layout_recipe_versions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.layout_recipe_audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.layout_recipe_versions TO service_role;
GRANT SELECT ON TABLE public.layout_recipe_audit_events TO service_role;

CREATE OR REPLACE FUNCTION public.layout_recipe_actor_can_manage(p_actor_admin_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_actor_admin_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.admin_users AS actor
      JOIN public.user_roles AS role_row
        ON role_row.user_id = actor.id
       AND role_row.role = 'admin'
      WHERE actor.id = p_actor_admin_id
        AND actor.auth_user_id IS NOT NULL
        AND actor.lifecycle_status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.staff_provisioning_requests AS request
      WHERE request.admin_user_id = p_actor_admin_id
        AND request.status = 'pending_activation'
    );
$$;

REVOKE ALL ON FUNCTION public.layout_recipe_actor_can_manage(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_layout_recipe(
  p_actor_admin_id uuid,
  p_name text,
  p_layout_config jsonb,
  p_source_version_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text := pg_catalog.btrim(COALESCE(p_name, ''));
  v_config jsonb := p_layout_config;
  v_recipe_id uuid := gen_random_uuid();
  v_created public.layout_recipe_versions%ROWTYPE;
  v_source public.layout_recipe_versions%ROWTYPE;
  v_action text := 'create';
BEGIN
  IF NOT public.layout_recipe_actor_can_manage(p_actor_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  IF v_name = ''
     OR pg_catalog.length(v_name) > 120
     OR v_name ~ '[[:cntrl:]]'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF p_source_version_id IS NOT NULL THEN
    SELECT * INTO v_source
      FROM public.layout_recipe_versions
      WHERE id = p_source_version_id;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
    END IF;
    v_config := v_source.layout_config;
    v_action := 'duplicate';
  END IF;

  IF NOT public.layout_recipe_config_valid(v_config) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('layout_recipe_name:' || pg_catalog.lower(v_name), 0)
  );

  BEGIN
    INSERT INTO public.layout_recipe_versions (
      recipe_id, version, name, layout_config, source_version_id, created_by
    ) VALUES (
      v_recipe_id, 1, v_name, v_config, p_source_version_id, p_actor_admin_id
    ) RETURNING * INTO v_created;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'DUPLICATE_NAME');
  END;

  INSERT INTO public.layout_recipe_audit_events (
    recipe_id, recipe_version_id, action, actor_admin_id, source_version_id
  ) VALUES (
    v_created.recipe_id, v_created.id, v_action, p_actor_admin_id, p_source_version_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', CASE WHEN v_action = 'duplicate' THEN 'DUPLICATED' ELSE 'CREATED' END,
    'recipeVersionId', v_created.id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.version_layout_recipe(
  p_actor_admin_id uuid,
  p_source_version_id uuid,
  p_expected_version integer,
  p_name text,
  p_layout_config jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text := pg_catalog.btrim(COALESCE(p_name, ''));
  v_source public.layout_recipe_versions%ROWTYPE;
  v_created public.layout_recipe_versions%ROWTYPE;
BEGIN
  IF NOT public.layout_recipe_actor_can_manage(p_actor_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF p_source_version_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR v_name = ''
     OR pg_catalog.length(v_name) > 120
     OR v_name ~ '[[:cntrl:]]'
     OR NOT public.layout_recipe_config_valid(p_layout_config)
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_source
    FROM public.layout_recipe_versions
    WHERE id = p_source_version_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;
  IF v_source.status <> 'active' OR v_source.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VERSION_CONFLICT');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('layout_recipe_name:' || pg_catalog.lower(v_name), 0)
  );

  BEGIN
    UPDATE public.layout_recipe_versions
      SET status = 'superseded'
      WHERE id = v_source.id AND status = 'active';

    INSERT INTO public.layout_recipe_versions (
      recipe_id, version, name, layout_config, source_version_id, created_by
    ) VALUES (
      v_source.recipe_id, v_source.version + 1, v_name, p_layout_config,
      v_source.id, p_actor_admin_id
    ) RETURNING * INTO v_created;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'DUPLICATE_NAME');
  END;

  INSERT INTO public.layout_recipe_audit_events (
    recipe_id, recipe_version_id, action, actor_admin_id, source_version_id
  ) VALUES (
    v_created.recipe_id, v_created.id, 'version', p_actor_admin_id, v_source.id
  );

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'VERSIONED',
    'recipeVersionId', v_created.id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.retire_layout_recipe(
  p_actor_admin_id uuid,
  p_recipe_version_id uuid,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipe public.layout_recipe_versions%ROWTYPE;
BEGIN
  IF NOT public.layout_recipe_actor_can_manage(p_actor_admin_id) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF p_recipe_version_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_recipe
    FROM public.layout_recipe_versions
    WHERE id = p_recipe_version_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;
  IF v_recipe.status <> 'active' OR v_recipe.version <> p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VERSION_CONFLICT');
  END IF;

  UPDATE public.layout_recipe_versions
    SET status = 'retired', retired_by = p_actor_admin_id, retired_at = pg_catalog.now()
    WHERE id = v_recipe.id;

  INSERT INTO public.layout_recipe_audit_events (
    recipe_id, recipe_version_id, action, actor_admin_id, source_version_id
  ) VALUES (
    v_recipe.recipe_id, v_recipe.id, 'retire', p_actor_admin_id, v_recipe.source_version_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RETIRED',
    'recipeVersionId', v_recipe.id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_layout_recipe(uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.version_layout_recipe(uuid, uuid, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retire_layout_recipe(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_layout_recipe(uuid, text, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.version_layout_recipe(uuid, uuid, integer, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.retire_layout_recipe(uuid, uuid, integer) TO service_role;

--------------------------------------------------------------------------------
-- Immutable resolved layout evidence for participant previews.
--
-- Historical previews remain NULL and retain their exact legacy rendering/readiness behaviour.
-- New previews capture only a fully resolved recipe-compatible LayoutConfig by value; recipe ids,
-- names, versions, and lifecycle state never cross this boundary.
--------------------------------------------------------------------------------
ALTER TABLE public.participant_previews
  ADD COLUMN layout_config_snapshot jsonb NULL
  CONSTRAINT participant_preview_layout_config_snapshot_valid
  CHECK (
    layout_config_snapshot IS NULL
    OR public.layout_recipe_config_valid(layout_config_snapshot)
  );

CREATE OR REPLACE FUNCTION public.capture_participant_preview_layout_config()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_layout_config jsonb;
BEGIN
  SELECT project.layout_config
    INTO v_layout_config
    FROM public.projects AS project
   WHERE project.id = NEW.project_id;

  NEW.layout_config_snapshot := CASE
    WHEN public.layout_recipe_config_valid(v_layout_config) THEN v_layout_config
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_participant_preview_layout_config_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.layout_config_snapshot IS DISTINCT FROM OLD.layout_config_snapshot THEN
    RAISE EXCEPTION 'participant preview layout evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_participant_preview_layout_config
  BEFORE INSERT ON public.participant_previews
  FOR EACH ROW EXECUTE FUNCTION public.capture_participant_preview_layout_config();

CREATE TRIGGER participant_preview_layout_config_immutable
  BEFORE UPDATE OF layout_config_snapshot ON public.participant_previews
  FOR EACH ROW EXECUTE FUNCTION public.guard_participant_preview_layout_config_immutable();

REVOKE ALL ON FUNCTION public.capture_participant_preview_layout_config() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_participant_preview_layout_config_immutable() FROM PUBLIC, anon, authenticated;

--------------------------------------------------------------------------------
-- Preserve the established readiness implementations behind narrow wrappers. A confirmed
-- pre-migration preview has no layout snapshot and follows the old result byte-for-byte. A new
-- preview must still match the current project LayoutConfig before publication/reconciliation.
--------------------------------------------------------------------------------
ALTER FUNCTION public.get_project_publication_readiness(text, uuid, text)
  RENAME TO get_project_publication_readiness_without_layout_recipe;

CREATE FUNCTION public.get_project_publication_readiness(
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
  v_result jsonb;
  v_current_layout jsonb;
  v_confirmed_layout jsonb;
BEGIN
  v_result := public.get_project_publication_readiness_without_layout_recipe(
    p_public_id,
    p_admin_id,
    p_private_bucket
  );

  IF v_result->>'resultCode' <> 'READY' THEN
    RETURN v_result;
  END IF;

  SELECT project.layout_config, preview.layout_config_snapshot
    INTO v_current_layout, v_confirmed_layout
    FROM public.projects AS project
    JOIN public.participant_previews AS preview
      ON preview.project_id = project.id
     AND preview.status = 'active'
   WHERE project.public_id = pg_catalog.btrim(p_public_id)
     AND project.deleted_at IS NULL;

  IF v_confirmed_layout IS NOT NULL
     AND v_current_layout IS DISTINCT FROM v_confirmed_layout
  THEN
    RETURN v_result || pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project layout changed after participant confirmation'])
    );
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_project_publication_readiness_without_layout_recipe(text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_project_publication_readiness(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_publication_readiness(text, uuid, text) TO service_role;

ALTER FUNCTION public.get_project_reconciliation_readiness(text, uuid, text)
  RENAME TO get_project_reconciliation_readiness_without_layout_recipe;

CREATE FUNCTION public.get_project_reconciliation_readiness(
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
  v_result jsonb;
  v_current_layout jsonb;
  v_confirmed_layout jsonb;
BEGIN
  v_result := public.get_project_reconciliation_readiness_without_layout_recipe(
    p_public_id,
    p_admin_id,
    p_private_bucket
  );

  IF v_result->>'resultCode' <> 'READY' THEN
    RETURN v_result;
  END IF;

  SELECT project.layout_config, preview.layout_config_snapshot
    INTO v_current_layout, v_confirmed_layout
    FROM public.projects AS project
    JOIN public.participant_previews AS preview
      ON preview.project_id = project.id
     AND preview.status = 'active'
   WHERE project.public_id = pg_catalog.btrim(p_public_id)
     AND project.deleted_at IS NULL;

  IF v_confirmed_layout IS NOT NULL
     AND v_current_layout IS DISTINCT FROM v_confirmed_layout
  THEN
    RETURN v_result || pg_catalog.jsonb_build_object(
      'ready', false,
      'resultCode', 'PROJECT_SNAPSHOT_STALE',
      'blockers', pg_catalog.to_jsonb(ARRAY['Project layout changed after participant confirmation'])
    );
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_project_reconciliation_readiness_without_layout_recipe(text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_reconciliation_readiness(text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT '20260914100000_layout_recipe_library|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1|assistive_worker_environment_identity_v1|gallery_text_equivalent_v1|layout_recipe_library_v1'::text
$$;

REVOKE ALL ON FUNCTION public.get_release_capability_sentinel() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel() TO service_role;

COMMIT;
