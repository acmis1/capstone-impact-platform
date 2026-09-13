-- KPI-09: bounded server observations, not proof of human reading or delivery.
-- No historical backfill, project mutation, confirmation, email or publication is performed.
BEGIN;

CREATE TABLE public.participant_preview_access_observations (
  participant_preview_id uuid PRIMARY KEY
    REFERENCES public.participant_previews(id) ON DELETE CASCADE,
  first_response_prepared_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
COMMENT ON TABLE public.participant_preview_access_observations IS
  'One first successful HTML-response preparation per exact preview. Bots/prefetch can qualify; does not prove delivery, reading, identity or confirmation. Retention follows the owning preview.';
ALTER TABLE public.participant_preview_access_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participant_preview_access_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY deny_authenticated_preview_access_observations
  ON public.participant_preview_access_observations
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.participant_preview_access_observations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.participant_preview_access_observations TO service_role;

CREATE FUNCTION public.record_participant_preview_response_prepared(
  p_preview_id uuid,
  p_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_preview public.participant_previews%ROWTYPE;
  v_observed_at timestamptz;
BEGIN
  IF p_preview_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;
  -- Serialize with revocation/reissue on the exact capability row. No project/writer lock or
  -- workflow mutation is introduced by observation collection.
  SELECT * INTO v_preview FROM public.participant_previews
  WHERE id = p_preview_id AND token_hash = p_token_hash FOR SHARE;
  v_observed_at := pg_catalog.clock_timestamp();
  IF v_preview.id IS NULL OR v_preview.status <> 'active' OR v_preview.revoked_at IS NOT NULL
     OR v_preview.expires_at <= v_observed_at THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;
  INSERT INTO public.participant_preview_access_observations(
    participant_preview_id, first_response_prepared_at
  ) VALUES (v_preview.id, v_observed_at)
  ON CONFLICT (participant_preview_id) DO NOTHING;
  RETURN pg_catalog.jsonb_build_object('resultCode', 'OBSERVED');
END;
$$;
REVOKE ALL ON FUNCTION public.record_participant_preview_response_prepared(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_participant_preview_response_prepared(uuid,text)
  TO service_role;

-- Read-only release capability marker: installing observation support does not assert human use.
CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel()
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT '20260910120100_participant_preview_access_observations|active_staff_catalog_rls_v1|staff_lifecycle_v1|staging_feed_rollback_capability_v1|preview_response_observation_v1'::text
$$;
REVOKE ALL ON FUNCTION public.get_release_capability_sentinel()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel() TO service_role;

COMMIT;
