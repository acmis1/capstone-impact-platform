-- Migration: 20260810180000_participant_preview_links.sql
-- Description: Secure, token-protected, time-limited participant preview links for approved
-- projects. Server-generated opaque tokens are hashed before storage (raw tokens are never
-- persisted); each preview freezes an immutable, server-derived snapshot of the participant-
-- facing project fields and private media references at issuance time, so later edits to the
-- mutable project row never change what an already-issued preview shows. At most one active
-- (non-revoked) preview may exist per project at a time, enforced by a DB-level partial unique
-- index in addition to advisory-lock serialization inside the generation RPC.

BEGIN;

-- 1. participant_previews table.
--    `status` intentionally does not auto-transition on time-based expiry: a preview stays
--    'active' until explicitly revoked, even past its expires_at. This keeps the single-active
--    invariant simple and deterministic (see uq_participant_previews_one_active_per_project
--    below) — staff explicitly revoke a stale/expired preview before issuing a new one, exactly
--    as required. Time-based expiry only affects whether the participant-facing token route
--    will resolve the preview (resolve_participant_preview below), never whether generation is
--    blocked.
--    `id` is a stable identifier a future participant-confirmation feature can reference to
--    unambiguously record "this participant confirmed this exact preview version" without any
--    change to this table.
CREATE TABLE IF NOT EXISTS public.participant_previews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    snapshot JSONB NOT NULL,
    media_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
    status TEXT NOT NULL DEFAULT 'active'
      CONSTRAINT check_participant_preview_status CHECK (status IN ('active', 'revoked')),
    created_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
    CONSTRAINT check_participant_preview_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT check_participant_preview_revoked_consistency CHECK (
      (status = 'revoked' AND revoked_at IS NOT NULL) OR
      (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_participant_previews_project_id
  ON public.participant_previews(project_id);

-- Hard DB-level invariant: at most one 'active' row per project. This is the authoritative
-- backstop against duplicate active previews under concurrency — the generation RPC's advisory
-- lock is the normal-path serialization, this index is what actually prevents a duplicate row
-- if that serialization is ever bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_participant_previews_one_active_per_project
  ON public.participant_previews(project_id) WHERE status = 'active';

ALTER TABLE public.participant_previews ENABLE ROW LEVEL SECURITY;

-- No RLS policies are defined: combined with the REVOKE below, this table is completely
-- inaccessible to anon/authenticated Data API roles. All access goes through the
-- SECURITY DEFINER RPCs below via the server-only service_role client.
REVOKE ALL ON public.participant_previews FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.participant_previews TO service_role;

-- 2. Service-role-only atomic preview generation RPC.
--    The raw token is generated and hashed in the calling Next.js server code (Node's audited
--    crypto module) — only the resulting SHA-256 hex hash is ever passed in or persisted here.
CREATE OR REPLACE FUNCTION public.generate_participant_preview(
  p_public_id text,
  p_admin_id uuid,
  p_token_hash text,
  p_expires_in_seconds integer,
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
  v_project_id uuid;
  v_status text;
  v_existing_active_count integer;
  v_expires_in integer;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_preview_id uuid;
  v_snapshot jsonb;
  v_media_snapshot jsonb;
BEGIN
  -- 1. Input validation
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_TOKEN_HASH');
  END IF;

  -- The private draft bucket name must come from the caller's own server-side configuration
  -- (getStagingBuckets().DRAFT_PRIVATE), never a browser-supplied value — this is what scopes
  -- the media snapshot below to authoritative private draft media only.
  IF p_private_bucket IS NULL OR pg_catalog.btrim(p_private_bucket) = '' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PRIVATE_BUCKET');
  END IF;
  v_private_bucket := pg_catalog.btrim(p_private_bucket);

  -- Default 7-day expiry; bounded between 1 hour and 30 days.
  v_expires_in := COALESCE(p_expires_in_seconds, 604800);
  IF v_expires_in < 3600 OR v_expires_in > 2592000 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_EXPIRY');
  END IF;

  -- 2. Serialize concurrent generation attempts for the same project.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  -- 3. Authorization defense-in-depth: reuse the same permission as the reviewer
  --    approve/request_changes actions (projects.review -> admin or reviewer role).
  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0
     OR NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  -- 4. Resolve and lock the project; enforce eligibility (approved only).
  SELECT p.id, p.status
    INTO v_project_id, v_status
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  IF v_status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_PROJECT_STATE', 'status', v_status);
  END IF;

  -- 5. Single-active-preview invariant (application-layer check; the partial unique index
  --    below is the authoritative DB-level backstop for genuine races).
  SELECT pg_catalog.count(*)
    INTO v_existing_active_count
    FROM public.participant_previews
   WHERE project_id = v_project_id
     AND status = 'active';

  IF v_existing_active_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVE_PREVIEW_EXISTS');
  END IF;

  -- 6. Build the immutable, server-derived participant-facing snapshot. Only public-safe
  --    fields (per the existing Project domain contract) are included; internal-only fields
  --    (internal_staff_notes, private_review_comments, validation state, etc.) are excluded.
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
    INTO v_snapshot
    FROM public.projects p
   WHERE p.id = v_project_id;

  -- 7. Snapshot media references scoped strictly to this project's own rows (never another
  --    project's media) AND to media that is authoritatively still private draft media: it must
  --    live in the caller-configured private draft bucket, must not yet be public-approved, and
  --    must not already carry a public URL. This keeps the participant preview media boundary
  --    private even if a row is mid-promotion or otherwise anomalous. Only bucket/path/type
  --    metadata is captured — actual signed URLs are generated on demand, short-lived, at
  --    participant view time.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'mediaAssetId', ma.id,
      'assetType', ma.asset_type,
      'fileName', ma.file_name,
      'storageBucket', ma.storage_bucket,
      'storagePath', ma.storage_path,
      'mimeType', ma.mime_type
    )), '[]'::jsonb)
    INTO v_media_snapshot
    FROM public.media_assets ma
   WHERE ma.project_id = v_project_id
     AND ma.storage_bucket = v_private_bucket
     AND ma.is_public_approved = false
     AND ma.public_url IS NULL;

  v_now := pg_catalog.now();
  v_expires_at := v_now + pg_catalog.make_interval(secs => v_expires_in);

  BEGIN
    INSERT INTO public.participant_previews (
      project_id, token_hash, snapshot, media_snapshot, status, created_by, created_at, expires_at
    ) VALUES (
      v_project_id, p_token_hash, v_snapshot, v_media_snapshot, 'active', p_admin_id, v_now, v_expires_at
    ) RETURNING id INTO v_preview_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- Losing side of a genuine race against the partial unique index.
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ACTIVE_PREVIEW_EXISTS');
  END;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'previewId', v_preview_id,
    'publicId', v_public_id,
    'createdAt', pg_catalog.to_jsonb(v_now)::text,
    'expiresAt', pg_catalog.to_jsonb(v_expires_at)::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) TO service_role;

-- 3. Service-role-only atomic preview revocation RPC. Keyed on public_id (like
--    perform_project_review_action) rather than an opaque preview id, since staff act from the
--    project detail page and the preview row remains for audit/history after revocation.
CREATE OR REPLACE FUNCTION public.revoke_participant_preview(
  p_public_id text,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_public_id text;
  v_roles text[];
  v_project_id uuid;
  v_preview_id uuid;
  v_now timestamptz;
BEGIN
  IF p_public_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  v_public_id := pg_catalog.btrim(p_public_id);
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100 OR v_public_id !~ '^[A-Za-z0-9_-]+$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_SELECTION');
  END IF;

  IF p_admin_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id));

  SELECT pg_catalog.array_agg(r.role)
    INTO v_roles
    FROM public.user_roles r
   WHERE r.user_id = p_admin_id;

  IF v_roles IS NULL OR pg_catalog.cardinality(v_roles) = 0
     OR NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  SELECT p.id
    INTO v_project_id
    FROM public.projects p
   WHERE p.public_id = v_public_id
     AND p.deleted_at IS NULL
     FOR UPDATE;

  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  SELECT pp.id
    INTO v_preview_id
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project_id
     AND pp.status = 'active'
     FOR UPDATE;

  IF v_preview_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NO_ACTIVE_PREVIEW');
  END IF;

  v_now := pg_catalog.now();

  UPDATE public.participant_previews
     SET status = 'revoked',
         revoked_at = v_now,
         revoked_by = p_admin_id
   WHERE id = v_preview_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'previewId', v_preview_id,
    'publicId', v_public_id,
    'revokedAt', pg_catalog.to_jsonb(v_now)::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.revoke_participant_preview(text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_participant_preview(text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.revoke_participant_preview(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_participant_preview(text, uuid) TO service_role;

-- 4. Service-role-only participant token resolution RPC. Called exclusively from the
--    server-rendered /participant-preview/[token] route using the service-role client — the
--    participant's browser never talks to Supabase directly, so no anon/authenticated grant is
--    needed at all. Unknown, malformed, expired, and revoked tokens all collapse to the same
--    'NOT_FOUND' resultCode so the condition is never distinguishable to a caller.
CREATE OR REPLACE FUNCTION public.resolve_participant_preview(
  p_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  SELECT pp.id, pp.snapshot, pp.media_snapshot, pp.status, pp.expires_at, pp.revoked_at
    INTO v_row
    FROM public.participant_previews pp
   WHERE pp.token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  IF v_row.status <> 'active' OR v_row.revoked_at IS NOT NULL OR v_row.expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'previewId', v_row.id,
    'snapshot', v_row.snapshot,
    'mediaSnapshot', v_row.media_snapshot,
    'expiresAt', pg_catalog.to_jsonb(v_row.expires_at)::text
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_participant_preview(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_participant_preview(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resolve_participant_preview(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_participant_preview(text) TO service_role;

COMMIT;
