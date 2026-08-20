-- Migration 0030: durable, non-authoritative assistive validation runs and findings.
--
-- Phase 3 of PP1 assistive validation makes the Phase 2 deterministic observations durable. It is
-- a SIDE DOMAIN. Nothing here may change project status, validation authority, approval,
-- publication, archival, publication readiness, accessibility satisfaction, or project metadata.
-- There is deliberately no trigger and no write to any authoritative table in this migration, so
-- no database path exists from an assistive finding into authoritative workflow state.
--
-- Access model (identical to Migration 0029): both tables are unreachable by every Data API role.
-- RLS is enabled with a RESTRICTIVE deny-all policy AND every table privilege is revoked, so the
-- only way to read or write assistive data is one of the three SECURITY DEFINER functions below,
-- each granted to service_role alone. A browser client therefore cannot read, insert, update or
-- delete a finding, and cannot spoof a reviewer disposition.
--
-- Timestamps: a Phase 3 run row is written only once the deterministic evaluation has already
-- finished, so it is durable only in a terminal state (COMPLETED or FAILED) and its creation time
-- is its completion time. A second always-equal completed_at column would be a lie about what the
-- row records. Phase 4 introduces job coordination (claiming, leasing, attempts, cancellation);
-- when a genuinely non-terminal run state exists, started_at/completed_at and any extraction
-- provider identity can be added as additive nullable columns without touching this migration.
--
-- Idempotency: the unique index is PARTIAL, covering only status = 'COMPLETED'. At most one
-- completed run may exist per (project_id, input_hash, pipeline_version), so an exact retry of an
-- already-persisted identity converges instead of duplicating findings. Failed runs are
-- deliberately unconstrained so a previous failure never blocks a later successful retry, which is
-- what keeps Phase 4 worker retry possible without a destructive redesign.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Durable run identity
-- ---------------------------------------------------------------------------
--
-- project_id ON DELETE CASCADE: every project-owned child in this schema already cascades
--   (media_assets, validation_flags, approval_records, project_disciplines). Assistive
--   observations describe one project's own content and carry no authoritative audit duty, so
--   they must not outlive the project row. RESTRICT would let this non-authoritative side domain
--   block an authoritative project deletion, which inverts the authority model. SET NULL is
--   impossible: a project-less assistive run has no meaning. The platform normally soft-deletes
--   (projects.deleted_at), so this cascade is a safety net rather than the routine path.
--
-- requested_by ON DELETE SET NULL: mirrors approval_records.admin_id, validation_flags.resolved_by
--   and import_batches.imported_by. Removing a staff account must neither destroy observation
--   history nor be blocked by it, so attribution degrades to NULL instead.
CREATE TABLE public.assistive_validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL
    CONSTRAINT assistive_validation_runs_project_fk
    REFERENCES public.projects(id) ON DELETE CASCADE,
  requested_by uuid
    CONSTRAINT assistive_validation_runs_requested_by_fk
    REFERENCES public.admin_users(id) ON DELETE SET NULL,
  input_hash text NOT NULL
    CONSTRAINT check_assistive_run_input_hash
    CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  pipeline_version text NOT NULL
    CONSTRAINT check_assistive_run_pipeline_version
    CHECK (pipeline_version ~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$'
           AND pg_catalog.length(pipeline_version) <= 64),
  status text NOT NULL
    CONSTRAINT check_assistive_run_status
    CHECK (status IN ('COMPLETED', 'FAILED')),
  failure_code text
    CONSTRAINT check_assistive_run_failure_code
    CHECK (failure_code IS NULL OR failure_code IN (
      'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED', 'INTERNAL_FAILURE'
    )),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT check_assistive_run_failure_coherence
    CHECK ((status = 'FAILED' AND failure_code IS NOT NULL)
           OR (status = 'COMPLETED' AND failure_code IS NULL))
);

-- Exactly one completed run per content identity; failed attempts stay retryable.
CREATE UNIQUE INDEX uq_assistive_validation_runs_completed_identity
  ON public.assistive_validation_runs (project_id, input_hash, pipeline_version)
  WHERE status = 'COMPLETED';

CREATE INDEX idx_assistive_validation_runs_project_created
  ON public.assistive_validation_runs (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Durable findings
-- ---------------------------------------------------------------------------
--
-- There is deliberately NO finding-level project_id. The run owns the project relationship, so a
-- finding that disagrees with its run about the project is structurally impossible rather than
-- merely constrained. The same reasoning applies to input_hash and pipeline_version: they are run
-- identity and are never duplicated onto a finding.
--
-- classification is a single-value CHECK. An authority-bearing value such as BLOCKING, APPROVED,
-- VALID or PUBLICATION_READY cannot be stored in this domain at all.
--
-- The score is recorded as an explicit (kind, value) pair. Phase 0 measured that the lexical score
-- is edit-distance evidence, not confidence and not a calibrated probability, so the kind is
-- persisted alongside the number to stop a later reader reinterpreting a bare scalar as certainty.
CREATE TABLE public.assistive_validation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL
    CONSTRAINT assistive_validation_findings_run_fk
    REFERENCES public.assistive_validation_runs(id) ON DELETE CASCADE,
  check_type text NOT NULL
    CONSTRAINT check_assistive_finding_check_type
    CHECK (check_type IN ('TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION')),
  outcome text NOT NULL
    CONSTRAINT check_assistive_finding_outcome
    CHECK (outcome IN ('AGREES', 'REVIEW', 'MISMATCH', 'NOT_EVALUATED', 'INFORMATION')),
  classification text NOT NULL DEFAULT 'NON_BLOCKING'
    CONSTRAINT check_assistive_finding_classification
    CHECK (classification = 'NON_BLOCKING'),
  reason_code text NOT NULL
    CONSTRAINT check_assistive_finding_reason_code
    CHECK (reason_code IN (
      'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
      'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
      'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
      'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
      'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE'
    )),
  affected_field text NOT NULL
    CONSTRAINT check_assistive_finding_affected_field
    CHECK (affected_field IN ('title', 'extraction_text')),
  origin text NOT NULL
    CONSTRAINT check_assistive_finding_origin
    CHECK (origin IN ('PHASE_1_EXTRACTION', 'DETERMINISTIC_HELPER')),
  -- Position within the run, derived by the database from the submitted order. Phase 2 emits its
  -- observations in a meaningful sequence and every finding of one run shares a created_at, so
  -- without this the durable read order would be an arbitrary UUID order rather than the produced
  -- one. It is never supplied by a caller.
  ordinal integer NOT NULL
    CONSTRAINT check_assistive_finding_ordinal
    CHECK (ordinal BETWEEN 1 AND 50),
  score_kind text
    CONSTRAINT check_assistive_finding_score_kind
    CHECK (score_kind IS NULL OR score_kind = 'LEXICAL_SIMILARITY'),
  -- numeric, not double precision: a float8 is rendered back into JSON through its text output and
  -- silently loses the last significant digit, so the stored evidence would not equal what the
  -- deterministic check actually measured. numeric(19, 18) round-trips exactly and bounds the
  -- value to a single integer digit.
  score_value numeric(19, 18)
    CONSTRAINT check_assistive_finding_score_value
    CHECK (score_value IS NULL OR (score_value >= 0 AND score_value <= 1)),
  evidence jsonb NOT NULL
    CONSTRAINT check_assistive_finding_evidence_object
    CHECK (pg_catalog.jsonb_typeof(evidence) = 'object'),
  disposition text NOT NULL DEFAULT 'UNREVIEWED'
    CONSTRAINT check_assistive_finding_disposition
    CHECK (disposition IN ('UNREVIEWED', 'REVIEWED', 'IGNORED')),
  reviewed_by uuid
    CONSTRAINT assistive_validation_findings_reviewed_by_fk
    REFERENCES public.admin_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT uq_assistive_validation_findings_run_ordinal
    UNIQUE (run_id, ordinal),
  CONSTRAINT check_assistive_finding_score_pair
    CHECK ((score_kind IS NULL) = (score_value IS NULL)),
  -- The persisted evidence contract is versioned and closed: exactly these keys, no others.
  CONSTRAINT check_assistive_finding_evidence_version
    CHECK (evidence ->> 'version' = 'assistive-finding-evidence/v1'),
  CONSTRAINT check_assistive_finding_evidence_keys
    CHECK (evidence ?& ARRAY[
             'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
             'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'
           ]
           AND (evidence - ARRAY[
             'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
             'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'
           ]) = '{}'::jsonb),
  CONSTRAINT check_assistive_finding_evidence_explanation
    CHECK (pg_catalog.jsonb_typeof(evidence -> 'explanation') = 'string'
           AND pg_catalog.length(evidence ->> 'explanation') BETWEEN 1 AND 300),
  CONSTRAINT check_assistive_finding_evidence_size
    CHECK (pg_catalog.length(evidence::text) <= 8192),
  -- reviewed_at is the coherence anchor rather than reviewed_by, precisely because the
  -- ON DELETE SET NULL above rewrites reviewed_by when a staff account is removed. Anchoring on
  -- reviewed_by would make that cascade violate this CHECK and block the staff deletion.
  CONSTRAINT check_assistive_finding_disposition_coherence
    CHECK ((disposition = 'UNREVIEWED' AND reviewed_by IS NULL AND reviewed_at IS NULL)
           OR (disposition <> 'UNREVIEWED' AND reviewed_at IS NOT NULL))
);

-- No separate finding index: uq_assistive_validation_findings_run_ordinal already provides the
-- (run_id, ordinal) btree that every read of this table uses, and a duplicate would only add
-- write cost.

-- ---------------------------------------------------------------------------
-- 3. Fail-closed access control
-- ---------------------------------------------------------------------------
ALTER TABLE public.assistive_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistive_validation_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY deny_assistive_validation_runs_direct_access
  ON public.assistive_validation_runs
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated, service_role
  USING (false)
  WITH CHECK (false);

CREATE POLICY deny_assistive_validation_findings_direct_access
  ON public.assistive_validation_findings
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated, service_role
  USING (false)
  WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.assistive_validation_runs
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.assistive_validation_findings
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Atomic persistence of one run and all of its findings
-- ---------------------------------------------------------------------------
--
-- Every validation completes before the first INSERT. A plpgsql RETURN does not roll back rows
-- already written inside the caller's transaction, so validating after writing would be able to
-- leave a completed run with only part of its findings. Validate-then-write is the atomicity
-- guarantee, and the whole function body runs inside one transaction.
CREATE OR REPLACE FUNCTION public.persist_assistive_validation_run(
  p_project_id uuid,
  p_actor_admin_id uuid,
  p_input_hash text,
  p_pipeline_version text,
  p_status text,
  p_failure_code text,
  p_findings jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_input_hash text := pg_catalog.btrim(COALESCE(p_input_hash, ''));
  v_pipeline_version text := pg_catalog.btrim(COALESCE(p_pipeline_version, ''));
  v_status text := pg_catalog.btrim(COALESCE(p_status, ''));
  v_failure_code text := NULLIF(pg_catalog.btrim(COALESCE(p_failure_code, '')), '');
  v_finding_count integer;
  v_finding jsonb;
  v_evidence jsonb;
  v_run_id uuid;
  v_existing_run_id uuid;
  v_existing_count integer;
  v_finding_keys text[] := ARRAY[
    'checkType', 'outcome', 'classification', 'reasonCode', 'affectedField',
    'origin', 'scoreKind', 'scoreValue', 'evidence'
  ];
  v_evidence_keys text[] := ARRAY[
    'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
    'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'
  ];
BEGIN
  -- 4.1 Bounded run identity. The hash contract is lowercase SHA-256 hexadecimal only; an
  -- uppercase, truncated, or arbitrary string is rejected rather than normalized.
  IF p_project_id IS NULL OR p_actor_admin_id IS NULL
     OR v_input_hash !~ '^[a-f0-9]{64}$'
     OR v_pipeline_version !~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$'
     OR pg_catalog.length(v_pipeline_version) > 64
     OR v_status NOT IN ('COMPLETED', 'FAILED')
     OR (v_status = 'COMPLETED' AND v_failure_code IS NOT NULL)
     OR (v_status = 'FAILED' AND (v_failure_code IS NULL OR v_failure_code NOT IN (
          'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED', 'INTERNAL_FAILURE')))
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- 4.2 Actor authority. The identity arrives from the trusted server boundary and is re-proved
  -- here against a recognized staff role; the browser never reaches this function at all.
  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_users AS u
      JOIN public.user_roles AS r ON r.user_id = u.id
     WHERE u.id = p_actor_admin_id
       AND r.role IN ('admin', 'reviewer', 'editor')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  -- 4.3 The run must belong to a live project.
  IF NOT EXISTS (
    SELECT 1
      FROM public.projects AS p
     WHERE p.id = p_project_id
       AND p.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  -- 4.4 Findings array shape.
  IF p_findings IS NULL OR pg_catalog.jsonb_typeof(p_findings) <> 'array' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  v_finding_count := pg_catalog.jsonb_array_length(p_findings);

  -- A completed run with zero findings and a failed run carrying findings are both impossible
  -- durable states, so neither can be created in the first place.
  IF v_finding_count > 50
     OR (v_status = 'COMPLETED' AND v_finding_count = 0)
     OR (v_status = 'FAILED' AND v_finding_count <> 0)
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  -- 4.5 Complete pre-mutation validation of every finding. Nothing is written in this loop.
  FOR v_finding IN SELECT * FROM pg_catalog.jsonb_array_elements(p_findings) LOOP
    IF pg_catalog.jsonb_typeof(v_finding) <> 'object'
       OR NOT (v_finding ?& v_finding_keys)
       OR (v_finding - v_finding_keys) <> '{}'::jsonb
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
    END IF;

    IF COALESCE(v_finding ->> 'classification', '') <> 'NON_BLOCKING'
       OR COALESCE(v_finding ->> 'checkType', '') NOT IN (
            'TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION')
       OR COALESCE(v_finding ->> 'outcome', '') NOT IN (
            'AGREES', 'REVIEW', 'MISMATCH', 'NOT_EVALUATED', 'INFORMATION')
       OR COALESCE(v_finding ->> 'reasonCode', '') NOT IN (
            'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
            'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
            'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
            'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
            'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE')
       OR COALESCE(v_finding ->> 'affectedField', '') NOT IN ('title', 'extraction_text')
       OR COALESCE(v_finding ->> 'origin', '') NOT IN ('PHASE_1_EXTRACTION', 'DETERMINISTIC_HELPER')
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
    END IF;

    IF (pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') = 'null')
       <> (pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') = 'null')
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
    END IF;

    IF pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') <> 'null' THEN
      IF v_finding ->> 'scoreKind' <> 'LEXICAL_SIMILARITY'
         OR pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') <> 'number'
         -- Bounds the literal before it is cast, so no absurd exponent can reach numeric at all.
         OR pg_catalog.length(v_finding ->> 'scoreValue') > 32
      THEN
        RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
      END IF;
      IF (v_finding ->> 'scoreValue')::numeric < 0
         OR (v_finding ->> 'scoreValue')::numeric > 1
      THEN
        RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
      END IF;
    END IF;

    v_evidence := v_finding -> 'evidence';

    IF pg_catalog.jsonb_typeof(v_evidence) <> 'object'
       OR COALESCE(v_evidence ->> 'version', '') <> 'assistive-finding-evidence/v1'
       OR pg_catalog.length(v_evidence::text) > 8192
       OR NOT (v_evidence ?& v_evidence_keys)
       OR (v_evidence - v_evidence_keys) <> '{}'::jsonb
       OR pg_catalog.jsonb_typeof(v_evidence -> 'explanation') <> 'string'
       OR pg_catalog.length(v_evidence ->> 'explanation') NOT BETWEEN 1 AND 300
       OR pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') NOT IN ('null', 'number')
       OR pg_catalog.jsonb_typeof(v_evidence -> 'boundingBox') NOT IN ('null', 'object')
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
    END IF;
  END LOOP;

  -- 4.6 Serialize concurrent attempts on the same content identity so two identical callers
  -- converge on one durable run instead of racing.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_project_id::text || ':' || v_input_hash || ':' || v_pipeline_version)
  );

  -- 4.7 Documented idempotency. A completed run already answers this exact content identity, so a
  -- repeat attempt returns that run untouched. Existing evidence is never rewritten in place; a
  -- genuinely different answer requires different content or a new pipeline version.
  SELECT r.id
    INTO v_existing_run_id
    FROM public.assistive_validation_runs AS r
   WHERE r.project_id = p_project_id
     AND r.input_hash = v_input_hash
     AND r.pipeline_version = v_pipeline_version
     AND r.status = 'COMPLETED';

  IF FOUND THEN
    SELECT pg_catalog.count(*)
      INTO v_existing_count
      FROM public.assistive_validation_findings AS f
     WHERE f.run_id = v_existing_run_id;

    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_PERSISTED',
      'runId', v_existing_run_id::text,
      'status', 'COMPLETED',
      'findingCount', v_existing_count
    );
  END IF;

  INSERT INTO public.assistive_validation_runs (
    project_id, requested_by, input_hash, pipeline_version, status, failure_code
  )
  VALUES (
    p_project_id, p_actor_admin_id, v_input_hash, v_pipeline_version, v_status, v_failure_code
  )
  RETURNING id INTO v_run_id;

  -- classification is written from this literal rather than from caller input, so the persisted
  -- non-blocking meaning is decided by the database.
  IF v_finding_count > 0 THEN
    INSERT INTO public.assistive_validation_findings (
      run_id, check_type, outcome, classification, reason_code, affected_field, origin,
      ordinal, score_kind, score_value, evidence
    )
    SELECT
      v_run_id,
      element.value ->> 'checkType',
      element.value ->> 'outcome',
      'NON_BLOCKING',
      element.value ->> 'reasonCode',
      element.value ->> 'affectedField',
      element.value ->> 'origin',
      element.position::integer,
      element.value ->> 'scoreKind',
      CASE
        WHEN pg_catalog.jsonb_typeof(element.value -> 'scoreValue') = 'number'
        THEN (element.value ->> 'scoreValue')::numeric
        ELSE NULL
      END,
      element.value -> 'evidence'
      FROM pg_catalog.jsonb_array_elements(p_findings)
        WITH ORDINALITY AS element(value, position);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'PERSISTED',
    'runId', v_run_id::text,
    'status', v_status,
    'findingCount', v_finding_count
  );
EXCEPTION
  WHEN unique_violation THEN
    -- Defence in depth behind the advisory lock: the partial unique index is the final authority
    -- on completed-run identity, and the loser of any race converges on the winning run.
    SELECT r.id
      INTO v_existing_run_id
      FROM public.assistive_validation_runs AS r
     WHERE r.project_id = p_project_id
       AND r.input_hash = v_input_hash
       AND r.pipeline_version = v_pipeline_version
       AND r.status = 'COMPLETED';

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
    END IF;

    SELECT pg_catalog.count(*)
      INTO v_existing_count
      FROM public.assistive_validation_findings AS f
     WHERE f.run_id = v_existing_run_id;

    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_PERSISTED',
      'runId', v_existing_run_id::text,
      'status', 'COMPLETED',
      'findingCount', v_existing_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_assistive_validation_run(uuid, uuid, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.persist_assistive_validation_run(uuid, uuid, text, text, text, text, jsonb)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Reviewer disposition
-- ---------------------------------------------------------------------------
--
-- The only mutation this domain permits. It touches disposition, reviewed_by and reviewed_at and
-- nothing else, so persisted evidence, outcome, reason and run ownership stay immutable after
-- creation. Recording a disposition changes no project workflow state whatsoever, and there is
-- deliberately no "accepted" or "applied" disposition, because no authoritative metadata update
-- happens here. Apply-to-draft is a later phase with its own authoritative gate.
--
-- Reviewing is gated on the projects.review authority (admin, reviewer) rather than on any staff
-- role, and the acting identity comes from the trusted server boundary. Widening this later is an
-- additive change; narrowing it after the fact would not be.
CREATE OR REPLACE FUNCTION public.record_assistive_finding_disposition(
  p_finding_id uuid,
  p_actor_admin_id uuid,
  p_disposition text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_disposition text := pg_catalog.btrim(COALESCE(p_disposition, ''));
  v_current_disposition text;
  v_reviewed_by uuid;
  v_reviewed_at timestamptz;
BEGIN
  IF p_finding_id IS NULL
     OR p_actor_admin_id IS NULL
     OR v_disposition NOT IN ('REVIEWED', 'IGNORED')
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.admin_users AS u
      JOIN public.user_roles AS r ON r.user_id = u.id
     WHERE u.id = p_actor_admin_id
       AND r.role IN ('admin', 'reviewer')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;

  SELECT f.disposition, f.reviewed_by, f.reviewed_at
    INTO v_current_disposition, v_reviewed_by, v_reviewed_at
    FROM public.assistive_validation_findings AS f
   WHERE f.id = p_finding_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'FINDING_NOT_FOUND');
  END IF;

  IF v_current_disposition = v_disposition THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'UNCHANGED',
      'findingId', p_finding_id::text,
      'disposition', v_current_disposition,
      'reviewedBy', v_reviewed_by::text,
      'reviewedAt', v_reviewed_at
    );
  END IF;

  UPDATE public.assistive_validation_findings
     SET disposition = v_disposition,
         reviewed_by = p_actor_admin_id,
         reviewed_at = pg_catalog.now()
   WHERE id = p_finding_id
  RETURNING disposition, reviewed_by, reviewed_at
       INTO v_current_disposition, v_reviewed_by, v_reviewed_at;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'RECORDED',
    'findingId', p_finding_id::text,
    'disposition', v_current_disposition,
    'reviewedBy', v_reviewed_by::text,
    'reviewedAt', v_reviewed_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_assistive_finding_disposition(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_assistive_finding_disposition(uuid, uuid, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Bounded read for a later staff surface
-- ---------------------------------------------------------------------------
--
-- Returns the latest run for one content pipeline on one project plus its findings. The result
-- shape is fixed and bounded; it exposes no project workflow state and grants no authority. A
-- Phase 5 route consuming this must still apply the existing Admin session gate, exactly as every
-- other service-role read path does.
CREATE OR REPLACE FUNCTION public.get_latest_assistive_validation_run(
  p_project_id uuid,
  p_pipeline_version text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pipeline_version text := pg_catalog.btrim(COALESCE(p_pipeline_version, ''));
  v_run public.assistive_validation_runs%ROWTYPE;
  v_findings jsonb;
BEGIN
  IF p_project_id IS NULL
     OR v_pipeline_version !~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$'
     OR pg_catalog.length(v_pipeline_version) > 64
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT r.*
    INTO v_run
    FROM public.assistive_validation_runs AS r
   WHERE r.project_id = p_project_id
     AND r.pipeline_version = v_pipeline_version
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOT_FOUND');
  END IF;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'findingId', f.id::text,
               'ordinal', f.ordinal,
               'checkType', f.check_type,
               'outcome', f.outcome,
               'classification', f.classification,
               'reasonCode', f.reason_code,
               'affectedField', f.affected_field,
               'origin', f.origin,
               'scoreKind', f.score_kind,
               'scoreValue', f.score_value,
               'evidence', f.evidence,
               'disposition', f.disposition,
               'reviewedBy', f.reviewed_by::text,
               'reviewedAt', f.reviewed_at,
               'createdAt', f.created_at
             )
             ORDER BY f.ordinal
           ),
           '[]'::jsonb
         )
    INTO v_findings
    FROM public.assistive_validation_findings AS f
   WHERE f.run_id = v_run.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'FOUND',
    'run', pg_catalog.jsonb_build_object(
      'runId', v_run.id::text,
      'projectId', v_run.project_id::text,
      'inputHash', v_run.input_hash,
      'pipelineVersion', v_run.pipeline_version,
      'status', v_run.status,
      'failureCode', v_run.failure_code,
      'createdAt', v_run.created_at
    ),
    'findings', v_findings
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_latest_assistive_validation_run(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_latest_assistive_validation_run(uuid, text)
  TO service_role;

COMMIT;
