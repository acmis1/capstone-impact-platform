-- Productionize the qualified local LanguageTool 6.6 provider as non-authoritative staff evidence.
-- No function in this migration changes project metadata, workflow, review, publication, or feed state.

BEGIN;

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
     OR p_evidence ->> 'pipelineVersion' <> 'assistive-deterministic-checks/v3'
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

REVOKE ALL ON FUNCTION public.is_valid_assistive_language_evidence(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.assistive_validation_runs
  DROP CONSTRAINT check_assistive_run_failure_code,
  DROP CONSTRAINT check_assistive_run_failure_coherence;

ALTER TABLE public.assistive_validation_runs
  ADD CONSTRAINT check_assistive_run_failure_code
    CHECK (failure_code IS NULL OR failure_code IN (
      'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
      'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
      'DETERMINISTIC_CONTRACT_REJECTED', 'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE',
      'LANGUAGE_PROVIDER_UNAVAILABLE', 'OCR_AND_LANGUAGE_INCOMPLETE',
      'IDENTITY_CONFLICT', 'INTERNAL_FAILURE'
    )),
  ADD CONSTRAINT check_assistive_run_failure_coherence
    CHECK (
      (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'SUPERSEDED')
        AND failure_code IS NULL)
      OR (status = 'PARTIAL' AND failure_code IN (
        'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE', 'LANGUAGE_PROVIDER_UNAVAILABLE',
        'OCR_AND_LANGUAGE_INCOMPLETE'))
      OR (status = 'FAILED' AND failure_code IN (
        'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
        'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
        'DETERMINISTIC_CONTRACT_REJECTED', 'IDENTITY_CONFLICT', 'INTERNAL_FAILURE'))
    );

ALTER TABLE public.assistive_validation_jobs
  DROP CONSTRAINT check_assistive_job_last_error_code;

ALTER TABLE public.assistive_validation_jobs
  ADD CONSTRAINT check_assistive_job_last_error_code
    CHECK (last_error_code IS NULL OR last_error_code IN (
      'MEDIA_INVALID', 'INPUT_UNAVAILABLE', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT',
      'WORKER_CRASHED', 'EXTRACTION_CONTRACT_REJECTED', 'EXTRACTION_FAILED',
      'DETERMINISTIC_CONTRACT_REJECTED', 'OCR_REQUIRED', 'OCR_PROVIDER_UNAVAILABLE',
      'LANGUAGE_PROVIDER_UNAVAILABLE', 'OCR_AND_LANGUAGE_INCOMPLETE',
      'IDENTITY_CONFLICT', 'INTERNAL_FAILURE'
    ));

ALTER TABLE public.assistive_validation_findings
  DROP CONSTRAINT check_assistive_finding_check_type,
  DROP CONSTRAINT check_assistive_finding_reason_code,
  DROP CONSTRAINT check_assistive_finding_affected_field,
  DROP CONSTRAINT check_assistive_finding_origin,
  DROP CONSTRAINT check_assistive_finding_evidence_version,
  DROP CONSTRAINT check_assistive_finding_evidence_keys,
  DROP CONSTRAINT check_assistive_finding_duplicate_coherence,
  DROP CONSTRAINT check_assistive_finding_evidence_excerpt,
  DROP CONSTRAINT check_assistive_finding_evidence_values,
  DROP CONSTRAINT check_assistive_finding_evidence_page_number,
  DROP CONSTRAINT check_assistive_finding_evidence_bounding_box;

ALTER TABLE public.assistive_validation_findings
  ADD CONSTRAINT check_assistive_finding_check_type
    CHECK (check_type IN (
      'TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION', 'DUPLICATE_SHORTLIST',
      'LANGUAGE_SUGGESTION')),
  ADD CONSTRAINT check_assistive_finding_reason_code
    CHECK (reason_code IN (
      'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
      'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
      'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
      'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
      'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE',
      'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST',
      'LANGUAGE_SPELLING', 'LANGUAGE_GRAMMAR', 'LANGUAGE_PUNCTUATION',
      'LANGUAGE_CAPITALIZATION', 'LANGUAGE_REPEATED_WORD')),
  ADD CONSTRAINT check_assistive_finding_affected_field
    CHECK (affected_field IN (
      'title', 'summary', 'background', 'solution', 'extraction_text', 'project_content')),
  ADD CONSTRAINT check_assistive_finding_origin
    CHECK (origin IN ('PHASE_1_EXTRACTION', 'DETERMINISTIC_HELPER', 'LOCAL_LANGUAGE_PROVIDER')),
  ADD CONSTRAINT check_assistive_finding_evidence_version
    CHECK (evidence ->> 'version' IN (
      'assistive-finding-evidence/v1', 'assistive-finding-evidence/v2',
      'assistive-finding-evidence/v3')),
  ADD CONSTRAINT check_assistive_finding_evidence_keys
    CHECK (
      CASE evidence ->> 'version'
        WHEN 'assistive-finding-evidence/v1' THEN
          evidence ?& ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation']
          AND (evidence - ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation']) = '{}'::jsonb
        WHEN 'assistive-finding-evidence/v2' THEN
          evidence ?& ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation',
            'duplicateCandidates']
          AND (evidence - ARRAY[
            'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
            'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation',
            'duplicateCandidates']) = '{}'::jsonb
        WHEN 'assistive-finding-evidence/v3' THEN
          public.is_valid_assistive_language_evidence(evidence)
        ELSE false
      END
    ),
  ADD CONSTRAINT check_assistive_finding_evidence_excerpt
    CHECK (
      evidence ->> 'version' = 'assistive-finding-evidence/v3'
      OR (pg_catalog.jsonb_typeof(evidence -> 'evidenceExcerpt') IN ('null', 'string')
          AND (pg_catalog.jsonb_typeof(evidence -> 'evidenceExcerpt') = 'null'
               OR (pg_catalog.length(evidence ->> 'evidenceExcerpt') <= 500
                   AND (evidence ->> 'evidenceExcerpt') !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]')))
    ),
  ADD CONSTRAINT check_assistive_finding_evidence_values
    CHECK (
      evidence ->> 'version' = 'assistive-finding-evidence/v3'
      OR (
        pg_catalog.jsonb_typeof(evidence -> 'metadataValue') IN ('null', 'string')
        AND pg_catalog.jsonb_typeof(evidence -> 'normalizedMetadataValue') IN ('null', 'string')
        AND pg_catalog.jsonb_typeof(evidence -> 'candidateValue') IN ('null', 'string')
        AND pg_catalog.jsonb_typeof(evidence -> 'normalizedCandidateValue') IN ('null', 'string')
        AND (pg_catalog.jsonb_typeof(evidence -> 'metadataValue') = 'null'
             OR (pg_catalog.length(evidence ->> 'metadataValue') <= 400
                 AND (evidence ->> 'metadataValue') !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
        AND (pg_catalog.jsonb_typeof(evidence -> 'normalizedMetadataValue') = 'null'
             OR (pg_catalog.length(evidence ->> 'normalizedMetadataValue') <= 400
                 AND (evidence ->> 'normalizedMetadataValue') !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
        AND (pg_catalog.jsonb_typeof(evidence -> 'candidateValue') = 'null'
             OR (pg_catalog.length(evidence ->> 'candidateValue') <= 400
                 AND (evidence ->> 'candidateValue') !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
        AND (pg_catalog.jsonb_typeof(evidence -> 'normalizedCandidateValue') = 'null'
             OR (pg_catalog.length(evidence ->> 'normalizedCandidateValue') <= 400
                 AND (evidence ->> 'normalizedCandidateValue') !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F]'))
      )
    ),
  ADD CONSTRAINT check_assistive_finding_evidence_page_number
    CHECK (
      evidence ->> 'version' = 'assistive-finding-evidence/v3'
      OR CASE pg_catalog.jsonb_typeof(evidence -> 'pageNumber')
        WHEN 'null' THEN true
        WHEN 'number' THEN
          (evidence ->> 'pageNumber')::numeric = pg_catalog.trunc((evidence ->> 'pageNumber')::numeric)
          AND (evidence ->> 'pageNumber')::numeric BETWEEN 1 AND 10
        ELSE false
      END
    ),
  ADD CONSTRAINT check_assistive_finding_evidence_bounding_box
    CHECK (
      evidence ->> 'version' = 'assistive-finding-evidence/v3'
      OR CASE pg_catalog.jsonb_typeof(evidence -> 'boundingBox')
        WHEN 'null' THEN true
        WHEN 'object' THEN
          (evidence -> 'boundingBox') ?& ARRAY['left', 'top', 'right', 'bottom', 'unit']
          AND ((evidence -> 'boundingBox') - ARRAY['left', 'top', 'right', 'bottom', 'unit']) = '{}'::jsonb
          AND CASE
            WHEN pg_catalog.jsonb_typeof(evidence -> 'boundingBox' -> 'left') = 'number'
             AND pg_catalog.jsonb_typeof(evidence -> 'boundingBox' -> 'top') = 'number'
             AND pg_catalog.jsonb_typeof(evidence -> 'boundingBox' -> 'right') = 'number'
             AND pg_catalog.jsonb_typeof(evidence -> 'boundingBox' -> 'bottom') = 'number'
             AND pg_catalog.jsonb_typeof(evidence -> 'boundingBox' -> 'unit') = 'string'
            THEN (evidence -> 'boundingBox' ->> 'unit') IN (
                   'PDF_POINTS_TOP_LEFT', 'IMAGE_PIXELS_TOP_LEFT'
                 )
                 AND (evidence -> 'boundingBox' ->> 'right')::numeric
                     >= (evidence -> 'boundingBox' ->> 'left')::numeric
                 AND (evidence -> 'boundingBox' ->> 'bottom')::numeric
                     >= (evidence -> 'boundingBox' ->> 'top')::numeric
            ELSE false
          END
        ELSE false
      END
    ),
  ADD CONSTRAINT check_assistive_finding_duplicate_coherence
    CHECK (
      (check_type = 'DUPLICATE_SHORTLIST'
       AND outcome IN ('REVIEW', 'INFORMATION')
       AND reason_code IN ('EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST')
       AND affected_field = 'project_content'
       AND score_kind IS NULL AND score_value IS NULL
       AND evidence ->> 'version' = 'assistive-finding-evidence/v2'
       AND pg_catalog.jsonb_typeof(evidence -> 'evidenceExcerpt') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'pageNumber') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'boundingBox') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'metadataValue') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'normalizedMetadataValue') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'candidateValue') = 'null'
       AND pg_catalog.jsonb_typeof(evidence -> 'normalizedCandidateValue') = 'null'
       AND public.is_valid_assistive_duplicate_candidates(evidence -> 'duplicateCandidates')
       AND CASE
         WHEN public.assistive_duplicate_shortlist_has_exact_or_normalized(evidence -> 'duplicateCandidates')
           THEN outcome = 'REVIEW' AND reason_code = 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT'
         ELSE outcome = 'INFORMATION' AND reason_code = 'LEXICAL_DUPLICATE_SHORTLIST'
       END)
      OR
      (check_type <> 'DUPLICATE_SHORTLIST'
       AND reason_code NOT IN ('EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST')
       AND affected_field <> 'project_content'
       AND evidence ->> 'version' IN ('assistive-finding-evidence/v1', 'assistive-finding-evidence/v3'))
    ),
  ADD CONSTRAINT check_assistive_finding_language_coherence
    CHECK (
      (check_type = 'LANGUAGE_SUGGESTION'
       AND outcome = 'REVIEW'
       AND reason_code IN (
         'LANGUAGE_SPELLING', 'LANGUAGE_GRAMMAR', 'LANGUAGE_PUNCTUATION',
         'LANGUAGE_CAPITALIZATION', 'LANGUAGE_REPEATED_WORD')
       AND affected_field IN ('title', 'summary', 'background', 'solution')
       AND origin = 'LOCAL_LANGUAGE_PROVIDER'
       AND score_kind IS NULL AND score_value IS NULL
       AND evidence ->> 'version' = 'assistive-finding-evidence/v3'
       AND (reason_code <> 'LANGUAGE_SPELLING'
            OR pg_catalog.jsonb_array_length(evidence -> 'suggestions') >= 1)
       AND public.is_valid_assistive_language_evidence(evidence))
      OR
      (check_type <> 'LANGUAGE_SUGGESTION'
       AND reason_code NOT IN (
         'LANGUAGE_SPELLING', 'LANGUAGE_GRAMMAR', 'LANGUAGE_PUNCTUATION',
         'LANGUAGE_CAPITALIZATION', 'LANGUAGE_REPEATED_WORD')
       AND origin <> 'LOCAL_LANGUAGE_PROVIDER'
       AND affected_field NOT IN ('summary', 'background', 'solution')
       AND evidence ->> 'version' <> 'assistive-finding-evidence/v3')
    );

CREATE OR REPLACE FUNCTION public.guard_assistive_language_finding_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_input_hash text;
  v_pipeline_version text;
BEGIN
  IF NEW.evidence ->> 'version' = 'assistive-finding-evidence/v3' THEN
    SELECT input_hash, pipeline_version INTO v_input_hash, v_pipeline_version
      FROM public.assistive_validation_runs WHERE id = NEW.run_id;
    IF NOT FOUND
       OR NEW.evidence ->> 'inputHash' IS DISTINCT FROM v_input_hash
       OR NEW.evidence ->> 'pipelineVersion' IS DISTINCT FROM v_pipeline_version
    THEN
      RAISE EXCEPTION 'ASSISTIVE_LANGUAGE_IDENTITY_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_assistive_language_finding_identity()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER assistive_language_finding_identity_guard
BEFORE INSERT OR UPDATE OF run_id, evidence ON public.assistive_validation_findings
FOR EACH ROW EXECUTE FUNCTION public.guard_assistive_language_finding_identity();

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
    'origin', 'scoreKind', 'scoreValue', 'evidence'];
  v_v1_keys text[] := ARRAY[
    'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
    'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation'];
  v_v2_keys text[] := ARRAY[
    'version', 'evidenceExcerpt', 'pageNumber', 'boundingBox', 'metadataValue',
    'normalizedMetadataValue', 'candidateValue', 'normalizedCandidateValue', 'explanation',
    'duplicateCandidates'];
BEGIN
  IF p_findings IS NULL OR pg_catalog.jsonb_typeof(p_findings) <> 'array'
     OR pg_catalog.jsonb_array_length(p_findings) NOT BETWEEN 1 AND 50
  THEN RETURN false; END IF;

  FOR v_finding IN SELECT * FROM pg_catalog.jsonb_array_elements(p_findings) LOOP
    IF pg_catalog.jsonb_typeof(v_finding) <> 'object'
       OR NOT (v_finding ?& v_finding_keys)
       OR (v_finding - v_finding_keys) <> '{}'::jsonb
       OR v_finding ->> 'classification' <> 'NON_BLOCKING'
       OR COALESCE(v_finding ->> 'checkType', '') NOT IN (
         'TITLE_CONSISTENCY', 'FORMATTING', 'EXTRACTION_INFORMATION', 'DUPLICATE_SHORTLIST',
         'LANGUAGE_SUGGESTION')
       OR COALESCE(v_finding ->> 'outcome', '') NOT IN (
         'AGREES', 'REVIEW', 'MISMATCH', 'NOT_EVALUATED', 'INFORMATION')
       OR COALESCE(v_finding ->> 'reasonCode', '') NOT IN (
         'NORMALIZED_EXACT_MATCH', 'EXPLICIT_POLICY_MATCH', 'POSSIBLE_OCR_OR_SPELLING_VARIANT',
         'MATERIAL_TOKEN_DIFFERENCE', 'AMBIGUOUS_TITLE_CANDIDATES', 'METADATA_TITLE_ABSENT',
         'NO_CREDIBLE_TITLE_CANDIDATE', 'OCR_REQUIRED_NOT_RUN', 'OCR_PROVIDER_UNAVAILABLE',
         'EXTRACTION_FAILED', 'MISSING_GEOMETRY', 'SUSPICIOUS_CONTROL_CHARACTERS',
         'LEADING_OR_TRAILING_WHITESPACE', 'REPEATED_WHITESPACE',
         'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST',
         'LANGUAGE_SPELLING', 'LANGUAGE_GRAMMAR', 'LANGUAGE_PUNCTUATION',
         'LANGUAGE_CAPITALIZATION', 'LANGUAGE_REPEATED_WORD')
       OR COALESCE(v_finding ->> 'affectedField', '') NOT IN (
         'title', 'summary', 'background', 'solution', 'extraction_text', 'project_content')
       OR COALESCE(v_finding ->> 'origin', '') NOT IN (
         'PHASE_1_EXTRACTION', 'DETERMINISTIC_HELPER', 'LOCAL_LANGUAGE_PROVIDER')
       OR (pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') = 'null')
          <> (pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') = 'null')
    THEN RETURN false; END IF;

    IF pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') <> 'null' AND (
      v_finding ->> 'scoreKind' <> 'LEXICAL_SIMILARITY'
      OR pg_catalog.jsonb_typeof(v_finding -> 'scoreValue') <> 'number'
      OR pg_catalog.length(v_finding ->> 'scoreValue') > 32
      OR (v_finding ->> 'scoreValue')::numeric NOT BETWEEN 0 AND 1)
    THEN RETURN false; END IF;

    v_evidence := v_finding -> 'evidence';
    IF pg_catalog.jsonb_typeof(v_evidence) <> 'object'
       OR pg_catalog.length(v_evidence::text) > 8192
    THEN RETURN false; END IF;

    IF v_finding ->> 'checkType' <> 'LANGUAGE_SUGGESTION' THEN
      IF pg_catalog.jsonb_typeof(v_evidence -> 'explanation') <> 'string'
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
      THEN RETURN false; END IF;

      IF pg_catalog.jsonb_typeof(v_evidence -> 'pageNumber') = 'number' AND (
        (v_evidence ->> 'pageNumber')::numeric <> pg_catalog.trunc((v_evidence ->> 'pageNumber')::numeric)
        OR (v_evidence ->> 'pageNumber')::numeric NOT BETWEEN 1 AND 10
      ) THEN RETURN false; END IF;

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
      ) THEN RETURN false; END IF;
    END IF;

    IF v_finding ->> 'checkType' = 'LANGUAGE_SUGGESTION' THEN
      IF v_finding ->> 'outcome' <> 'REVIEW'
         OR v_finding ->> 'reasonCode' NOT IN (
           'LANGUAGE_SPELLING', 'LANGUAGE_GRAMMAR', 'LANGUAGE_PUNCTUATION',
           'LANGUAGE_CAPITALIZATION', 'LANGUAGE_REPEATED_WORD')
         OR v_finding ->> 'affectedField' NOT IN ('title', 'summary', 'background', 'solution')
         OR v_finding ->> 'origin' <> 'LOCAL_LANGUAGE_PROVIDER'
         OR pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') <> 'null'
         OR (v_finding ->> 'reasonCode' = 'LANGUAGE_SPELLING'
             AND pg_catalog.jsonb_array_length(v_evidence -> 'suggestions') < 1)
         OR NOT public.is_valid_assistive_language_evidence(v_evidence)
      THEN RETURN false; END IF;
    ELSIF v_finding ->> 'checkType' = 'DUPLICATE_SHORTLIST' THEN
      IF v_finding ->> 'outcome' NOT IN ('REVIEW', 'INFORMATION')
         OR v_finding ->> 'reasonCode' NOT IN (
           'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST')
         OR v_finding ->> 'affectedField' <> 'project_content'
         OR v_finding ->> 'origin' <> 'DETERMINISTIC_HELPER'
         OR pg_catalog.jsonb_typeof(v_finding -> 'scoreKind') <> 'null'
         OR NOT (v_evidence ?& v_v2_keys) OR (v_evidence - v_v2_keys) <> '{}'::jsonb
         OR v_evidence ->> 'version' <> 'assistive-finding-evidence/v2'
         OR NOT public.is_valid_assistive_duplicate_candidates(v_evidence -> 'duplicateCandidates')
      THEN RETURN false; END IF;
      v_has_exact_or_normalized := public.assistive_duplicate_shortlist_has_exact_or_normalized(
        v_evidence -> 'duplicateCandidates');
      IF (v_finding ->> 'outcome' = 'REVIEW') IS DISTINCT FROM v_has_exact_or_normalized
         OR (v_finding ->> 'reasonCode' = 'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT')
            IS DISTINCT FROM v_has_exact_or_normalized
      THEN RETURN false; END IF;
    ELSE
      IF v_finding ->> 'reasonCode' IN (
           'EXACT_OR_NORMALIZED_DUPLICATE_PRESENT', 'LEXICAL_DUPLICATE_SHORTLIST',
           'LANGUAGE_SPELLING', 'LANGUAGE_GRAMMAR', 'LANGUAGE_PUNCTUATION',
           'LANGUAGE_CAPITALIZATION', 'LANGUAGE_REPEATED_WORD')
         OR v_finding ->> 'affectedField' IN ('project_content', 'summary', 'background', 'solution')
         OR v_finding ->> 'origin' = 'LOCAL_LANGUAGE_PROVIDER'
         OR v_evidence ->> 'version' <> 'assistive-finding-evidence/v1'
         OR NOT (v_evidence ?& v_v1_keys) OR (v_evidence - v_v1_keys) <> '{}'::jsonb
      THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN data_exception THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_valid_assistive_validation_findings(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

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
           OR finding #>> '{evidence,pipelineVersion}' <> 'assistive-deterministic-checks/v3'))
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

REVOKE ALL ON FUNCTION public.finalize_assistive_validation_job(uuid, uuid, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_assistive_validation_job(uuid, uuid, text, text, text, jsonb)
  TO service_role;

COMMIT;
