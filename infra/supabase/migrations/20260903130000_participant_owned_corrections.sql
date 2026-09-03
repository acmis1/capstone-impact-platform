-- Migration 0051: immutable project-team packages and staff review authority.
BEGIN;
-- XLSX source evidence is isolated from the existing image/PDF-only draft bucket.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('participant-corrections-private','participant-corrections-private',false,20971520,
  ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/png','image/jpeg','image/webp','application/pdf'])
ON CONFLICT(id) DO NOTHING;
CREATE TABLE public.participant_correction_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correction_request_id uuid REFERENCES public.participant_preview_correction_requests(id),
  participant_preview_id uuid REFERENCES public.participant_previews(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  source text NOT NULL CHECK (source IN ('participant_capability','staff_pre_preview')),
  transported_by uuid REFERENCES public.admin_users(id),
  base_version text,
  validation_checks jsonb NOT NULL CHECK (jsonb_typeof(validation_checks)='array' AND octet_length(validation_checks::text)<=8192),
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 262144),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) BETWEEN 3 AND 13),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings) = 'array' AND octet_length(warnings::text) <= 32768),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 1 AND 33554432),
  storage_bucket text NOT NULL,
  state text NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing','submitted','superseded','frozen','accepted','returned')),
  reserved_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz,
  frozen_at timestamptz, frozen_by uuid REFERENCES public.admin_users(id), frozen_version text,
  decided_at timestamptz, decided_by uuid REFERENCES public.admin_users(id),
  UNIQUE(correction_request_id, package_hash),
  CHECK ((source='participant_capability' AND correction_request_id IS NOT NULL AND participant_preview_id IS NOT NULL AND transported_by IS NULL AND base_version IS NULL) OR
    (source='staff_pre_preview' AND correction_request_id IS NULL AND participant_preview_id IS NULL AND transported_by IS NOT NULL AND base_version IS NOT NULL AND base_version ~ '^[a-f0-9]{64}$')),
  CHECK ((state = 'preparing') = (submitted_at IS NULL)),
  CHECK ((frozen_at IS NULL) = (frozen_by IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CHECK (state NOT IN ('frozen','accepted') OR (frozen_at IS NOT NULL AND frozen_version ~ '^[a-f0-9]{64}$'))
);
CREATE UNIQUE INDEX participant_correction_one_submitted ON public.participant_correction_submissions(correction_request_id) WHERE state = 'submitted';
CREATE UNIQUE INDEX participant_correction_one_frozen ON public.participant_correction_submissions(correction_request_id) WHERE frozen_at IS NOT NULL;
CREATE UNIQUE INDEX participant_correction_one_accepted ON public.participant_correction_submissions(correction_request_id) WHERE state = 'accepted';
CREATE UNIQUE INDEX pre_preview_package_identity ON public.participant_correction_submissions(project_id,base_version,package_hash) WHERE source='staff_pre_preview';
CREATE UNIQUE INDEX pre_preview_one_submitted ON public.participant_correction_submissions(project_id) WHERE source='staff_pre_preview' AND state='submitted';
CREATE UNIQUE INDEX pre_preview_one_frozen ON public.participant_correction_submissions(project_id) WHERE source='staff_pre_preview' AND state='frozen';
ALTER TABLE public.participant_correction_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.participant_correction_submissions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.participant_correction_submissions TO service_role;

-- Complete prior records are retained before application; no Storage object is removed.
-- This private recovery evidence includes original row identities, timestamps and mappings.
CREATE TABLE public.participant_correction_prior_revisions (
  submission_id uuid PRIMARY KEY REFERENCES public.participant_correction_submissions(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  correction_request_id uuid REFERENCES public.participant_preview_correction_requests(id),
  package_hash text NOT NULL CHECK (package_hash ~ '^[a-f0-9]{64}$'),
  expected_version text NOT NULL CHECK (expected_version ~ '^[a-f0-9]{64}$'),
  accepted_by uuid NOT NULL REFERENCES public.admin_users(id),
  project_record jsonb NOT NULL, media_records jsonb NOT NULL,
  discipline_records jsonb NOT NULL, industry_records jsonb NOT NULL, validation_records jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.participant_correction_prior_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.participant_correction_prior_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.participant_correction_prior_revisions TO service_role;

-- One immutable record per old row, including retained/updated rows. The submission is
-- the unique acceptance operation; its header binds actor, time, hash and correction.
CREATE TABLE public.participant_correction_recovery_rows (
  submission_id uuid NOT NULL REFERENCES public.participant_correction_prior_revisions(submission_id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  source_table text NOT NULL CHECK (source_table IN ('media_assets','project_disciplines','project_industry_categories','validation_flags')),
  original_identity jsonb NOT NULL CHECK (jsonb_typeof(original_identity) = 'object'),
  row_data jsonb NOT NULL CHECK (jsonb_typeof(row_data) = 'object'),
  PRIMARY KEY (submission_id,source_table,original_identity),
  CHECK (row_data->>'project_id' = project_id::text)
);
ALTER TABLE public.participant_correction_recovery_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.participant_correction_recovery_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.participant_correction_recovery_rows TO service_role;

CREATE FUNCTION public.reject_correction_audit_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'CORRECTION_EVIDENCE_IMMUTABLE'; END; $$;
CREATE TRIGGER correction_prior_revision_immutable BEFORE UPDATE OR DELETE ON public.participant_correction_prior_revisions
FOR EACH ROW EXECUTE FUNCTION public.reject_correction_audit_change();
CREATE TRIGGER correction_recovery_row_immutable BEFORE UPDATE OR DELETE ON public.participant_correction_recovery_rows
FOR EACH ROW EXECUTE FUNCTION public.reject_correction_audit_change();

CREATE TABLE public.participant_correction_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.participant_correction_submissions(id),
  event text NOT NULL CHECK (event IN ('participant_submitted','staff_transported_package','staff_began_review','staff_accepted_revision','staff_returned_revision')),
  staff_actor_id uuid REFERENCES public.admin_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event = 'participant_submitted') = (staff_actor_id IS NULL)), UNIQUE(submission_id,event)
);
ALTER TABLE public.participant_correction_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.participant_correction_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.participant_correction_events TO service_role;
CREATE TRIGGER correction_event_immutable BEFORE UPDATE OR DELETE ON public.participant_correction_events
FOR EACH ROW EXECUTE FUNCTION public.reject_correction_audit_change();

CREATE FUNCTION public.guard_participant_correction_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     (to_jsonb(NEW) - ARRAY['state','submitted_at','frozen_at','frozen_by','frozen_version','decided_at','decided_by']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','submitted_at','frozen_at','frozen_by','frozen_version','decided_at','decided_by'])
  THEN RAISE EXCEPTION 'CORRECTION_EVIDENCE_IMMUTABLE'; END IF;
  IF (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) OR
     (OLD.frozen_at IS NOT NULL AND ROW(NEW.frozen_at,NEW.frozen_by,NEW.frozen_version) IS DISTINCT FROM ROW(OLD.frozen_at,OLD.frozen_by,OLD.frozen_version)) OR
     OLD.decided_at IS NOT NULL
  THEN RAISE EXCEPTION 'CORRECTION_EVIDENCE_IMMUTABLE'; END IF;
  IF NOT ((OLD.state = 'preparing' AND NEW.state = 'submitted') OR
          (OLD.state = 'submitted' AND NEW.state IN ('superseded','frozen','returned')) OR
          (OLD.state = 'frozen' AND NEW.state IN ('accepted','returned')))
  THEN RAISE EXCEPTION 'CORRECTION_STATE_INVALID'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER participant_correction_evidence_immutable BEFORE UPDATE OR DELETE ON public.participant_correction_submissions
FOR EACH ROW EXECUTE FUNCTION public.guard_participant_correction_evidence();

CREATE FUNCTION public.participant_correction_project_version(p_project_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT encode(extensions.digest(jsonb_build_object('project',to_jsonb(p),
    'media',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.media_assets m WHERE m.project_id=p.id),'[]'::jsonb),
    'disciplines',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.discipline_id) FROM public.project_disciplines d WHERE d.project_id=p.id),'[]'::jsonb),
    'industries',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.industry_category_id) FROM public.project_industry_categories i WHERE i.project_id=p.id),'[]'::jsonb),
    'validationFlags',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.validation_flags v WHERE v.project_id=p.id),'[]'::jsonb)
  )::text,'sha256'),'hex') FROM public.projects p WHERE p.id=p_project_id;
$$;

-- Exact preview row serializes with confirmation/revocation. No caller-supplied project id.
CREATE FUNCTION public.participant_correction_context(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pp public.participant_previews; r public.participant_preview_correction_requests; p public.projects;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  SELECT p0.* INTO p FROM public.projects p0 JOIN public.participant_previews pp0 ON pp0.project_id=p0.id WHERE pp0.token_hash=p_token_hash;
  IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('participant_preview:'||p.public_id));
  SELECT * INTO p FROM public.projects WHERE id=p.id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR p.status<>'approved' THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  SELECT * INTO pp FROM public.participant_previews WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR pp.status <> 'active' OR pp.revoked_at IS NOT NULL OR pp.expires_at <= now() OR
     EXISTS(SELECT 1 FROM public.participant_preview_confirmations WHERE participant_preview_id=pp.id)
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  SELECT * INTO r FROM public.participant_preview_correction_requests WHERE participant_preview_id=pp.id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'open' THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF pp.project_id<>p.id OR (SELECT count(*) FROM public.participant_preview_correction_requests r0 JOIN public.participant_previews pp0 ON pp0.id=r0.participant_preview_id WHERE pp0.project_id=p.id AND r0.status IN ('open','in_progress'))<>1 THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  RETURN jsonb_build_object('resultCode','SUCCESS','projectId',p.id,'publicId',p.public_id,'previewId',pp.id,'correctionId',r.id,
    'submitted',EXISTS(SELECT 1 FROM public.participant_correction_submissions s WHERE s.correction_request_id=r.id AND s.state='submitted'),
    'canSubmit',(SELECT count(*) < 3 OR bool_or(s.state='preparing') FROM public.participant_correction_submissions s WHERE s.correction_request_id=r.id));
END; $$;

-- Staff transports a complete project-team package before the first preview. The
-- project lock shares the lifecycle boundary with review and preview operations.
CREATE FUNCTION public.pre_preview_package_context(p_public_id text,p_admin_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.projects; roles text[]; version text;
BEGIN
  SELECT array_agg(role) INTO roles FROM public.user_roles WHERE user_id=p_admin_id;
  IF NOT COALESCE(('admin'=ANY(roles) OR 'editor'=ANY(roles)) AND ('admin'=ANY(roles) OR 'reviewer'=ANY(roles)),false)
  THEN RETURN jsonb_build_object('resultCode','PERMISSION_DENIED'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('participant_preview:'||p_public_id));
  SELECT * INTO p FROM public.projects WHERE public_id=p_public_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR p.status NOT IN ('draft','submitted','in_review','changes_requested') OR
     (p.import_batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.import_batches b WHERE b.id=p.import_batch_id AND b.status='completed')) OR
     EXISTS(SELECT 1 FROM public.participant_previews WHERE project_id=p.id) OR
     EXISTS(SELECT 1 FROM public.public_feed_operations WHERE (project_id=p.id OR kind IN ('activation','rollback')) AND state NOT IN ('COMPLETED','FAILED')) OR
     EXISTS(SELECT 1 FROM public.publication_attempts WHERE project_id=p.id AND state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM public.public_removal_attempts WHERE project_id=p.id AND state NOT IN ('completed','failed'))
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  version:=public.participant_correction_project_version(p.id);
  RETURN jsonb_build_object('resultCode','SUCCESS','projectId',p.id,'publicId',p.public_id,'expectedVersion',version,
    'canSubmit',NOT EXISTS(SELECT 1 FROM public.participant_correction_submissions WHERE project_id=p.id AND state='frozen') AND
      ((SELECT count(*) FROM public.participant_correction_submissions WHERE project_id=p.id AND base_version=version)<3 OR
       EXISTS(SELECT 1 FROM public.participant_correction_submissions WHERE project_id=p.id AND base_version=version AND state='preparing')));
END; $$;

-- Both entry points use the same validation, immutable reservations, quota and Storage identity.
CREATE FUNCTION public.reserve_participant_correction(p_token_hash text,p_package_hash text,p_metadata jsonb,p_files jsonb,p_warnings jsonb,p_bucket text,
  p_validation_checks jsonb DEFAULT '[]',p_public_id text DEFAULT NULL,p_admin_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ctx jsonb; s public.participant_correction_submissions; f jsonb; total bigint := 0; n integer; k text; v_name text;
BEGIN
  IF p_token_hash IS NULL THEN
    ctx:=public.pre_preview_package_context(p_public_id,p_admin_id);
    IF EXISTS(SELECT 1 FROM public.participant_correction_submissions WHERE project_id=(ctx->>'projectId')::uuid AND state='frozen') THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  ELSE
    IF p_public_id IS NOT NULL OR p_admin_id IS NOT NULL THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    ctx:=public.participant_correction_context(p_token_hash);
  END IF;
  IF ctx->>'resultCode' <> 'SUCCESS' THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF p_package_hash IS NULL OR p_package_hash !~ '^[a-f0-9]{64}$' OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' OR
     p_metadata->>'publicId' IS DISTINCT FROM ctx->>'publicId' OR octet_length(p_metadata::text)>262144 OR
     p_files IS NULL OR jsonb_typeof(p_files)<>'array' OR jsonb_array_length(p_files) NOT BETWEEN 3 AND 13 OR
     p_warnings IS NULL OR jsonb_typeof(p_warnings)<>'array' OR octet_length(p_warnings::text)>32768 OR
     p_validation_checks IS NULL OR jsonb_typeof(p_validation_checks)<>'array' OR octet_length(p_validation_checks::text)>8192 OR
     p_bucket IS DISTINCT FROM 'participant-corrections-private' OR NOT EXISTS(SELECT 1 FROM storage.buckets b WHERE b.id=p_bucket AND NOT b.public)
  THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_metadata) LOOP
    IF k <> ALL(ARRAY['publicId','title','summary','background','solution','year','program','studyProgram','discipline','industry','industryPartner','academicSupervisor','groupName','participantContactEmail','teamMembers','videoUrl','demoUrl','repositoryUrl','posterText','accessibilityText','snapshotAltText','galleryAltTexts','layoutConfig']) THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['title','summary','program','discipline','groupName','posterText','accessibilityText'] LOOP
    IF jsonb_typeof(p_metadata->k) IS DISTINCT FROM 'string' OR btrim(p_metadata->>k)='' THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  END LOOP;
  IF COALESCE(p_metadata->>'year','') !~ '^[0-9]{4}$' OR (p_metadata->>'year')::integer NOT BETWEEN 1900 AND 2100 OR
     length(p_metadata->>'posterText')>20000 OR length(p_metadata->>'accessibilityText')>2000 OR
     jsonb_typeof(p_metadata->'teamMembers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_metadata->'teamMembers') NOT BETWEEN 1 AND 100 OR
     jsonb_typeof(p_metadata->'layoutConfig') IS DISTINCT FROM 'object'
  THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  FOREACH k IN ARRAY ARRAY['videoUrl','demoUrl','repositoryUrl'] LOOP
    v_name := NULLIF(p_metadata->>k,'');
    IF v_name IS NOT NULL AND (length(v_name)>2048 OR v_name !~* '^https?://[^/?#[:space:]@]+' OR v_name ~ '[[:space:][:cntrl:]]' OR v_name ~* '^https?://[^/?#]*@' OR position(chr(92) in v_name)>0) THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  END LOOP;
  SELECT count(*) INTO n FROM public.programs pr WHERE lower(btrim(pr.name))=lower(btrim(p_metadata->>'program'));
  IF n<>1 THEN RETURN jsonb_build_object('resultCode','LOOKUP_INVALID'); END IF;
  FOR v_name IN SELECT btrim(value) FROM regexp_split_to_table(p_metadata->>'discipline',',') value LOOP
    SELECT count(*) INTO n FROM public.disciplines d WHERE lower(btrim(d.name))=lower(v_name);
    IF n<>1 THEN RETURN jsonb_build_object('resultCode','LOOKUP_INVALID'); END IF;
  END LOOP;
  FOR v_name IN SELECT btrim(value) FROM regexp_split_to_table(COALESCE(p_metadata->>'industry',''),',') value WHERE btrim(value)<>'' LOOP
    SELECT count(*) INTO n FROM public.industry_categories d WHERE lower(btrim(d.name))=lower(v_name);
    IF n<>1 THEN RETURN jsonb_build_object('resultCode','LOOKUP_INVALID'); END IF;
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(p_files) LOOP
    IF jsonb_typeof(f)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(f))<>8 OR
       NOT (f ?& ARRAY['role','position','fileName','mimeType','bytes','sha256','altText','storageName']) OR
       COALESCE(f->>'role','') NOT IN ('workbook','poster_image','poster_pdf','snapshot_image') OR
       COALESCE(f->>'sha256','') !~ '^[a-f0-9]{64}$' OR COALESCE(f->>'bytes','') !~ '^[1-9][0-9]{0,8}$' OR
       COALESCE(length(f->>'fileName'),0) NOT BETWEEN 1 AND 100 OR f->>'fileName' ~ '[\/\\[:cntrl:]]' OR position('..' in f->>'fileName')>0 OR
       COALESCE(f->>'storageName','') !~ '^(workbook|poster_image|poster_pdf|snapshot_image-[1-9][0-9]?)\.(xlsx|png|jpg|jpeg|webp|pdf)$'
    THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
    IF (f->>'role'='workbook' AND (f->>'mimeType' IS DISTINCT FROM 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' OR (f->>'bytes')::bigint>5242880)) OR
       (f->>'role'='poster_pdf' AND (f->>'mimeType' IS DISTINCT FROM 'application/pdf' OR (f->>'bytes')::bigint>20971520)) OR
       (f->>'role' IN ('poster_image','snapshot_image') AND (COALESCE(f->>'mimeType','') NOT IN ('image/png','image/jpeg','image/webp') OR (f->>'bytes')::bigint>5242880)) OR
       (f->>'role'='snapshot_image' AND (COALESCE(f->>'position','') !~ '^([1-9]|10)$' OR length(btrim(COALESCE(f->>'altText',''))) NOT BETWEEN 1 AND 2000)) OR
       (f->>'role'<>'snapshot_image' AND (f->'position' IS DISTINCT FROM 'null'::jsonb OR f->'altText' IS DISTINCT FROM 'null'::jsonb))
    THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
    total := total+(f->>'bytes')::bigint;
  END LOOP;
  IF total>33554432 OR (SELECT count(DISTINCT value->>'storageName') FROM jsonb_array_elements(p_files))<>jsonb_array_length(p_files) OR
     (SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='workbook')<>1 OR
     (SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='poster_image')<>1 OR
     (SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='poster_pdf')<>1 OR
     (SELECT count(DISTINCT value->>'position') FROM jsonb_array_elements(p_files) WHERE value->>'role'='snapshot_image')<>(SELECT count(*) FROM jsonb_array_elements(p_files) WHERE value->>'role'='snapshot_image')
  THEN RETURN jsonb_build_object('resultCode','INVALID_PACKAGE'); END IF;
  SELECT * INTO s FROM public.participant_correction_submissions WHERE package_hash=p_package_hash AND
    (correction_request_id=(ctx->>'correctionId')::uuid OR (source='staff_pre_preview' AND project_id=(ctx->>'projectId')::uuid AND base_version=ctx->>'expectedVersion'));
  IF FOUND THEN
    IF s.metadata IS DISTINCT FROM p_metadata OR s.files IS DISTINCT FROM p_files OR s.warnings IS DISTINCT FROM p_warnings OR s.validation_checks IS DISTINCT FROM p_validation_checks OR s.storage_bucket IS DISTINCT FROM p_bucket OR s.state NOT IN ('preparing','submitted') THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    RETURN jsonb_build_object('resultCode','SUCCESS','submissionId',s.id,'state',s.state,'prefix','corrections/'||s.project_id||'/'||COALESCE(s.correction_request_id,s.id)||'/'||s.id||'/');
  END IF;
  IF (SELECT count(*)>=3 OR COALESCE(sum(total_bytes),0)+total>100663296 FROM public.participant_correction_submissions WHERE
    correction_request_id=(ctx->>'correctionId')::uuid OR (source='staff_pre_preview' AND project_id=(ctx->>'projectId')::uuid AND base_version=ctx->>'expectedVersion')) THEN RETURN jsonb_build_object('resultCode','LIMIT_REACHED'); END IF;
  INSERT INTO public.participant_correction_submissions(correction_request_id,participant_preview_id,project_id,package_hash,metadata,files,warnings,total_bytes,storage_bucket,source,transported_by,base_version,validation_checks)
  VALUES((ctx->>'correctionId')::uuid,(ctx->>'previewId')::uuid,(ctx->>'projectId')::uuid,p_package_hash,p_metadata,p_files,p_warnings,total,p_bucket,
    CASE WHEN p_token_hash IS NULL THEN 'staff_pre_preview' ELSE 'participant_capability' END,p_admin_id,ctx->>'expectedVersion',p_validation_checks) RETURNING * INTO s;
  RETURN jsonb_build_object('resultCode','SUCCESS','submissionId',s.id,'state',s.state,'prefix','corrections/'||s.project_id||'/'||COALESCE(s.correction_request_id,s.id)||'/'||s.id||'/');
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE');
END; $$;

CREATE FUNCTION public.complete_participant_correction(p_token_hash text,p_submission_id uuid,p_package_hash text,p_public_id text DEFAULT NULL,p_admin_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ctx jsonb; s public.participant_correction_submissions; f jsonb; prefix text;
BEGIN
  IF p_token_hash IS NULL THEN
    ctx:=public.pre_preview_package_context(p_public_id,p_admin_id);
    IF EXISTS(SELECT 1 FROM public.participant_correction_submissions WHERE project_id=(ctx->>'projectId')::uuid AND state='frozen') THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  ELSE
    IF p_public_id IS NOT NULL OR p_admin_id IS NOT NULL THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    ctx:=public.participant_correction_context(p_token_hash);
  END IF;
  IF ctx->>'resultCode'<>'SUCCESS' THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  SELECT * INTO s FROM public.participant_correction_submissions WHERE id=p_submission_id AND package_hash=p_package_hash AND
    (correction_request_id=(ctx->>'correctionId')::uuid OR (source='staff_pre_preview' AND project_id=(ctx->>'projectId')::uuid AND base_version=ctx->>'expectedVersion')) FOR UPDATE;
  IF NOT FOUND OR s.state NOT IN ('preparing','submitted') THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF s.state='submitted' THEN RETURN jsonb_build_object('resultCode','SUCCESS'); END IF;
  IF EXISTS(SELECT 1 FROM public.participant_correction_submissions newer WHERE
    (newer.correction_request_id=s.correction_request_id OR (s.source='staff_pre_preview' AND newer.source=s.source AND newer.project_id=s.project_id)) AND
    newer.state='submitted' AND newer.reserved_at>s.reserved_at) THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  prefix:='corrections/'||s.project_id||'/'||COALESCE(s.correction_request_id,s.id)||'/'||s.id||'/';
  FOR f IN SELECT value FROM jsonb_array_elements(s.files) LOOP
    IF NOT EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE NOT b.public AND o.bucket_id=s.storage_bucket AND o.name=prefix||(f->>'storageName') AND (o.metadata->>'size')::bigint=(f->>'bytes')::bigint AND o.metadata->>'mimetype'=f->>'mimeType') THEN RETURN jsonb_build_object('resultCode','STORAGE_INCOMPLETE'); END IF;
  END LOOP;
  UPDATE public.participant_correction_submissions SET state='superseded' WHERE state='submitted' AND
    (correction_request_id=s.correction_request_id OR (s.source='staff_pre_preview' AND source=s.source AND project_id=s.project_id));
  UPDATE public.participant_correction_submissions SET state='submitted',submitted_at=now() WHERE id=s.id;
  INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id)
  VALUES(s.id,CASE WHEN s.source='staff_pre_preview' THEN 'staff_transported_package' ELSE 'participant_submitted' END,p_admin_id);
  RETURN jsonb_build_object('resultCode','SUCCESS');
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE');
END; $$;

-- The former action could open an editable draft without a participant revision.
CREATE OR REPLACE FUNCTION public.start_participant_preview_correction_resolution(p_public_id text,p_admin_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('resultCode','PARTICIPANT_CANDIDATE_REQUIRED');
$$;

-- Only identity, evidence hashes and a governance decision enter this boundary.
-- All replacement values come from the immutable, project-team-authored package.
CREATE FUNCTION public.review_participant_correction(
  p_public_id text,p_admin_id uuid,p_submission_id uuid,p_package_hash text,p_expected_version text,p_action text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p public.projects; s public.participant_correction_submissions;
  pp public.participant_previews; r public.participant_preview_correction_requests;
  roles text[]; f jsonb; old_row jsonb; path text; candidate_path text; ctx jsonb;
  v_program_id uuid; v_program_name text; lookup_id uuid; lookup_name text;
  discipline_ids uuid[] := '{}'; industry_ids uuid[] := '{}';
  first_discipline text; first_industry text; acceptance_time timestamptz := now();
BEGIN
  SELECT array_agg(role) INTO roles FROM public.user_roles WHERE user_id=p_admin_id;
  IF NOT COALESCE(('admin'=ANY(roles) OR 'editor'=ANY(roles)) AND ('admin'=ANY(roles) OR 'reviewer'=ANY(roles)),false)
  THEN RETURN jsonb_build_object('resultCode','PERMISSION_DENIED'); END IF;
  IF p_action NOT IN ('begin','accept','return') OR p_action IS NULL OR p_expected_version IS NULL OR p_expected_version !~ '^[a-f0-9]{64}$'
  THEN RETURN jsonb_build_object('resultCode','INVALID_SELECTION'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('participant_preview:'||p_public_id));
  SELECT * INTO p FROM public.projects WHERE public_id=p_public_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  SELECT * INTO s FROM public.participant_correction_submissions WHERE id=p_submission_id AND project_id=p.id AND package_hash=p_package_hash;
  IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF s.source='participant_capability' THEN
    SELECT * INTO pp FROM public.participant_previews WHERE id=s.participant_preview_id AND project_id=p.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    SELECT * INTO r FROM public.participant_preview_correction_requests WHERE id=s.correction_request_id AND participant_preview_id=pp.id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  END IF;
  SELECT * INTO s FROM public.participant_correction_submissions WHERE id=s.id FOR UPDATE;
  -- Receipt replay never reapplies content, creates recovery rows or retires rows again.
  IF p_action='accept' AND s.state='accepted' AND s.frozen_version=p_expected_version THEN
    RETURN jsonb_build_object('resultCode','SUCCESS','state','accepted','alreadyApplied',true);
  END IF;
  -- Returning a complete pre-preview package never applies content. Match its
  -- recorded revision identity, even when governance changes made the current draft stale.
  IF s.source='staff_pre_preview' AND p_action='return' AND
     ((s.state='submitted' AND s.base_version=p_expected_version) OR
      (s.state='frozen' AND s.frozen_version=p_expected_version)) THEN
    UPDATE public.participant_correction_submissions SET state='returned',decided_at=now(),decided_by=p_admin_id WHERE id=s.id;
    INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_returned_revision',p_admin_id);
    RETURN jsonb_build_object('resultCode','SUCCESS','state','returned');
  END IF;
  PERFORM 1 FROM public.media_assets WHERE project_id=p.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.project_disciplines WHERE project_id=p.id ORDER BY discipline_id FOR UPDATE;
  PERFORM 1 FROM public.project_industry_categories WHERE project_id=p.id ORDER BY industry_category_id FOR UPDATE;
  PERFORM 1 FROM public.validation_flags WHERE project_id=p.id ORDER BY id FOR UPDATE;
  IF public.participant_correction_project_version(p.id) IS DISTINCT FROM p_expected_version
  THEN RETURN jsonb_build_object('resultCode','STALE_REVISION'); END IF;
  IF s.source='participant_capability' AND (SELECT count(*) FROM public.participant_preview_correction_requests cr JOIN public.participant_previews pv ON pv.id=cr.participant_preview_id WHERE pv.project_id=p.id AND cr.status IN ('open','in_progress'))<>1
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  IF EXISTS(SELECT 1 FROM public.public_feed_operations WHERE (project_id=p.id OR kind IN ('activation','rollback')) AND state NOT IN ('COMPLETED','FAILED')) OR
     EXISTS(SELECT 1 FROM public.publication_attempts WHERE project_id=p.id AND state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM public.public_removal_attempts WHERE project_id=p.id AND state NOT IN ('completed','failed'))
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  -- Published media or a public bucket is never silently normalized or retired.
  IF (s.source='participant_capability' AND p.status NOT IN ('approved','changes_requested')) OR p.poster_url IS NOT NULL OR p.poster_pdf_url IS NOT NULL OR COALESCE(cardinality(p.snapshots),0)<>0 OR
     EXISTS(SELECT 1 FROM public.media_assets m LEFT JOIN storage.buckets b ON b.id=m.storage_bucket WHERE m.project_id=p.id AND
       (m.is_public_approved IS DISTINCT FROM false OR m.public_url IS NOT NULL OR m.public_storage_bucket IS NOT NULL OR m.public_storage_path IS NOT NULL OR b.public IS DISTINCT FROM false OR m.asset_type NOT IN ('poster_image','poster_pdf','snapshot_image')))
  THEN RETURN jsonb_build_object('resultCode','UNSAFE_REVISION'); END IF;

  IF s.source='staff_pre_preview' THEN
    ctx:=public.pre_preview_package_context(p_public_id,p_admin_id);
    IF ctx->>'resultCode'<>'SUCCESS' OR s.base_version IS DISTINCT FROM p_expected_version
    THEN RETURN jsonb_build_object('resultCode','STALE_REVISION'); END IF;
    IF p_action='begin' THEN
      IF s.state<>'submitted' OR EXISTS(SELECT 1 FROM public.participant_correction_submissions WHERE project_id=p.id AND state='frozen')
      THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
      UPDATE public.participant_correction_submissions SET state='frozen',frozen_at=now(),frozen_by=p_admin_id,frozen_version=p_expected_version WHERE id=s.id;
      INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_began_review',p_admin_id);
      RETURN jsonb_build_object('resultCode','SUCCESS','state','frozen');
    END IF;
    IF p_action<>'accept' OR s.state<>'frozen' OR s.frozen_version IS DISTINCT FROM p_expected_version
    THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  ELSE
  IF p_action='begin' THEN
    IF s.state<>'submitted' OR r.status<>'open' OR p.status<>'approved' OR pp.status<>'active' OR pp.revoked_at IS NOT NULL OR pp.expires_at<=now() OR
       EXISTS(SELECT 1 FROM public.participant_preview_confirmations WHERE participant_preview_id=pp.id) OR
       EXISTS(SELECT 1 FROM public.participant_previews WHERE project_id=p.id AND status='active' AND id<>pp.id)
    THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    -- Only existing lifecycle fields change. Snapshot JSON, comment and response evidence stay intact.
    UPDATE public.participant_previews SET status='revoked',revoked_at=now(),revoked_by=p_admin_id WHERE id=pp.id;
    UPDATE public.projects SET status='changes_requested' WHERE id=p.id;
    UPDATE public.participant_preview_correction_requests SET status='in_progress',resolution_started_at=now(),resolution_started_by=p_admin_id WHERE id=r.id;
    UPDATE public.participant_correction_submissions SET state='frozen',frozen_at=now(),frozen_by=p_admin_id,frozen_version=public.participant_correction_project_version(p.id) WHERE id=s.id;
    INSERT INTO public.approval_records(project_id,admin_id,action_taken,from_status,to_status,comments)
      VALUES(p.id,p_admin_id,'request_changes','approved','changes_requested','Review started for a participant-authored correction package');
    INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_began_review',p_admin_id);
    RETURN jsonb_build_object('resultCode','SUCCESS','state','frozen');
  END IF;

  IF p_action='return' THEN
    IF NOT (s.state='frozen' AND r.status='in_progress' AND p.status='changes_requested' AND pp.status='revoked' AND s.frozen_version=p_expected_version)
    THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
    UPDATE public.participant_correction_submissions SET state='returned',decided_at=now(),decided_by=p_admin_id WHERE id=s.id;
    INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id) VALUES(s.id,'staff_returned_revision',p_admin_id);
    RETURN jsonb_build_object('resultCode','SUCCESS','state','returned');
  END IF;

  IF s.state<>'frozen' OR r.status<>'in_progress' OR p.status<>'changes_requested' OR pp.status<>'revoked' OR pp.revoked_at IS NULL OR s.frozen_version IS DISTINCT FROM p_expected_version
  THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE'); END IF;
  END IF;
  SELECT pr.id,pr.name INTO STRICT v_program_id,v_program_name FROM public.programs pr WHERE lower(btrim(pr.name))=lower(btrim(s.metadata->>'program'));
  FOR lookup_name IN SELECT btrim(value) FROM regexp_split_to_table(s.metadata->>'discipline',',') value LOOP
    SELECT d.id,d.name INTO STRICT lookup_id,lookup_name FROM public.disciplines d WHERE lower(btrim(d.name))=lower(lookup_name);
    discipline_ids:=array_append(discipline_ids,lookup_id); first_discipline:=COALESCE(first_discipline,lookup_name);
  END LOOP;
  FOR lookup_name IN SELECT btrim(value) FROM regexp_split_to_table(COALESCE(s.metadata->>'industry',''),',') value WHERE btrim(value)<>'' LOOP
    SELECT i.id,i.name INTO STRICT lookup_id,lookup_name FROM public.industry_categories i WHERE lower(btrim(i.name))=lower(lookup_name);
    industry_ids:=array_append(industry_ids,lookup_id); first_industry:=COALESCE(first_industry,lookup_name);
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(s.files) LOOP
    candidate_path:='corrections/'||p.id||'/'||COALESCE(s.correction_request_id,s.id)||'/'||s.id||'/'||(f->>'storageName');
    path:='drafts/'||p.public_id||'/'||(f->>'role')||'/corrections/'||s.id||'/'||(f->>'storageName')||'/'||(f->>'fileName');
    IF NOT EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE NOT b.public AND o.bucket_id=s.storage_bucket AND o.name=candidate_path AND (o.metadata->>'size')::bigint=(f->>'bytes')::bigint AND o.metadata->>'mimetype'=f->>'mimeType') OR
       (f->>'role'<>'workbook' AND NOT EXISTS(SELECT 1 FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE NOT b.public AND o.bucket_id='project-drafts-private' AND o.name=path AND (o.metadata->>'size')::bigint=(f->>'bytes')::bigint AND o.metadata->>'mimetype'=f->>'mimeType'))
    THEN RETURN jsonb_build_object('resultCode','STORAGE_INCOMPLETE'); END IF;
  END LOOP;

  -- Recovery capture and all database changes share this function's subtransaction.
  -- Failure anywhere, including a recovery insert or retirement trigger, rolls everything back.
  INSERT INTO public.participant_correction_prior_revisions(submission_id,project_id,correction_request_id,package_hash,expected_version,accepted_by,project_record,media_records,discipline_records,industry_records,validation_records,captured_at)
  VALUES(s.id,p.id,r.id,s.package_hash,p_expected_version,p_admin_id,to_jsonb(p),
    COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.media_assets m WHERE project_id=p.id),'[]'),
    COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY discipline_id) FROM public.project_disciplines d WHERE project_id=p.id),'[]'),
    COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY industry_category_id) FROM public.project_industry_categories i WHERE project_id=p.id),'[]'),
    COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM public.validation_flags v WHERE project_id=p.id),'[]'),acceptance_time);
  INSERT INTO public.participant_correction_recovery_rows(submission_id,project_id,source_table,original_identity,row_data)
    SELECT s.id,p.id,'media_assets',jsonb_build_object('id',m.id),to_jsonb(m) FROM public.media_assets m WHERE project_id=p.id
    UNION ALL SELECT s.id,p.id,'project_disciplines',jsonb_build_object('project_id',d.project_id,'discipline_id',d.discipline_id),to_jsonb(d) FROM public.project_disciplines d WHERE project_id=p.id
    UNION ALL SELECT s.id,p.id,'project_industry_categories',jsonb_build_object('project_id',i.project_id,'industry_category_id',i.industry_category_id),to_jsonb(i) FROM public.project_industry_categories i WHERE project_id=p.id;

  UPDATE public.projects SET title=s.metadata->>'title',summary=s.metadata->>'summary',background=s.metadata->>'background',solution=s.metadata->>'solution',
    year=(s.metadata->>'year')::integer,program_id=v_program_id,program_name=v_program_name,
    study_program=s.metadata->>'studyProgram',discipline=first_discipline,industry=first_industry,industry_partner=s.metadata->>'industryPartner',
    academic_supervisor=s.metadata->>'academicSupervisor',group_name=s.metadata->>'groupName',participant_contact_email=NULLIF(s.metadata->>'participantContactEmail',''),
    team_members=ARRAY(SELECT jsonb_array_elements_text(s.metadata->'teamMembers')),poster_text_public=s.metadata->>'posterText',accessibility_text_public=s.metadata->>'accessibilityText',
    video_url=NULLIF(s.metadata->>'videoUrl',''),demo_url=NULLIF(s.metadata->>'demoUrl',''),repository_url=NULLIF(s.metadata->>'repositoryUrl',''),layout_config=s.metadata->'layoutConfig',
    package_validation=jsonb_build_object('valid',true,'source',s.source,'submissionId',s.id,'packageHash',s.package_hash,'warnings',s.warnings,'passedRules',s.validation_checks),
    validation_errors='{}',validation_warnings=ARRAY(SELECT jsonb_array_elements_text(s.warnings)),validation_flags_cache=NULL
  WHERE id=p.id;
  -- Rule/field identity comes from server revalidation of this exact package.
  -- Keep historical rows and capture their old disposition before recording a
  -- verified resolution. Unknown/governance rules and still-failing rules remain open.
  FOR old_row IN SELECT to_jsonb(v) FROM public.validation_flags v WHERE v.project_id=p.id AND v.resolved IS NOT TRUE AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(s.validation_checks) c WHERE c->>'ruleCode'=v.rule_code AND c->>'fieldName' IS NOT DISTINCT FROM v.field_name)
  LOOP
    INSERT INTO public.participant_correction_recovery_rows(submission_id,project_id,source_table,original_identity,row_data)
      VALUES(s.id,p.id,'validation_flags',jsonb_build_object('id',old_row->>'id'),old_row);
    UPDATE public.validation_flags v SET resolved=true,resolved_at=acceptance_time,resolved_by=p_admin_id
      WHERE v.id=(old_row->>'id')::uuid AND v.project_id=p.id AND to_jsonb(v)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  INSERT INTO public.project_disciplines(project_id,discipline_id) SELECT p.id,unnest(discipline_ids) ON CONFLICT DO NOTHING;
  INSERT INTO public.project_industry_categories(project_id,industry_category_id) SELECT p.id,unnest(industry_ids) ON CONFLICT DO NOTHING;

  -- Retire only exact, recoverably captured obsolete project mapping rows, never catalogues.
  FOR old_row IN SELECT to_jsonb(d) FROM public.project_disciplines d WHERE project_id=p.id AND NOT (discipline_id=ANY(discipline_ids)) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.participant_correction_recovery_rows rr WHERE rr.submission_id=s.id AND rr.project_id=p.id AND rr.source_table='project_disciplines' AND rr.row_data=old_row) THEN RAISE EXCEPTION 'RECOVERY_REQUIRED'; END IF;
    DELETE FROM public.project_disciplines d WHERE d.project_id=p.id AND d.discipline_id=(old_row->>'discipline_id')::uuid AND to_jsonb(d)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  FOR old_row IN SELECT to_jsonb(i) FROM public.project_industry_categories i WHERE project_id=p.id AND NOT (industry_category_id=ANY(industry_ids)) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.participant_correction_recovery_rows rr WHERE rr.submission_id=s.id AND rr.project_id=p.id AND rr.source_table='project_industry_categories' AND rr.row_data=old_row) THEN RAISE EXCEPTION 'RECOVERY_REQUIRED'; END IF;
    DELETE FROM public.project_industry_categories i WHERE i.project_id=p.id AND i.industry_category_id=(old_row->>'industry_category_id')::uuid AND to_jsonb(i)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  FOR old_row IN SELECT to_jsonb(m) FROM public.media_assets m WHERE project_id=p.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.files) f0 WHERE f0->>'role'=m.asset_type AND (f0->>'position')::integer IS NOT DISTINCT FROM m.gallery_position) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.participant_correction_recovery_rows rr WHERE rr.submission_id=s.id AND rr.project_id=p.id AND rr.source_table='media_assets' AND rr.row_data=old_row) THEN RAISE EXCEPTION 'RECOVERY_REQUIRED'; END IF;
    DELETE FROM public.media_assets m WHERE m.project_id=p.id AND m.id=(old_row->>'id')::uuid AND to_jsonb(m)=old_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(s.files) WHERE value->>'role'<>'workbook' LOOP
    path:='drafts/'||p.public_id||'/'||(f->>'role')||'/corrections/'||s.id||'/'||(f->>'storageName')||'/'||(f->>'fileName');
    UPDATE public.media_assets SET file_name=f->>'fileName',storage_bucket='project-drafts-private',storage_path=path,mime_type=f->>'mimeType',file_size_bytes=(f->>'bytes')::bigint,alt_text_public=f->>'altText'
      WHERE project_id=p.id AND asset_type=f->>'role' AND gallery_position IS NOT DISTINCT FROM (f->>'position')::integer;
    IF NOT FOUND THEN
      INSERT INTO public.media_assets(project_id,asset_type,gallery_position,file_name,storage_bucket,storage_path,mime_type,file_size_bytes,alt_text_public,is_public_approved)
      VALUES(p.id,f->>'role',(f->>'position')::integer,f->>'fileName','project-drafts-private',path,f->>'mimeType',(f->>'bytes')::bigint,f->>'altText',false);
    END IF;
  END LOOP;
  UPDATE public.participant_correction_submissions SET state='accepted',decided_at=acceptance_time,decided_by=p_admin_id WHERE id=s.id;
  INSERT INTO public.participant_correction_events(submission_id,event,staff_actor_id,created_at) VALUES(s.id,'staff_accepted_revision',p_admin_id,acceptance_time);
  RETURN jsonb_build_object('resultCode','SUCCESS','state','accepted','alreadyApplied',false);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('resultCode','UNAVAILABLE');
END; $$;

CREATE FUNCTION public.guard_unresolved_participant_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved' AND EXISTS(
    SELECT 1 FROM public.participant_correction_submissions WHERE project_id=NEW.id AND source='staff_pre_preview' AND state IN ('submitted','frozen'))
  THEN RAISE EXCEPTION 'PROJECT_TEAM_PACKAGE_DECISION_REQUIRED'; END IF;
  IF NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved' AND EXISTS(
    SELECT 1 FROM public.participant_preview_correction_requests r JOIN public.participant_previews pp ON pp.id=r.participant_preview_id
    WHERE pp.project_id=NEW.id AND r.status='in_progress' AND NOT EXISTS(
      SELECT 1 FROM public.participant_correction_submissions s WHERE s.correction_request_id=r.id AND s.frozen_at IS NOT NULL AND s.state IN ('accepted','returned')))
  THEN RAISE EXCEPTION 'PARTICIPANT_CANDIDATE_DECISION_REQUIRED'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER unresolved_participant_candidate_guard BEFORE UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.guard_unresolved_participant_candidate();

REVOKE ALL ON FUNCTION public.reject_correction_audit_change(), public.guard_participant_correction_evidence(), public.guard_unresolved_participant_candidate(), public.participant_correction_project_version(uuid), public.participant_correction_context(text), public.pre_preview_package_context(text,uuid), public.reserve_participant_correction(text,text,jsonb,jsonb,jsonb,text,jsonb,text,uuid), public.complete_participant_correction(text,uuid,text,text,uuid), public.review_participant_correction(text,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.participant_correction_project_version(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.participant_correction_context(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pre_preview_package_context(text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_participant_correction(text,text,jsonb,jsonb,jsonb,text,jsonb,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_participant_correction(text,uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_participant_correction(text,uuid,uuid,text,text,text) TO service_role;
COMMIT;
