-- Migration: 20260811120000_participant_preview_correction_requests.sql
-- Description: Explicit, auditable participant correction request against an exact, already-
-- issued participant preview version. A correction request means only "the participant requested
-- changes to this exact immutable participant_previews.id" — never that project metadata was
-- changed, never that the correction was resolved, never a project workflow status change, and
-- never publication. Correction requests are keyed strictly to the stable participant_previews.id
-- (see 20260810180000_participant_preview_links.sql, which this migration only ever reads from —
-- that migration remains byte-for-byte unchanged), so they survive later project edits and
-- preview revocation/reissue as independent historical evidence, exactly like
-- participant_preview_confirmations (20260811090000_participant_preview_confirmations.sql, also
-- byte-for-byte unchanged by this migration).
--
-- Mutual exclusion: a single preview version must never carry both a confirmation and a
-- correction request. confirm_participant_preview (originally defined in Migration 0014) is
-- extended here via CREATE OR REPLACE to additionally check for an existing correction request
-- before inserting a confirmation; the new request_participant_preview_correction RPC below
-- performs the symmetric check. Both RPCs take the same `SELECT ... FOR UPDATE` row-level lock on
-- the resolved participant_previews row, which is the authoritative serialization point: whichever
-- transaction acquires that lock first determines which response type is recorded, and the losing
-- transaction observes the winner's committed row within the same lock-acquisition wait and backs
-- off with a controlled resultCode rather than raising an unhandled integrity error.

BEGIN;

-- 1. participant_preview_correction_requests table.
--    UNIQUE(participant_preview_id) is the DB-level authority for "at most one correction request
--    per preview version" — the RPC below additionally uses this for idempotent ON CONFLICT DO
--    NOTHING behavior rather than raising under concurrent first-time submissions, mirroring
--    participant_preview_confirmations. No raw token, IP address, user agent, or other
--    participant-identifying data is collected. `status` starts and currently only ever holds
--    'open' — admin resolution (accept/reject, resolved_at, resolved_by, etc.) is explicitly out
--    of scope for this migration; a later forward-only migration can extend the status domain and
--    add resolution columns without altering this table's existing columns.
CREATE TABLE IF NOT EXISTS public.participant_preview_correction_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_preview_id UUID NOT NULL UNIQUE
      REFERENCES public.participant_previews(id) ON DELETE CASCADE,
    correction_comment TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'open'
      CONSTRAINT check_participant_preview_correction_request_status CHECK (status IN ('open')),
    -- Defense-in-depth boundary check mirroring the server-side trim/length validation performed
    -- before this table is ever written to: never empty/whitespace-only after trimming, never
    -- over the 2000-character participant-authored comment bound. regexp_replace with \s (not
    -- btrim, which only strips literal space characters) so tabs/newlines/other whitespace are
    -- also recognized as insignificant, matching the JS-side String.prototype.trim() semantics
    -- used at the Next.js server layer.
    CONSTRAINT check_participant_preview_correction_comment_bounds CHECK (
      pg_catalog.regexp_replace(correction_comment, '^\s+|\s+$', '', 'g') <> ''
      AND pg_catalog.length(correction_comment) <= 2000
    )
);

ALTER TABLE public.participant_preview_correction_requests ENABLE ROW LEVEL SECURITY;

-- No RLS policies are defined: combined with the REVOKE below, this table is completely
-- inaccessible to anon/authenticated Data API roles, matching participant_previews and
-- participant_preview_confirmations. All access goes through the SECURITY DEFINER RPC below
-- (participant correction request) or the server-only service_role client (staff-facing status
-- reads).
REVOKE ALL ON public.participant_preview_correction_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.participant_preview_correction_requests TO service_role;

-- 2. Service-role-only, idempotent, concurrency-safe participant correction-request RPC.
--    Receives only the SHA-256 token hash and the participant-authored comment text — never a
--    participant_preview_id, project_id, request timestamp, status, or actor identity from the
--    browser. The database resolves the exact preview from the hash and is the sole authority on
--    eligibility, ordering, and mutual exclusion against an existing confirmation.
--
--    Concurrency/ordering: identical `SELECT ... FOR UPDATE` row-level lock strategy as
--    confirm_participant_preview (see 20260811090000_participant_preview_confirmations.sql) and
--    revoke_participant_preview (see 20260810180000_participant_preview_links.sql) — the physical
--    participant_previews row is the single serialization point shared by every mutating
--    operation against a given preview.
--
--    Every ineligible condition (unknown hash, malformed hash, expired, revoked, invalid comment,
--    an existing confirmation already recorded) collapses to a controlled, non-throwing resultCode
--    — never an unhandled unique_violation or other raised exception — so the calling application
--    layer can always render one generic participant-facing outcome without leaking which
--    condition occurred.
CREATE OR REPLACE FUNCTION public.request_participant_preview_correction(
  p_token_hash text,
  p_comment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_comment text;
  v_confirmation_exists boolean;
  v_request_id uuid;
  v_requested_at timestamptz;
  v_stored_comment text;
  v_already_requested boolean;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  -- Normalize/validate the comment server-side, independent of (and in addition to) any
  -- normalization already performed by the calling Next.js server route. regexp_replace with \s
  -- (not btrim, which only strips literal space characters) so tabs/newlines/other whitespace are
  -- also recognized as insignificant, matching the JS-side String.prototype.trim() semantics used
  -- at the Next.js server layer.
  v_comment := pg_catalog.regexp_replace(COALESCE(p_comment, ''), '^\s+|\s+$', '', 'g');
  IF v_comment = '' OR pg_catalog.length(v_comment) > 2000 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_COMMENT');
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

  -- Mutual exclusion: a confirmation already recorded for this exact preview wins; no correction
  -- request is ever created alongside it.
  SELECT EXISTS(
    SELECT 1 FROM public.participant_preview_confirmations c
     WHERE c.participant_preview_id = v_row.id
  ) INTO v_confirmation_exists;

  IF v_confirmation_exists THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_CONFIRMED');
  END IF;

  INSERT INTO public.participant_preview_correction_requests (participant_preview_id, correction_comment, requested_at)
  VALUES (v_row.id, v_comment, pg_catalog.now())
  ON CONFLICT (participant_preview_id) DO NOTHING
  RETURNING id, requested_at, correction_comment INTO v_request_id, v_requested_at, v_stored_comment;

  IF v_request_id IS NULL THEN
    -- Losing side of a genuine concurrent first-time correction request, or a legitimate repeat
    -- submission (refresh/resubmit): the original request remains authoritative historical
    -- evidence and is never overwritten by a later/losing comment.
    v_already_requested := true;
    SELECT r.id, r.requested_at, r.correction_comment
      INTO v_request_id, v_requested_at, v_stored_comment
      FROM public.participant_preview_correction_requests r
     WHERE r.participant_preview_id = v_row.id;
  ELSE
    v_already_requested := false;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SUCCESS',
    'correctionRequestId', v_request_id,
    'requestedAt', v_requested_at,
    'comment', v_stored_comment,
    'alreadyRequested', v_already_requested
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_participant_preview_correction(text, text) TO service_role;

-- 3. Extend confirm_participant_preview (originally defined in Migration 0014, unchanged there)
--    with the symmetric mutual-exclusion check: a correction request already recorded for this
--    exact preview wins; no confirmation is ever created alongside it. Every other line of
--    behavior — eligibility checks, the FOR UPDATE lock, the idempotent ON CONFLICT DO NOTHING
--    insert, and the response shape — is preserved exactly as Migration 0014 defined it.
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
  v_correction_exists boolean;
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

  -- Mutual exclusion: a correction request already recorded for this exact preview wins; no
  -- confirmation is ever created alongside it.
  SELECT EXISTS(
    SELECT 1 FROM public.participant_preview_correction_requests r
     WHERE r.participant_preview_id = v_row.id
  ) INTO v_correction_exists;

  IF v_correction_exists THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CORRECTION_REQUESTED');
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
