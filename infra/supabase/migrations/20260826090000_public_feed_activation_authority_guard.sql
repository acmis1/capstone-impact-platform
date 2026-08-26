-- Issue #203 correction: make a bound activation candidate authoritative through its first
-- durable write/observation boundary. Storage I/O is deliberately absent from this migration.

BEGIN;

/**
 * Every activation phase change and every mutation capable of changing compilePublicFeed's
 * lifecycle-published projection takes this same transaction lock. The mutation trigger then
 * fails closed while a bound activation is still pre-write. This closes both directions of the
 * race: a mutation already in flight commits before PREPARED is established, while a mutation
 * arriving after PREPARED cannot cross the authority boundary.
 */
CREATE OR REPLACE FUNCTION public.lock_public_feed_activation_authority_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.kind = 'activation' AND NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('public_feed_activation_projection')
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lock_public_feed_activation_authority_transition
  BEFORE UPDATE OF state ON public.public_feed_operations
  FOR EACH ROW EXECUTE FUNCTION public.lock_public_feed_activation_authority_transition();

CREATE OR REPLACE FUNCTION public.guard_public_feed_activation_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_relevant boolean := false;
  v_old_project_id uuid;
  v_new_project_id uuid;
  v_old_discipline_id uuid;
  v_new_discipline_id uuid;
BEGIN
  -- Take the lock before reading project lifecycle or operation state. Even a mutation that is
  -- currently unrelated must serialize with a concurrent status change that could make it public.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public_feed_activation_projection')
  );

  IF TG_TABLE_NAME = 'projects' THEN
    IF TG_OP = 'INSERT' THEN
      v_relevant := NEW.status = 'published' AND NEW.deleted_at IS NULL;
    ELSIF TG_OP = 'DELETE' THEN
      v_relevant := OLD.status = 'published' AND OLD.deleted_at IS NULL;
    ELSE
      v_relevant := (OLD.status = 'published' AND OLD.deleted_at IS NULL)
        OR (NEW.status = 'published' AND NEW.deleted_at IS NULL);
    END IF;
  ELSIF TG_TABLE_NAME = 'media_assets' THEN
    IF TG_OP <> 'INSERT' THEN v_old_project_id := OLD.project_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_project_id := NEW.project_id; END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id IN (v_old_project_id, v_new_project_id)
        AND p.status = 'published'
        AND p.deleted_at IS NULL
    ) AND (
      (TG_OP <> 'INSERT'
        AND OLD.asset_type = 'snapshot_image'
        AND OLD.is_public_approved = true
        AND COALESCE(OLD.public_url, '') <> '')
      OR
      (TG_OP <> 'DELETE'
        AND NEW.asset_type = 'snapshot_image'
        AND NEW.is_public_approved = true
        AND COALESCE(NEW.public_url, '') <> '')
    ) INTO v_relevant;
  ELSIF TG_TABLE_NAME = 'project_disciplines' THEN
    IF TG_OP <> 'INSERT' THEN v_old_project_id := OLD.project_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new_project_id := NEW.project_id; END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id IN (v_old_project_id, v_new_project_id)
        AND p.status = 'published'
        AND p.deleted_at IS NULL
    ) INTO v_relevant;
  ELSIF TG_TABLE_NAME = 'disciplines' THEN
    v_old_discipline_id := OLD.id;
    IF TG_OP <> 'DELETE' THEN v_new_discipline_id := NEW.id; END IF;
    SELECT EXISTS (
      SELECT 1
      FROM public.project_disciplines pd
      JOIN public.projects p ON p.id = pd.project_id
      WHERE pd.discipline_id IN (v_old_discipline_id, v_new_discipline_id)
        AND p.status = 'published'
        AND p.deleted_at IS NULL
    ) INTO v_relevant;
  END IF;

  IF v_relevant AND EXISTS (
    SELECT 1
    FROM public.public_feed_operations o
    WHERE o.kind = 'activation'
      AND o.storage_request_generation = 0
      AND (
        o.state = 'PREPARED'
        OR (
          o.state = 'RECOVERY_REQUIRED'
          AND o.recovery_from_state = 'PREPARED'
        )
      )
  ) THEN
    RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_FROZEN';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Project columns emitted by toPublicFeedRecord, plus lifecycle membership and created_at because
-- listProjects orders the canonical activation feed by created_at/public_id.
CREATE TRIGGER guard_projects_during_public_feed_activation
  BEFORE INSERT OR DELETE OR UPDATE OF
    public_id, title, summary, background, solution, year, program_name, study_program,
    discipline, industry, industry_partner, academic_supervisor, group_name, team_members,
    poster_url, poster_pdf_url, poster_text_public, accessibility_text_public, snapshots,
    video_url, demo_url, repository_url, external_links, citations, layout_config,
    status, deleted_at, created_at
  ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.guard_public_feed_activation_projection();

-- Snapshot media public URL, alt text, approval identity, and gallery position are the only media
-- columns consumed by the project mapper. Malformed approved URL claimants remain relevant because
-- they participate in duplicate-authority detection.
CREATE TRIGGER guard_snapshot_media_during_public_feed_activation
  BEFORE INSERT OR DELETE OR UPDATE OF
    project_id, asset_type, gallery_position, public_url, alt_text_public, is_public_approved
  ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_public_feed_activation_projection();

CREATE TRIGGER guard_project_disciplines_during_public_feed_activation
  BEFORE INSERT OR UPDATE OR DELETE ON public.project_disciplines
  FOR EACH ROW EXECUTE FUNCTION public.guard_public_feed_activation_projection();

CREATE TRIGGER guard_discipline_lookup_during_public_feed_activation
  BEFORE UPDATE OF id, name OR DELETE ON public.disciplines
  FOR EACH ROW EXECUTE FUNCTION public.guard_public_feed_activation_projection();

REVOKE ALL ON FUNCTION public.lock_public_feed_activation_authority_transition()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_public_feed_activation_projection()
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
