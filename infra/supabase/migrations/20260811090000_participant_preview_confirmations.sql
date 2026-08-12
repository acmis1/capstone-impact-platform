-- Migration: 20260811090000_participant_preview_confirmations.sql
-- Description: Explicit, auditable participant confirmation of an exact, already-issued
-- participant preview version. A confirmation record means only "the participant confirmed
-- this exact immutable participant_previews.id" — never that the mutable projects row is
-- confirmed, never a project workflow status change, and never publication. Confirmation is
-- keyed strictly to the stable participant_previews.id, so it survives later project edits,
-- preview revocation, and reissue as independent historical evidence (see
-- 20260810180000_participant_preview_links.sql, which this migration only ever reads from —
-- that migration remains byte-for-byte unchanged).

BEGIN;

-- 1. participant_preview_confirmations table.
--    UNIQUE(participant_preview_id) is the DB-level authority for "at most one confirmation per
--    preview version" — the RPC below additionally uses this for idempotent ON CONFLICT DO
--    NOTHING behavior rather than raising under concurrent first-time submissions. No raw token,
--    IP address, user agent, or other participant-identifying data is collected: there is no
--    authenticated participant identity system, and none is invented here.
CREATE TABLE IF NOT EXISTS public.participant_preview_confirmations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_preview_id UUID NOT NULL UNIQUE
      REFERENCES public.participant_previews(id) ON DELETE CASCADE,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.participant_preview_confirmations ENABLE ROW LEVEL SECURITY;

-- No RLS policies are defined: combined with the REVOKE below, this table is completely
-- inaccessible to anon/authenticated Data API roles, matching participant_previews. All access
-- goes through the SECURITY DEFINER RPC below (participant confirmation) or the server-only
-- service_role client (staff-facing confirmation-status reads).
REVOKE ALL ON public.participant_preview_confirmations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.participant_preview_confirmations TO service_role;

-- 2. Service-role-only, idempotent, concurrency-safe participant confirmation RPC.
--    Receives only the SHA-256 token hash — never a participant_preview_id, project_id,
--    confirmation timestamp, or actor identity from the browser. The database resolves the
--    exact preview from the hash and is the sole authority on eligibility and ordering.
--
--    Concurrency/ordering: `SELECT ... FOR UPDATE` takes a row-level lock on the exact
--    participant_previews row (by physical tuple, regardless of which WHERE clause reached it),
--    which serializes against revoke_participant_preview's own `FOR UPDATE` on that same row
--    (see 20260810180000_participant_preview_links.sql). Whichever transaction acquires that
--    row lock first determines the valid ordering: if confirmation locks the row while it is
--    still active, the confirmation is valid even if a revoke commits immediately afterward; if
--    revoke locks and commits first, the subsequent confirmation attempt observes the now-
--    revoked status and is rejected. A confirmation is therefore never recorded against a
--    preview that had already become revoked/invalid before the confirmation transaction
--    acquired its lock.
--
--    Every ineligible condition (unknown hash, malformed hash, expired, revoked, not yet
--    resolvable) collapses to the same generic 'NOT_FOUND' resultCode as
--    resolve_participant_preview, so the participant-facing behavior never leaks which
--    condition occurred.
CREATE OR REPLACE FUNCTION public.confirm_participant_preview(
  p_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_confirmation_id uuid;
  v_confirmed_at timestamptz;
  v_already_confirmed boolean;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  SELECT pp.id, pp.status, pp.revoked_at, pp.expires_at
    INTO v_row
    FROM public.participant_previews pp
   WHERE pp.token_hash = p_token_hash
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  IF v_row.status <> 'active' OR v_row.revoked_at IS NOT NULL OR v_row.expires_at <= pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  INSERT INTO public.participant_preview_confirmations (participant_preview_id, confirmed_at)
  VALUES (v_row.id, pg_catalog.now())
  ON CONFLICT (participant_preview_id) DO NOTHING
  RETURNING id, confirmed_at INTO v_confirmation_id, v_confirmed_at;

  IF v_confirmation_id IS NULL THEN
    -- Losing side of a genuine concurrent first-time confirmation, or a legitimate repeat
    -- submission (refresh/resubmit): the original confirmation remains authoritative.
    v_already_confirmed := true;
    SELECT c.id, c.confirmed_at
      INTO v_confirmation_id, v_confirmed_at
      FROM public.participant_preview_confirmations c
     WHERE c.participant_preview_id = v_row.id;
  ELSE
    v_already_confirmed := false;
  END IF;

  -- Pass v_confirmed_at directly (not pg_catalog.to_jsonb(v_confirmed_at)::text) so
  -- jsonb_build_object performs its own single to_jsonb conversion on the timestamptz value.
  -- Casting an already-JSON-encoded value to text first and re-embedding it here would
  -- double-encode it, producing a literally quote-wrapped string in the decoded JSON response.
  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'confirmationId', v_confirmation_id,
    'confirmedAt', v_confirmed_at,
    'alreadyConfirmed', v_already_confirmed
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.confirm_participant_preview(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_participant_preview(text) TO service_role;

COMMIT;
