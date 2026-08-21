-- Migration 0033: bounded lexical duplicate shortlist evidence.
--
-- Phase 6B adds one non-authoritative DUPLICATE_SHORTLIST finding containing at most five
-- browser-safe project candidates. Existing assistive-finding-evidence/v1 rows remain valid and
-- unchanged. The new v2 object retains every bounded v1 field and adds only duplicateCandidates.
-- Direct table access remains denied; no project metadata or workflow state is mutated here.
--
-- The stored evidence is held to the semantics of the selected deterministic ranker rather than to
-- a looser superset of them: the finding outcome and reason follow from the candidate flags, an
-- exact content match implies a normalized-title match and a score of exactly 1, every other
-- candidate is capped below 1, and the persisted order is descending score with an ascending
-- route-safe public-ID tie breaker. None of this is a duplicate decision -- no score is a
-- threshold, the finding stays NON_BLOCKING, and staff alone decide whether projects are the same
-- work. The database enforces these so a direct insert cannot record evidence that contradicts
-- itself merely because the current application caller happens to be correct.

BEGIN;

-- The one shortlist-level signal that separates an informational shortlist from one staff are asked
-- to review. The application converter derives the outcome and reason from the same predicate, so
-- expressing it once here lets the table constraint and the validation RPC agree with it exactly.
CREATE OR REPLACE FUNCTION public.assistive_duplicate_shortlist_has_exact_or_normalized(
  p_candidates jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.jsonb_path_exists(
      p_candidates,
      '$[*] ? (@.exactContentMatch == true || @.normalizedTitleMatch == true)'
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.assistive_duplicate_shortlist_has_exact_or_normalized(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_valid_assistive_duplicate_candidates(p_candidates jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_candidate jsonb;
  v_position bigint;
  v_public_ids text[] := ARRAY[]::text[];
  v_public_id text;
  v_score numeric;
  v_exact boolean;
  v_normalized boolean;
  v_previous_public_id text;
  v_previous_score numeric;
  v_keys text[] := ARRAY[
    'rank', 'publicId', 'title', 'summaryExcerpt', 'lexicalScore',
    'exactContentMatch', 'normalizedTitleMatch'
  ];
BEGIN
  IF p_candidates IS NULL
     OR pg_catalog.jsonb_typeof(p_candidates) <> 'array'
     OR pg_catalog.jsonb_array_length(p_candidates) NOT BETWEEN 1 AND 5
  THEN
    RETURN false;
  END IF;

  FOR v_candidate, v_position IN
    SELECT element.value, element.position
      FROM pg_catalog.jsonb_array_elements(p_candidates)
        WITH ORDINALITY AS element(value, position)
  LOOP
    IF pg_catalog.jsonb_typeof(v_candidate) <> 'object'
       OR NOT (v_candidate ?& v_keys)
       OR (v_candidate - v_keys) <> '{}'::jsonb
       OR pg_catalog.jsonb_typeof(v_candidate -> 'rank') <> 'number'
       OR pg_catalog.length(v_candidate ->> 'rank') > 2
       OR (v_candidate ->> 'rank')::numeric <> pg_catalog.trunc((v_candidate ->> 'rank')::numeric)
       OR (v_candidate ->> 'rank')::numeric <> v_position
       OR (v_candidate ->> 'rank')::numeric NOT BETWEEN 1 AND 5
       OR pg_catalog.jsonb_typeof(v_candidate -> 'publicId') <> 'string'
       OR pg_catalog.length(v_candidate ->> 'publicId') NOT BETWEEN 1 AND 100
       OR (v_candidate ->> 'publicId') !~ '^[A-Za-z0-9_-]+$'
       OR (v_candidate ->> 'publicId') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
       OR (v_candidate ->> 'publicId') = ANY(v_public_ids)
       OR pg_catalog.jsonb_typeof(v_candidate -> 'title') <> 'string'
       OR pg_catalog.length(v_candidate ->> 'title') > 200
       OR (v_candidate ->> 'title') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
       OR pg_catalog.jsonb_typeof(v_candidate -> 'summaryExcerpt') <> 'string'
       OR pg_catalog.length(v_candidate ->> 'summaryExcerpt') > 240
       OR (v_candidate ->> 'summaryExcerpt') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
       OR pg_catalog.jsonb_typeof(v_candidate -> 'lexicalScore') <> 'number'
       OR pg_catalog.length(v_candidate ->> 'lexicalScore') > 32
       OR (v_candidate ->> 'lexicalScore')::numeric NOT BETWEEN 0 AND 1
       OR pg_catalog.jsonb_typeof(v_candidate -> 'exactContentMatch') <> 'boolean'
       OR pg_catalog.jsonb_typeof(v_candidate -> 'normalizedTitleMatch') <> 'boolean'
    THEN
      RETURN false;
    END IF;

    v_public_id := v_candidate ->> 'publicId';
    v_score := (v_candidate ->> 'lexicalScore')::numeric;
    v_exact := (v_candidate ->> 'exactContentMatch')::boolean;
    v_normalized := (v_candidate ->> 'normalizedTitleMatch')::boolean;

    -- Canonical equality includes the normalized title and is the only comparison that scores 1, so
    -- these combinations describe a run the selected deterministic ranker cannot have produced.
    -- No score is a duplicate decision here; staff remain the only party who decide that.
    IF (v_exact AND NOT v_normalized)
       OR (v_exact AND v_score <> 1)
       OR (NOT v_exact AND v_score > 0.999)
    THEN
      RETURN false;
    END IF;

    -- The evidence calls itself a ranked shortlist. The supplied order is checked against the
    -- ranker's own rule -- descending score, then ascending public ID under the same route-safe
    -- ASCII comparison -- without ever recomputing lexical similarity in the database.
    IF v_position > 1 AND (
      v_score > v_previous_score
      OR (v_score = v_previous_score
          AND (v_public_id COLLATE pg_catalog."C") <= (v_previous_public_id COLLATE pg_catalog."C"))
    ) THEN
      RETURN false;
    END IF;

    v_public_ids := pg_catalog.array_append(v_public_ids, v_public_id);
    v_previous_public_id := v_public_id;
    v_previous_score := v_score;
  END LOOP;

  RETURN true;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_valid_assistive_duplicate_candidates(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.assistive_validation_findings
  DROP CONSTRAINT check_assistive_finding_check_type,
  DROP CONSTRAINT check_assistive_finding_reason_code,
  DROP CONSTRAINT check_assistive_finding_affected_field,
  DROP CONSTRAINT check_assistive_finding_evidence_version,
  DROP CONSTRAINT check_assistive_finding_evidence_keys;

ALTER TABLE public.assistive_validation_findings
  ADD CONSTRAINT check_assistive_finding_check_type
    CHECK (check_type IN (
      'TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION', 'DUPLICATE_SHORTLIST'
    )),
  ADD CONSTRAINT check_assistive_finding_reason_code
    CHECK (reason_code IN (
      'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
      'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
      'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
      'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
      'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE',
      'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST'
    )),
  ADD CONSTRAINT check_assistive_finding_affected_field
    CHECK (affected_field IN ('title', 'extraction_text', 'project_content')),
  ADD CONSTRAINT check_assistive_finding_evidence_version
    CHECK (evidence ->> 'version' IN (
      'assistive-finding-evidence/v1', 'assistive-finding-evidence/v2'
    )),
  ADD CONSTRAINT check_assistive_finding_evidence_keys
    CHECK (
      CASE evidence ->> 'version'
        WHEN 'assistive-finding-evidence/v1' THEN
          evidence ?& ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'
          ]
          AND (evidence - ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'
          ]) = '{}'::jsonb
        WHEN 'assistive-finding-evidence/v2' THEN
          evidence ?& ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation',
            'duplicateCandidates'
          ]
          AND (evidence - ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation',
            'duplicateCandidates'
          ]) = '{}'::jsonb
        ELSE false
      END
    ),
  ADD CONSTRAINT check_assistive_finding_duplicate_coherence
    CHECK (
      (check_type = 'DUPLICATE_SHORTLIST'
       AND outcome IN ('REVIEW', 'INFORMATION')
       AND reason_code IN (
         'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST'
       )
       AND affected_field = 'project_content'
       AND score_kind IS NULL
       AND score_value IS NULL
       AND evidence ->> 'version' = 'assistive-finding-evidence/v2'
       AND pg_catalog.jsonb_typeof(evidence -> 'evidenceExcerpt') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'pageNumber') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'boundingBox') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'metadataValue') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'normalizedMetadataValue') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'candidateValue') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'normalizedCandidateValue') = 'null'
       AND public.is_valid_assistive_duplicate_candidates(evidence -> 'duplicateCandidates')
       -- Defence in depth: a direct or superuser insert must not be able to record a shortlist
       -- whose outcome and reason contradict the candidate flags it stores.
       AND CASE
             WHEN public.assistive_duplicate_shortlist_has_exact_or_normalized(
               evidence -> 'duplicateCandidates'
             ) THEN outcome = 'REVIEW'
               AND reason_code = 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT'
             ELSE outcome = 'INFORMATION'
               AND reason_code = 'LEXICAL_DUPLICATE_SHORTLIST'
           END)
      OR
      (check_type <> 'DUPLICATE_SHORTLIST'
       AND reason_code NOT IN (
         'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST'
       )
       AND affected_field <> 'project_content'
       AND evidence ->> 'version' = 'assistive-finding-evidence/v1')
    );

CREATE OR REPLACE FUNCTION public.is_valid_assistive_validation_findings(p_findings jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_finding jsonb;
  v_evidence jsonb;
  v_box jsonb;
  v_has_exact_or_normalized boolean;
  v_finding_keys text[] := ARRAY[
    'checkType', 'outcome', 'classification', 'reasonCode', 'affectedField',
    'origin', 'scoreKind', 'scoreValue', 'evidence'
  ];
  v_v1_keys text[] := ARRAY[
    'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
    'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'
  ];
  v_v2_keys text[] := ARRAY[
    'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
    'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation',
    'duplicateCandidates'
  ];
BEGIN
  IF p_findings IS NULL OR pg_catalog.jsonb_typeof(p_findings) <> 'array'
     OR pg_catalog.jsonb_array_length(p_findings) NOT BETWEEN 1 AND 50
  THEN
    RETURN false;
  END IF;

  FOR v_finding IN SELECT * FROM pg_catalog.jsonb_array_elements(p_findings) LOOP
    IF pg_catalog.jsonb_typeof(v_finding) <> 'object'
       OR NOT (v_finding ?& v_finding_keys)
       OR (v_finding - v_finding_keys) <> '{}'::jsonb
       OR COALESCE(v_finding ->> 'classification', '') <> 'NON_BLOCKING'
       OR COALESCE(v_finding ->> 'checkType', '') NOT IN (
         'TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION', 'DUPLICATE_SHORTLIST')
       OR COALESCE(v_finding ->> 'outcome', '') NOT IN (
         'AGREES', 'REVIEW', 'MISMATCH', 'NOT_EVALUATED', 'INFORMATION')
       OR COALESCE(v_finding ->> 'reasonCode', '') NOT IN (
         'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
         'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
         'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
         'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
         'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE',
         'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST')
       OR COALESCE(v_finding ->> 'affectedField', '') NOT IN (
         'title', 'extraction_text', 'project_content')
       OR COALESCE(v_finding ->> 'origin', '') NOT IN (
         'PHASE_1_EXTRACTION', 'DETERMINISTIC_HELPER')
       OR (pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') = 'null')
          <> (pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') = 'null')
    THEN
      RETURN false;
    END IF;

    IF pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') <> 'null' AND (
      v_finding ->> 'scoreKind' <> 'LEXICAL_SIMILARITY'
      OR pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') <> 'number'
      OR pg_catalog.length(v_finding ->> 'scoreValue') > 32
      OR (v_finding ->> 'scoreValue')::numeric NOT BETWEEN 0 AND 1
    ) THEN
      RETURN false;
    END IF;

    v_evidence := v_finding -> 'evidence';
    IF pg_catalog.jsonb_typeof(v_evidence) <> 'object'
       OR pg_catalog.length(v_evidence::text) > 8192
       OR pg_catalog.jsonb_typeof(v_evidence -> 'explanation') <> 'string'
       OR pg_catalog.length(v_evidence ->> 'explanation') NOT BETWEEN 1 AND 300
       OR (v_evidence ->> 'explanation') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'
       OR pg_catalog.jsonb_typeof(v_evidence -> 'evidenceExcerpt') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'evidenceExcerpt') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'evidenceExcerpt') > 500
             OR (v_evidence ->> 'evidenceExcerpt') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'metadataValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'metadataValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'metadataValue') > 400
             OR (v_evidence ->> 'metadataValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'normalizedMetadataValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'normalizedMetadataValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'normalizedMetadataValue') > 400
             OR (v_evidence ->> 'normalizedMetadataValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'candidateValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'candidateValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'candidateValue') > 400
             OR (v_evidence ->> 'candidateValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'normalizedCandidateValue') NOT IN ('null', 'string')
       OR (pg_catalog.jsonb_typeof(v_evidence -> 'normalizedCandidateValue') = 'string'
           AND (pg_catalog.length(v_evidence ->> 'normalizedCandidateValue') > 400
             OR (v_evidence ->> 'normalizedCandidateValue') ~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
       OR pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') NOT IN ('null', 'number')
       OR pg_catalog.jsonb_typeof(v_evidence -> 'boundingBox') NOT IN ('null', 'object')
    THEN
      RETURN false;
    END IF;

    IF pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') = 'number' AND (
      (v_evidence ->> 'pageNumber')::numeric <> pg_catalog.trunc((v_evidence ->> 'pageNumber')::numeric)
      OR (v_evidence ->> 'pageNumber')::numeric NOT BETWEEN 1 AND 10
    ) THEN
      RETURN false;
    END IF;

    v_box := v_evidence -> 'boundingBox';
    IF pg_catalog.jsonb_typeof(v_box) = 'object' AND (
      NOT (v_box ?& ARRAY['left', 'top', 'right', 'bottom', 'unit'])
      OR (v_box - ARRAY['left', 'top', 'right', 'bottom', 'unit']) <> '{}'::jsonb
      OR pg_catalog.jsonb_typeof(v_box -> 'left') <> 'number'
      OR pg_catalog.jsonb_typeof(v_box -> 'top') <> 'number'
      OR pg_catalog.jsonb_typeof(v_box -> 'right') <> 'number'
      OR pg_catalog.jsonb_typeof(v_box -> 'bottom') <> 'number'
      OR v_box ->> 'unit' NOT IN ('PDF_POINTS_TOP_LEFT', 'IMAGE_PIXELS_TOP_LEFT')
      OR (v_box ->> 'right')::numeric < (v_box ->> 'left')::numeric
      OR (v_box ->> 'bottom')::numeric < (v_box ->> 'top')::numeric
    ) THEN
      RETURN false;
    END IF;

    IF v_finding ->> 'checkType' = 'DUPLICATE_SHORTLIST' THEN
      IF v_finding ->> 'outcome' NOT IN ('REVIEW', 'INFORMATION')
         OR v_finding ->> 'reasonCode' NOT IN (
           'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST')
         OR v_finding ->> 'affectedField' <> 'project_content'
         OR pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') <> 'null'
         OR v_evidence ->> 'version' <> 'assistive-finding-evidence/v2'
         OR NOT (v_evidence ?& v_v2_keys)
         OR (v_evidence - v_v2_keys) <> '{}'::jsonb
         OR pg_catalog.jsonb_typeof(v_evidence -> 'evidenceExcerpt') <> 'null'
         OR pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') <> 'null'
         OR pg_catalog.jsonb_typeof(v_evidence -> 'boundingBox') <> 'null'
         OR pg_catalog.jsonb_typeof(v_evidence -> 'metadataValue') <> 'null'
         OR pg_catalog.jsonb_typeof(v_evidence -> 'normalizedMetadataValue') <> 'null'
         OR pg_catalog.jsonb_typeof(v_evidence -> 'candidateValue') <> 'null'
         OR pg_catalog.jsonb_typeof(v_evidence -> 'normalizedCandidateValue') <> 'null'
         OR NOT public.is_valid_assistive_duplicate_candidates(v_evidence -> 'duplicateCandidates')
      THEN
        RETURN false;
      END IF;

      -- The shortlist outcome and reason are not free-standing enumerations: each is determined by
      -- whether any stored candidate is an exact or normalized-title match.
      v_has_exact_or_normalized := public.assistive_duplicate_shortlist_has_exact_or_normalized(
        v_evidence -> 'duplicateCandidates'
      );
      IF (v_finding ->> 'outcome' = 'REVIEW') IS DISTINCT FROM v_has_exact_or_normalized
         OR (v_finding ->> 'reasonCode' = 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT')
            IS DISTINCT FROM v_has_exact_or_normalized
      THEN
        RETURN false;
      END IF;
    ELSE
      IF v_finding ->> 'reasonCode' IN (
           'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST')
         OR v_finding ->> 'affectedField' = 'project_content'
         OR v_evidence ->> 'version' <> 'assistive-finding-evidence/v1'
         OR NOT (v_evidence ?& v_v1_keys)
         OR (v_evidence - v_v1_keys) <> '{}'::jsonb
      THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_valid_assistive_validation_findings(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- Migration 0030's terminal persistence entry point also enumerated the v1 contract. Replacing it
-- with the shared strict validator keeps legacy callers compatible while admitting the same v2
-- shape as Phase 4 finalization.
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
  v_run_id uuid;
  v_existing_run_id uuid;
  v_existing_count integer;
  v_existing_findings jsonb;
BEGIN
  IF p_project_id IS NULL OR p_actor_admin_id IS NULL
     OR v_input_hash !~ '^[a-f0-9]{64}$'
     OR v_pipeline_version !~ '^[a-z0-9]+(-[a-z0-9]+)*/v[1-9][0-9]*$'
     OR pg_catalog.length(v_pipeline_version) > 64
     OR v_status NOT IN ('COMPLETED', 'FAILED')
     OR (v_status = 'COMPLETED' AND v_failure_code IS NOT NULL)
     OR (v_status = 'FAILED' AND (v_failure_code IS NULL OR v_failure_code NOT IN (
       'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED', 'INTERNAL_FAILURE')))
     OR p_findings IS NULL OR pg_catalog.jsonb_typeof(p_findings) <> 'array'
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  v_finding_count := pg_catalog.jsonb_array_length(p_findings);
  IF (v_status = 'COMPLETED' AND NOT public.is_valid_assistive_validation_findings(p_findings))
     OR (v_status = 'FAILED' AND v_finding_count <> 0)
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users AS u
    JOIN public.user_roles AS r ON r.user_id = u.id
    WHERE u.id = p_actor_admin_id AND r.role IN ('admin', 'reviewer', 'editor')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PERMISSION_DENIED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.projects AS p WHERE p.id = p_project_id AND p.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_project_id::text || ':' || v_input_hash || ':' || v_pipeline_version)
  );
  SELECT r.id INTO v_existing_run_id
    FROM public.assistive_validation_runs AS r
    WHERE r.project_id = p_project_id AND r.input_hash = v_input_hash
      AND r.pipeline_version = v_pipeline_version AND r.status = 'COMPLETED';

  IF FOUND THEN
    SELECT pg_catalog.count(*), COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'checkType', f.check_type, 'outcome', f.outcome, 'classification', f.classification,
        'reasonCode', f.reason_code, 'affectedField', f.affected_field, 'origin', f.origin,
        'scoreKind', f.score_kind, 'scoreValue', f.score_value, 'evidence', f.evidence
      ) ORDER BY f.ordinal
    ), '[]'::jsonb)
    INTO v_existing_count, v_existing_findings
    FROM public.assistive_validation_findings AS f WHERE f.run_id = v_existing_run_id;
    IF v_status <> 'COMPLETED' OR v_existing_findings IS DISTINCT FROM p_findings THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'IDENTITY_CONFLICT');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_PERSISTED', 'runId', v_existing_run_id::text,
      'status', 'COMPLETED', 'findingCount', v_existing_count
    );
  END IF;

  INSERT INTO public.assistive_validation_runs (
    project_id, requested_by, input_hash, pipeline_version, status, failure_code
  ) VALUES (
    p_project_id, p_actor_admin_id, v_input_hash, v_pipeline_version, v_status, v_failure_code
  ) RETURNING id INTO v_run_id;

  IF v_finding_count > 0 THEN
    INSERT INTO public.assistive_validation_findings (
      run_id, check_type, outcome, classification, reason_code, affected_field, origin,
      ordinal, score_kind, score_value, evidence
    )
    SELECT v_run_id, element.value ->> 'checkType', element.value ->> 'outcome',
      'NON_BLOCKING', element.value ->> 'reasonCode', element.value ->> 'affectedField',
      element.value ->> 'origin', element.position::integer, element.value ->> 'scoreKind',
      CASE WHEN pg_catalog.jsonb_typeof(element.value -> 'scoreValue') = 'number'
        THEN (element.value ->> 'scoreValue')::numeric ELSE NULL END,
      element.value -> 'evidence'
    FROM pg_catalog.jsonb_array_elements(p_findings)
      WITH ORDINALITY AS element(value, position);
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'PERSISTED', 'runId', v_run_id::text,
    'status', v_status, 'findingCount', v_finding_count
  );
EXCEPTION WHEN unique_violation THEN
  SELECT r.id INTO v_existing_run_id
    FROM public.assistive_validation_runs AS r
    WHERE r.project_id = p_project_id AND r.input_hash = v_input_hash
      AND r.pipeline_version = v_pipeline_version AND r.status = 'COMPLETED';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;
  SELECT pg_catalog.count(*), COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'checkType', f.check_type, 'outcome', f.outcome, 'classification', f.classification,
      'reasonCode', f.reason_code, 'affectedField', f.affected_field, 'origin', f.origin,
      'scoreKind', f.score_kind, 'scoreValue', f.score_value, 'evidence', f.evidence
    ) ORDER BY f.ordinal
  ), '[]'::jsonb)
  INTO v_existing_count, v_existing_findings
  FROM public.assistive_validation_findings AS f WHERE f.run_id = v_existing_run_id;
  IF v_status <> 'COMPLETED' OR v_existing_findings IS DISTINCT FROM p_findings THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'IDENTITY_CONFLICT');
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'ALREADY_PERSISTED', 'runId', v_existing_run_id::text,
    'status', 'COMPLETED', 'findingCount', v_existing_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_assistive_validation_run(uuid, uuid, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.persist_assistive_validation_run(uuid, uuid, text, text, text, text, jsonb)
  TO service_role;

COMMIT;
