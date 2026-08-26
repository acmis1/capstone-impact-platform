-- Issue #203 correction: make a bound activation candidate authoritative through its first
-- durable write/observation boundary. Storage I/O is deliberately absent from this migration.

BEGIN;

/**
 * The singleton row is the durable activation authority. PREPARED claims it and captures its
 * generation. Every lifecycle-public projection mutation must advance that generation while the
 * authority is unclaimed. The first durable activation boundary verifies the exact claim and
 * releases it in the same transaction as the operation transition.
 *
 * Project and discipline fence rows make relevance classification safe under old MVCC snapshots.
 * A draft-only mutation touches only its own local fence, so unrelated draft projects do not
 * serialize globally. A transaction whose REPEATABLE READ snapshot predates a conflicting
 * membership/relationship change instead encounters PostgreSQL's write/write serialization
 * failure when it tries to advance the same local fence.
 */
CREATE TABLE public.public_feed_activation_authority (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  active_activation_operation_id uuid
    REFERENCES public.public_feed_operations(id) ON DELETE RESTRICT
);

INSERT INTO public.public_feed_activation_authority(singleton, generation)
VALUES (true, 1);

CREATE TABLE public.public_feed_project_projection_authority (
  project_id uuid PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0)
);

INSERT INTO public.public_feed_project_projection_authority(project_id, generation)
SELECT p.id, 1
FROM public.projects p;

CREATE TABLE public.public_feed_discipline_projection_authority (
  discipline_id uuid PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0)
);

INSERT INTO public.public_feed_discipline_projection_authority(discipline_id, generation)
SELECT d.id, 1
FROM public.disciplines d;

ALTER TABLE public.public_feed_operations
  ADD COLUMN activation_authority_generation bigint
    CHECK (activation_authority_generation IS NULL OR activation_authority_generation > 0);

ALTER TABLE public.public_feed_activation_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_project_projection_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_feed_discipline_projection_authority ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.public_feed_activation_authority,
  public.public_feed_project_projection_authority,
  public.public_feed_discipline_projection_authority
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_public_feed_activation_authority_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_generation bigint;
  v_prewrite_bound boolean;
BEGIN
  IF NEW.kind <> 'activation' OR NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  v_prewrite_bound := OLD.storage_request_generation = 0 AND (
    OLD.state = 'PREPARED'
    OR (
      OLD.state = 'RECOVERY_REQUIRED'
      AND OLD.recovery_from_state = 'PREPARED'
    )
  );

  IF OLD.state = 'RESERVED' AND NEW.state = 'PREPARED' THEN
    v_generation := NULL;
    UPDATE public.public_feed_activation_authority
       SET active_activation_operation_id = NEW.id
     WHERE singleton = true
       AND active_activation_operation_id IS NULL
     RETURNING generation INTO v_generation;

    IF v_generation IS NULL THEN
      RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_FROZEN';
    END IF;
    NEW.activation_authority_generation := v_generation;
  ELSIF v_prewrite_bound
    AND NEW.state IN ('WRITE_STARTED', 'CANDIDATE_OBSERVED')
  THEN
    v_generation := NULL;
    UPDATE public.public_feed_activation_authority
       SET active_activation_operation_id = NULL
     WHERE singleton = true
       AND active_activation_operation_id = OLD.id
       AND generation = OLD.activation_authority_generation
     RETURNING generation INTO v_generation;

    IF v_generation IS NULL THEN
      RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_FROZEN';
    END IF;
  ELSIF v_prewrite_bound AND NEW.state <> 'RECOVERY_REQUIRED' THEN
    -- A PREPARED activation that terminates without crossing the public boundary relinquishes its
    -- claim. PREPARED recovery deliberately retains it until WRITE_STARTED/CANDIDATE_OBSERVED.
    v_generation := NULL;
    UPDATE public.public_feed_activation_authority
       SET active_activation_operation_id = NULL
     WHERE singleton = true
       AND active_activation_operation_id = OLD.id
       AND generation = OLD.activation_authority_generation
     RETURNING generation INTO v_generation;

    IF v_generation IS NULL THEN
      RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_FROZEN';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_public_feed_activation_authority_transition
  BEFORE UPDATE OF state ON public.public_feed_operations
  FOR EACH ROW EXECUTE FUNCTION public.guard_public_feed_activation_authority_transition();

CREATE OR REPLACE FUNCTION public.guard_public_feed_activation_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_ids uuid[] := ARRAY[]::uuid[];
  v_discipline_ids uuid[] := ARRAY[]::uuid[];
  v_related_discipline_ids uuid[] := ARRAY[]::uuid[];
  v_relevant boolean := false;
  v_membership_changed boolean := false;
  v_old_public boolean := false;
  v_new_public boolean := false;
  v_old_media_claimant boolean := false;
  v_new_media_claimant boolean := false;
  v_generation bigint;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    IF TG_OP <> 'INSERT' THEN
      v_project_ids := v_project_ids || OLD.id;
      v_old_public := OLD.status = 'published' AND OLD.deleted_at IS NULL;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_project_ids := v_project_ids || NEW.id;
      v_new_public := NEW.status = 'published' AND NEW.deleted_at IS NULL;
    END IF;
    v_membership_changed := v_old_public IS DISTINCT FROM v_new_public;
  ELSIF TG_TABLE_NAME = 'media_assets' THEN
    IF TG_OP <> 'INSERT' THEN
      v_project_ids := v_project_ids || OLD.project_id;
      v_old_media_claimant := OLD.asset_type = 'snapshot_image'
        AND OLD.is_public_approved = true
        AND COALESCE(OLD.public_url, '') <> '';
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_project_ids := v_project_ids || NEW.project_id;
      v_new_media_claimant := NEW.asset_type = 'snapshot_image'
        AND NEW.is_public_approved = true
        AND COALESCE(NEW.public_url, '') <> '';
    END IF;
  ELSIF TG_TABLE_NAME = 'project_disciplines' THEN
    IF TG_OP <> 'INSERT' THEN
      v_project_ids := v_project_ids || OLD.project_id;
      v_discipline_ids := v_discipline_ids || OLD.discipline_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_project_ids := v_project_ids || NEW.project_id;
      v_discipline_ids := v_discipline_ids || NEW.discipline_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'disciplines' THEN
    IF TG_OP <> 'INSERT' THEN v_discipline_ids := v_discipline_ids || OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_discipline_ids := v_discipline_ids || NEW.id; END IF;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(ids.id ORDER BY ids.id), ARRAY[]::uuid[])
    INTO v_project_ids
    FROM (
      SELECT DISTINCT source.id
      FROM pg_catalog.unnest(v_project_ids) AS source(id)
      WHERE source.id IS NOT NULL
    ) ids;
  SELECT COALESCE(pg_catalog.array_agg(ids.id ORDER BY ids.id), ARRAY[]::uuid[])
    INTO v_discipline_ids
    FROM (
      SELECT DISTINCT source.id
      FROM pg_catalog.unnest(v_discipline_ids) AS source(id)
      WHERE source.id IS NOT NULL
    ) ids;

  -- Child changes lock referenced lookup rows before taking any fence row. This matches foreign-
  -- key ordering and prevents a project/discipline delete from waiting on a fence held by a child
  -- transaction that is itself waiting on the referenced parent row.
  IF TG_TABLE_NAME = 'project_disciplines'
     AND pg_catalog.cardinality(v_discipline_ids) > 0
  THEN
    PERFORM d.id
    FROM public.disciplines d
    WHERE d.id = ANY(v_discipline_ids)
    ORDER BY d.id
    FOR KEY SHARE;
  END IF;

  IF TG_TABLE_NAME IN ('media_assets', 'project_disciplines')
     AND pg_catalog.cardinality(v_project_ids) > 0
  THEN
    PERFORM p.id
    FROM public.projects p
    WHERE p.id = ANY(v_project_ids)
    ORDER BY p.id
    FOR KEY SHARE;
  END IF;

  IF pg_catalog.cardinality(v_project_ids) > 0 THEN
    INSERT INTO public.public_feed_project_projection_authority AS authority(project_id, generation)
    SELECT source.id, 1
    FROM pg_catalog.unnest(v_project_ids) AS source(id)
    ORDER BY source.id
    ON CONFLICT (project_id) DO UPDATE
      SET generation = authority.generation + 1;
  END IF;

  -- Membership changes also advance each currently linked discipline fence. Therefore an older
  -- discipline transaction cannot miss a newly public reference through its stale snapshot.
  IF TG_TABLE_NAME = 'projects'
     AND v_membership_changed
     AND pg_catalog.cardinality(v_project_ids) > 0
  THEN
    SELECT COALESCE(pg_catalog.array_agg(pd.discipline_id ORDER BY pd.discipline_id), ARRAY[]::uuid[])
      INTO v_related_discipline_ids
      FROM public.project_disciplines pd
     WHERE pd.project_id = ANY(v_project_ids);
    v_discipline_ids := v_discipline_ids || v_related_discipline_ids;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(ids.id ORDER BY ids.id), ARRAY[]::uuid[])
    INTO v_discipline_ids
    FROM (
      SELECT DISTINCT source.id
      FROM pg_catalog.unnest(v_discipline_ids) AS source(id)
      WHERE source.id IS NOT NULL
    ) ids;

  IF pg_catalog.cardinality(v_discipline_ids) > 0 THEN
    INSERT INTO public.public_feed_discipline_projection_authority AS authority(discipline_id, generation)
    SELECT source.id, 1
    FROM pg_catalog.unnest(v_discipline_ids) AS source(id)
    ORDER BY source.id
    ON CONFLICT (discipline_id) DO UPDATE
      SET generation = authority.generation + 1;
  END IF;

  IF TG_TABLE_NAME = 'projects' THEN
    v_relevant := v_old_public OR v_new_public;
  ELSIF TG_TABLE_NAME = 'media_assets' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = ANY(v_project_ids)
        AND p.status = 'published'
        AND p.deleted_at IS NULL
    ) AND (v_old_media_claimant OR v_new_media_claimant)
    INTO v_relevant;
  ELSIF TG_TABLE_NAME = 'project_disciplines' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = ANY(v_project_ids)
        AND p.status = 'published'
        AND p.deleted_at IS NULL
    ) INTO v_relevant;
  ELSIF TG_TABLE_NAME = 'disciplines' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.project_disciplines pd
      JOIN public.projects p ON p.id = pd.project_id
      WHERE pd.discipline_id = ANY(v_discipline_ids)
        AND p.status = 'published'
        AND p.deleted_at IS NULL
    ) INTO v_relevant;
  END IF;

  IF v_relevant THEN
    v_generation := NULL;
    UPDATE public.public_feed_activation_authority
       SET generation = generation + 1
     WHERE singleton = true
       AND active_activation_operation_id IS NULL
     RETURNING generation INTO v_generation;

    IF v_generation IS NULL THEN
      RAISE EXCEPTION 'PUBLIC_FEED_ACTIVATION_AUTHORITY_FROZEN';
    END IF;
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

REVOKE ALL ON FUNCTION public.guard_public_feed_activation_authority_transition()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_public_feed_activation_projection()
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
