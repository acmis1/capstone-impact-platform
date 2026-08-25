-- Issue #186: freeze referenced participant-evidence taxonomy during active public-feed work.

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_active_public_feed_taxonomy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_referenced_by_active_operation boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'disciplines' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.project_disciplines pd
      JOIN public.public_feed_operations o ON o.project_id = pd.project_id
      WHERE pd.discipline_id = OLD.id
        AND o.state IN (
          'RESERVED', 'PREPARED', 'WRITE_STARTED',
          'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED'
        )
    ) INTO v_referenced_by_active_operation;
  ELSIF TG_TABLE_NAME = 'industry_categories' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.project_industry_categories pic
      JOIN public.public_feed_operations o ON o.project_id = pic.project_id
      WHERE pic.industry_category_id = OLD.id
        AND o.state IN (
          'RESERVED', 'PREPARED', 'WRITE_STARTED',
          'CANDIDATE_OBSERVED', 'DB_FINALIZED', 'RECOVERY_REQUIRED'
        )
    ) INTO v_referenced_by_active_operation;
  END IF;

  IF v_referenced_by_active_operation THEN
    RAISE EXCEPTION 'PUBLIC_FEED_OPERATION_IN_PROGRESS';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_discipline_lookup_during_public_feed_operation
  BEFORE UPDATE OR DELETE ON public.disciplines
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_taxonomy();

CREATE TRIGGER guard_industry_category_lookup_during_public_feed_operation
  BEFORE UPDATE OR DELETE ON public.industry_categories
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_public_feed_taxonomy();

REVOKE ALL ON FUNCTION public.guard_active_public_feed_taxonomy()
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
