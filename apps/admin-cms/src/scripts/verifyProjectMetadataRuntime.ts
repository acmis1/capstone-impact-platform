import { execFileSync } from 'node:child_process';

function executeLocalSql(sql: string): void {
  try {
    execFileSync('docker', ['exec', 'supabase_db_capstone-impact-platform', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
  } catch {
    throw new Error('Local metadata runtime query failed.');
  }
}

export function verifyProjectMetadataRuntime(): void {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const successId = `metadata-runtime-${suffix}`;
  const failureId = `metadata-runtime-failure-${suffix}`;
  const fixtureSql = `DO $$
DECLARE p_id uuid; program_id uuid; discipline_id uuid; category_id uuid; before_version timestamptz; result jsonb;
BEGIN
  SELECT id INTO program_id FROM public.programs ORDER BY name LIMIT 1;
  SELECT id INTO discipline_id FROM public.disciplines ORDER BY name LIMIT 1;
  SELECT id INTO category_id FROM public.industry_categories ORDER BY name LIMIT 1;
  INSERT INTO public.projects (public_id, title, summary, year, program_id, program_name, discipline, industry, group_name)
  VALUES ('${successId}', 'Before', 'Before', 2025, program_id, 'legacy', 'legacy', 'legacy', 'unrelated field') RETURNING id, updated_at INTO p_id, before_version;
  INSERT INTO public.project_disciplines (project_id, discipline_id) VALUES (p_id, discipline_id);
  INSERT INTO public.project_industry_categories (project_id, industry_category_id) VALUES (p_id, category_id);
  SELECT public.update_project_metadata('${successId}', 'After', 'After', 'Background', 'Solution', 2026, program_id, ARRAY[discipline_id], ARRAY[category_id], before_version) INTO result;
  IF result->>'resultCode' <> 'SUCCESS' OR (SELECT title FROM public.projects WHERE id = p_id) <> 'After' OR (SELECT group_name FROM public.projects WHERE id = p_id) <> 'unrelated field' OR (SELECT count(*) FROM public.project_disciplines WHERE project_id = p_id) <> 1 OR (SELECT count(*) FROM public.project_industry_categories WHERE project_id = p_id) <> 1 THEN RAISE EXCEPTION 'METADATA_SUCCESS_ASSERTION_FAILED'; END IF;
  SELECT public.update_project_metadata('${successId}', 'Stale', 'Stale', '', '', 2026, program_id, ARRAY[discipline_id], ARRAY[category_id], before_version - interval '1 microsecond') INTO result;
  IF result->>'resultCode' <> 'STALE_VERSION' THEN RAISE EXCEPTION 'METADATA_STALE_ASSERTION_FAILED'; END IF;
  SELECT public.update_project_metadata('${successId}', 'Invalid', 'Invalid', '', '', 2026, '00000000-0000-0000-0000-000000000000', ARRAY[discipline_id], ARRAY[category_id], (SELECT updated_at FROM public.projects WHERE id = p_id)) INTO result;
  IF result->>'resultCode' <> 'VALIDATION_FAILED' OR (SELECT title FROM public.projects WHERE id = p_id) <> 'After' THEN RAISE EXCEPTION 'METADATA_VALIDATION_ASSERTION_FAILED'; END IF;
  INSERT INTO public.projects (public_id, title, summary, year, program_id, program_name, discipline, industry)
  VALUES ('${failureId}', 'Atomic before', 'Atomic before', 2025, program_id, 'legacy', 'legacy', 'legacy') RETURNING id, updated_at INTO p_id, before_version;
  INSERT INTO public.project_disciplines (project_id, discipline_id) VALUES (p_id, discipline_id);
  INSERT INTO public.project_industry_categories (project_id, industry_category_id) VALUES (p_id, category_id);
END $$;`;
  const atomicFailureSql = `DO $$
DECLARE p_id uuid; program_id uuid; discipline_id uuid; category_id uuid; before_version timestamptz;
BEGIN
  SELECT p.id, p.updated_at, p.program_id INTO p_id, before_version, program_id FROM public.projects p WHERE p.public_id = '${failureId}';
  SELECT id INTO discipline_id FROM public.disciplines ORDER BY name LIMIT 1;
  SELECT id INTO category_id FROM public.industry_categories ORDER BY name LIMIT 1;
  BEGIN
    PERFORM public.update_project_metadata('${failureId}', 'Atomic after', 'Atomic after', 'Background', 'Solution', 2026, program_id, ARRAY[discipline_id], ARRAY[category_id], before_version);
    RAISE EXCEPTION 'METADATA_FAILURE_HOOK_DID_NOT_FIRE';
  EXCEPTION WHEN others THEN
    IF SQLERRM <> 'FORCED_METADATA_MAPPING_FAILURE' THEN RAISE; END IF;
  END;
  IF (SELECT title FROM public.projects WHERE id = p_id) <> 'Atomic before' OR (SELECT count(*) FROM public.project_disciplines WHERE project_id = p_id) <> 1 OR (SELECT count(*) FROM public.project_industry_categories WHERE project_id = p_id) <> 1 THEN RAISE EXCEPTION 'METADATA_ATOMIC_ROLLBACK_ASSERTION_FAILED'; END IF;
END $$;`;
  try {
    executeLocalSql(fixtureSql);
    executeLocalSql("CREATE OR REPLACE FUNCTION public.temp_fail_project_metadata_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'FORCED_METADATA_MAPPING_FAILURE'; END; $fn$;");
    executeLocalSql('CREATE TRIGGER temp_fail_project_metadata_insert BEFORE INSERT ON public.project_industry_categories FOR EACH ROW EXECUTE FUNCTION public.temp_fail_project_metadata_insert();');
    executeLocalSql(atomicFailureSql);
    console.log('Project metadata runtime verification passed (success, stale, validation, and forced atomic rollback).');
  } finally {
    try { executeLocalSql('DROP TRIGGER IF EXISTS temp_fail_project_metadata_insert ON public.project_industry_categories; DROP FUNCTION IF EXISTS public.temp_fail_project_metadata_insert();'); } catch { /* cleanup reported by final fixture cleanup */ }
    try { executeLocalSql(`DELETE FROM public.projects WHERE public_id IN ('${successId}', '${failureId}');`); } catch { throw new Error('Project metadata runtime fixture cleanup failed.'); }
  }
}

if (require.main === module) verifyProjectMetadataRuntime();
