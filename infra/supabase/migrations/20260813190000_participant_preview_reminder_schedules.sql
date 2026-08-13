-- Migration: 20260813190000_participant_preview_reminder_schedules.sql
-- Description: Durable, explicit staff-scheduled reminders for exact participant previews.
-- Future schedules are separate from the short-lived email execution ledger. A trusted runner
-- atomically claims bounded due work, revalidates the exact preview, and only then creates one
-- linked reminder notification. Reminder content never needs or persists a preview token or URL.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Durable reminder schedules
-- ---------------------------------------------------------------------------------------------
CREATE TABLE public.participant_preview_reminder_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Browser-safe opaque reference for cancellation. Internal primary/foreign keys stay server-only.
  staff_reference uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  participant_preview_id uuid NOT NULL
    REFERENCES public.participant_previews(id) ON DELETE CASCADE,
  initial_notification_id uuid NOT NULL
    REFERENCES public.participant_preview_notifications(id) ON DELETE CASCADE,
  recipient_email_snapshot text NOT NULL
    CONSTRAINT check_participant_preview_reminder_recipient CHECK (
      recipient_email_snapshot = pg_catalog.lower(pg_catalog.btrim(recipient_email_snapshot))
      AND pg_catalog.length(recipient_email_snapshot) BETWEEN 3 AND 254
      AND recipient_email_snapshot !~ '[[:cntrl:]]'
    ),
  scheduled_for timestamptz NOT NULL,
  scheduled_by_admin_id uuid NOT NULL REFERENCES public.admin_users(id) ON DELETE NO ACTION,
  status text NOT NULL DEFAULT 'scheduled'
    CONSTRAINT check_participant_preview_reminder_status CHECK (
      status IN ('scheduled', 'triggered', 'skipped', 'cancelled')
    ),
  skip_reason text
    CONSTRAINT check_participant_preview_reminder_skip_reason CHECK (
      skip_reason IS NULL OR skip_reason IN (
        'INITIAL_DELIVERY_NOT_CONFIRMED',
        'PREVIEW_CONFIRMED',
        'CORRECTION_PENDING',
        'PREVIEW_REVOKED',
        'PREVIEW_EXPIRED',
        'PREVIEW_SUPERSEDED',
        'PROJECT_NOT_ELIGIBLE',
        'CONTACT_CHANGED'
      )
    ),
  triggered_at timestamptz,
  skipped_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_admin_id uuid REFERENCES public.admin_users(id) ON DELETE NO ACTION,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT check_participant_preview_reminder_schedule_state CHECK (
    (status = 'scheduled'
      AND skip_reason IS NULL AND triggered_at IS NULL AND skipped_at IS NULL
      AND cancelled_at IS NULL AND cancelled_by_admin_id IS NULL)
    OR (status = 'triggered'
      AND skip_reason IS NULL AND triggered_at IS NOT NULL AND skipped_at IS NULL
      AND cancelled_at IS NULL AND cancelled_by_admin_id IS NULL)
    OR (status = 'skipped'
      AND skip_reason IS NOT NULL AND skipped_at IS NOT NULL
      AND cancelled_at IS NULL AND cancelled_by_admin_id IS NULL)
    OR (status = 'cancelled'
      AND skip_reason IS NULL AND triggered_at IS NULL AND skipped_at IS NULL
      AND cancelled_at IS NOT NULL AND cancelled_by_admin_id IS NOT NULL)
  )
);

-- Repeated submissions of the same exact-preview instant converge at the database boundary.
CREATE UNIQUE INDEX participant_preview_reminder_schedule_semantic_uidx
  ON public.participant_preview_reminder_schedules(participant_preview_id, scheduled_for);

-- Small queue index matching the runner's only claim predicate and deterministic ordering.
CREATE INDEX participant_preview_reminder_schedules_due_idx
  ON public.participant_preview_reminder_schedules(scheduled_for, id)
  WHERE status = 'scheduled';

CREATE INDEX participant_preview_reminder_schedules_project_history_idx
  ON public.participant_preview_reminder_schedules(project_id, created_at DESC, id DESC);

CREATE INDEX participant_preview_reminder_schedules_initial_notification_idx
  ON public.participant_preview_reminder_schedules(initial_notification_id);

CREATE INDEX participant_preview_reminder_schedules_scheduled_by_idx
  ON public.participant_preview_reminder_schedules(scheduled_by_admin_id);

CREATE INDEX participant_preview_reminder_schedules_cancelled_by_idx
  ON public.participant_preview_reminder_schedules(cancelled_by_admin_id)
  WHERE cancelled_by_admin_id IS NOT NULL;

ALTER TABLE public.participant_preview_reminder_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_all_participant_preview_reminder_schedules
  ON public.participant_preview_reminder_schedules
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.participant_preview_reminder_schedules
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.participant_preview_reminder_schedules TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Forward evolution of the existing notification ledger
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.participant_preview_notifications
  DROP CONSTRAINT check_participant_preview_notification_kind;

ALTER TABLE public.participant_preview_notifications
  ADD COLUMN reminder_schedule_id uuid,
  ADD CONSTRAINT participant_preview_notifications_reminder_schedule_fkey
    FOREIGN KEY (reminder_schedule_id)
    REFERENCES public.participant_preview_reminder_schedules(id) ON DELETE CASCADE,
  ADD CONSTRAINT check_participant_preview_notification_kind
    CHECK (notification_kind IN ('initial', 'reminder')),
  ADD CONSTRAINT check_participant_preview_notification_schedule_link CHECK (
    (notification_kind = 'initial' AND reminder_schedule_id IS NULL)
    OR (notification_kind = 'reminder' AND reminder_schedule_id IS NOT NULL)
  );

DROP INDEX public.participant_preview_notifications_identity_uidx;
DROP INDEX public.participant_preview_notifications_preview_kind_uidx;

-- Preserve exactly one initial delivery lifecycle for an exact preview.
CREATE UNIQUE INDEX participant_preview_notifications_initial_preview_uidx
  ON public.participant_preview_notifications(participant_preview_id)
  WHERE notification_kind = 'initial';

-- A triggered schedule can create exactly one reminder delivery lifecycle.
CREATE UNIQUE INDEX participant_preview_notifications_reminder_schedule_uidx
  ON public.participant_preview_notifications(reminder_schedule_id)
  WHERE notification_kind = 'reminder';

-- ---------------------------------------------------------------------------------------------
-- 3. Explicit staff scheduling
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_participant_preview_reminder(
  p_public_id text,
  p_admin_id uuid,
  p_scheduled_for timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_roles text[];
  v_now timestamptz := pg_catalog.now();
  v_project RECORD;
  v_preview RECORD;
  v_initial public.participant_preview_notifications%ROWTYPE;
  v_existing public.participant_preview_reminder_schedules%ROWTYPE;
  v_schedule public.participant_preview_reminder_schedules%ROWTYPE;
  v_current_recipient text;
BEGIN
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100
     OR v_public_id !~ '^[A-Za-z0-9_-]+$'
     OR p_admin_id IS NULL OR p_scheduled_for IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.array_agg(r.role) INTO v_roles
    FROM public.user_roles r WHERE r.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  SELECT p.id, p.status, p.deleted_at, p.participant_contact_email
    INTO v_project
    FROM public.projects p
   WHERE p.public_id = v_public_id
   FOR UPDATE;
  IF NOT FOUND OR v_project.deleted_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  SELECT pp.id, pp.created_at, pp.expires_at, pp.status
    INTO v_preview
    FROM public.participant_previews pp
   WHERE pp.project_id = v_project.id AND pp.status = 'active'
   FOR UPDATE;
  IF NOT FOUND OR v_project.status <> 'approved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_NOT_ELIGIBLE');
  END IF;

  IF p_scheduled_for <= v_now THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SCHEDULE_NOT_FUTURE');
  END IF;
  IF p_scheduled_for >= v_preview.expires_at THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'SCHEDULE_AFTER_EXPIRY');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.participant_preview_confirmations c
     WHERE c.participant_preview_id = v_preview.id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_CONFIRMED');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.participant_preview_correction_requests c
     WHERE c.participant_preview_id = v_preview.id
       AND c.status IN ('open', 'in_progress')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CORRECTION_PENDING');
  END IF;

  SELECT * INTO v_initial
    FROM public.participant_preview_notifications n
   WHERE n.participant_preview_id = v_preview.id
     AND n.notification_kind = 'initial'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INITIAL_NOTIFICATION_REQUIRED');
  END IF;
  IF v_initial.status <> 'sent' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INITIAL_DELIVERY_NOT_CONFIRMED');
  END IF;

  v_current_recipient := pg_catalog.lower(
    pg_catalog.btrim(COALESCE(v_project.participant_contact_email, ''))
  );
  IF v_current_recipient = ''
     OR v_current_recipient IS DISTINCT FROM v_initial.recipient_email_snapshot
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'CONTACT_CHANGED');
  END IF;

  -- The advisory lock makes duplicate convergence deterministic before the unique index backstop.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'capstone.participant_preview_reminder:' || v_preview.id::text || ':' || p_scheduled_for::text,
      0
    )
  );

  SELECT * INTO v_existing
    FROM public.participant_preview_reminder_schedules s
   WHERE s.participant_preview_id = v_preview.id
     AND s.scheduled_for = p_scheduled_for
   FOR UPDATE;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_SCHEDULED',
      'reference', v_existing.staff_reference::text,
      'scheduledFor', pg_catalog.to_jsonb(v_existing.scheduled_for),
      'status', v_existing.status
    );
  END IF;

  INSERT INTO public.participant_preview_reminder_schedules(
    project_id, participant_preview_id, initial_notification_id,
    recipient_email_snapshot, scheduled_for, scheduled_by_admin_id
  ) VALUES (
    v_project.id, v_preview.id, v_initial.id,
    v_initial.recipient_email_snapshot, p_scheduled_for, p_admin_id
  ) RETURNING * INTO v_schedule;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'SCHEDULED',
    'reference', v_schedule.staff_reference::text,
    'scheduledFor', pg_catalog.to_jsonb(v_schedule.scheduled_for),
    'recipient', v_schedule.recipient_email_snapshot,
    'status', v_schedule.status,
    'createdAt', pg_catalog.to_jsonb(v_schedule.created_at)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_participant_preview_reminder(text, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_participant_preview_reminder(text, uuid, timestamptz)
  TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Idempotent staff cancellation
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_participant_preview_reminder(
  p_public_id text,
  p_admin_id uuid,
  p_reference uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_public_id text := pg_catalog.btrim(COALESCE(p_public_id, ''));
  v_roles text[];
  v_project_id uuid;
  v_schedule public.participant_preview_reminder_schedules%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF v_public_id = '' OR pg_catalog.length(v_public_id) > 100
     OR v_public_id !~ '^[A-Za-z0-9_-]+$'
     OR p_admin_id IS NULL OR p_reference IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT pg_catalog.array_agg(r.role) INTO v_roles
    FROM public.user_roles r WHERE r.user_id = p_admin_id;
  IF v_roles IS NULL OR NOT ('admin' = ANY(v_roles) OR 'reviewer' = ANY(v_roles)) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_PERMISSION_DENIED');
  END IF;

  SELECT p.id INTO v_project_id
    FROM public.projects p
   WHERE p.public_id = v_public_id AND p.deleted_at IS NULL;
  IF v_project_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'PROJECT_NOT_FOUND');
  END IF;

  SELECT * INTO v_schedule
    FROM public.participant_preview_reminder_schedules s
   WHERE s.staff_reference = p_reference AND s.project_id = v_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'REMINDER_NOT_FOUND');
  END IF;

  IF v_schedule.status = 'cancelled' THEN
    RETURN pg_catalog.jsonb_build_object(
      'resultCode', 'ALREADY_CANCELLED',
      'reference', v_schedule.staff_reference::text,
      'status', v_schedule.status,
      'cancelledAt', pg_catalog.to_jsonb(v_schedule.cancelled_at)
    );
  END IF;
  IF v_schedule.status <> 'scheduled' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'REMINDER_NOT_CANCELLABLE');
  END IF;

  v_now := pg_catalog.now();
  UPDATE public.participant_preview_reminder_schedules
     SET status = 'cancelled', cancelled_at = v_now, cancelled_by_admin_id = p_admin_id,
         updated_at = v_now
   WHERE id = v_schedule.id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'CANCELLED',
    'reference', v_schedule.staff_reference::text,
    'status', 'cancelled',
    'cancelledAt', pg_catalog.to_jsonb(v_now)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_participant_preview_reminder(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_participant_preview_reminder(text, uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Atomic bounded due-work claim
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_due_participant_preview_reminders(
  p_batch_limit integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_limit integer := COALESCE(p_batch_limit, 20);
  v_now timestamptz := pg_catalog.now();
  v_candidate RECORD;
  v_preview RECORD;
  v_project RECORD;
  v_initial public.participant_preview_notifications%ROWTYPE;
  v_skip_reason text;
  v_execution_token uuid;
  v_notification public.participant_preview_notifications%ROWTYPE;
  v_items jsonb := '[]'::jsonb;
  v_claimed integer := 0;
  v_skipped integer := 0;
BEGIN
  IF v_limit < 1 OR v_limit > 50 THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  FOR v_candidate IN
    SELECT s.*
      FROM public.participant_preview_reminder_schedules s
     WHERE s.status = 'scheduled' AND s.scheduled_for <= v_now
     ORDER BY s.scheduled_for ASC, s.id ASC
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    v_skip_reason := NULL;

    SELECT pp.id, pp.project_id, pp.status, pp.expires_at
      INTO v_preview
      FROM public.participant_previews pp
     WHERE pp.id = v_candidate.participant_preview_id
     FOR UPDATE;

    SELECT p.id, p.status, p.deleted_at, p.title, p.participant_contact_email
      INTO v_project
      FROM public.projects p
     WHERE p.id = v_candidate.project_id
     FOR UPDATE;

    SELECT * INTO v_initial
      FROM public.participant_preview_notifications n
     WHERE n.id = v_candidate.initial_notification_id;

    IF v_preview.id IS NULL OR v_project.id IS NULL
       OR v_preview.project_id IS DISTINCT FROM v_candidate.project_id
    THEN
      v_skip_reason := 'PREVIEW_REVOKED';
    ELSIF EXISTS (
      SELECT 1 FROM public.participant_preview_confirmations c
       WHERE c.participant_preview_id = v_candidate.participant_preview_id
    ) THEN
      v_skip_reason := 'PREVIEW_CONFIRMED';
    ELSIF EXISTS (
      SELECT 1 FROM public.participant_preview_correction_requests c
       WHERE c.participant_preview_id = v_candidate.participant_preview_id
         AND c.status IN ('open', 'in_progress')
    ) THEN
      v_skip_reason := 'CORRECTION_PENDING';
    ELSIF v_preview.status <> 'active' THEN
      v_skip_reason := CASE WHEN EXISTS (
        SELECT 1 FROM public.participant_previews current_preview
         WHERE current_preview.project_id = v_candidate.project_id
           AND current_preview.status = 'active'
           AND current_preview.id <> v_candidate.participant_preview_id
      ) THEN 'PREVIEW_SUPERSEDED' ELSE 'PREVIEW_REVOKED' END;
    ELSIF v_preview.expires_at <= v_now THEN
      v_skip_reason := 'PREVIEW_EXPIRED';
    ELSIF v_project.deleted_at IS NOT NULL OR v_project.status <> 'approved' THEN
      v_skip_reason := 'PROJECT_NOT_ELIGIBLE';
    ELSIF v_initial.id IS NULL
       OR v_initial.participant_preview_id IS DISTINCT FROM v_candidate.participant_preview_id
       OR v_initial.notification_kind <> 'initial'
       OR v_initial.status <> 'sent'
       OR v_initial.recipient_email_snapshot IS DISTINCT FROM v_candidate.recipient_email_snapshot
    THEN
      v_skip_reason := 'INITIAL_DELIVERY_NOT_CONFIRMED';
    ELSIF pg_catalog.lower(
      pg_catalog.btrim(COALESCE(v_project.participant_contact_email, ''))
    ) IS DISTINCT FROM v_candidate.recipient_email_snapshot THEN
      v_skip_reason := 'CONTACT_CHANGED';
    END IF;

    IF v_skip_reason IS NOT NULL THEN
      UPDATE public.participant_preview_reminder_schedules
         SET status = 'skipped', skip_reason = v_skip_reason, skipped_at = v_now,
             updated_at = v_now
       WHERE id = v_candidate.id;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_execution_token := gen_random_uuid();
    INSERT INTO public.participant_preview_notifications(
      project_id, participant_preview_id, notification_kind, reminder_schedule_id,
      recipient_email_snapshot, requested_by_admin_id, status,
      execution_token_hash, lease_expires_at
    ) VALUES (
      v_candidate.project_id, v_candidate.participant_preview_id, 'reminder', v_candidate.id,
      v_candidate.recipient_email_snapshot, v_candidate.scheduled_by_admin_id, 'reserved',
      pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(v_execution_token::text, 'UTF8'), 'sha256'), 'hex'
      ),
      v_now + interval '2 minutes'
    ) RETURNING * INTO v_notification;

    UPDATE public.participant_preview_reminder_schedules
       SET status = 'triggered', triggered_at = v_now, updated_at = v_now
     WHERE id = v_candidate.id;

    v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'notificationId', v_notification.id::text,
      'executionToken', v_execution_token::text,
      'recipient', v_candidate.recipient_email_snapshot,
      'projectTitle', COALESCE(v_project.title, ''),
      'expiresAt', pg_catalog.to_jsonb(v_preview.expires_at)
    ));
    v_claimed := v_claimed + 1;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'CLAIMED',
    'claimedCount', v_claimed,
    'skippedCount', v_skipped,
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_due_participant_preview_reminders(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_participant_preview_reminders(integer)
  TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Revalidate reminder eligibility at the durable SMTP boundary
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_participant_preview_notification_transport(
  p_notification_id uuid,
  p_execution_token uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.participant_preview_notifications%ROWTYPE;
  v_preview RECORD;
  v_project RECORD;
  v_schedule public.participant_preview_reminder_schedules%ROWTYPE;
  v_initial public.participant_preview_notifications%ROWTYPE;
  v_skip_reason text;
  v_now timestamptz := pg_catalog.now();
BEGIN
  IF p_notification_id IS NULL OR p_execution_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'VALIDATION_FAILED');
  END IF;

  SELECT * INTO v_row FROM public.participant_preview_notifications
   WHERE id = p_notification_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'NOTIFICATION_NOT_FOUND');
  END IF;

  IF v_row.execution_token_hash IS DISTINCT FROM pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_execution_token::text, 'UTF8'), 'sha256'), 'hex'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_TOKEN_MISMATCH');
  END IF;
  IF v_row.lease_expires_at <= v_now THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'EXECUTION_LEASE_EXPIRED');
  END IF;
  IF v_row.status <> 'reserved' THEN
    RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE', 'status', v_row.status);
  END IF;

  SELECT pp.id, pp.project_id, pp.status, pp.expires_at
    INTO v_preview
    FROM public.participant_previews pp
   WHERE pp.id = v_row.participant_preview_id
   FOR UPDATE;

  SELECT p.id, p.status, p.deleted_at, p.participant_contact_email
    INTO v_project
    FROM public.projects p
   WHERE p.id = v_row.project_id
   FOR UPDATE;

  IF v_row.notification_kind = 'initial' THEN
    IF v_preview.id IS NULL OR v_project.id IS NULL
       OR v_preview.project_id IS DISTINCT FROM v_row.project_id
       OR v_preview.status <> 'active' OR v_preview.expires_at <= v_now
    THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_NOT_ELIGIBLE');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.participant_preview_confirmations c
       WHERE c.participant_preview_id = v_preview.id
    ) THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_CONFIRMED');
    END IF;
  ELSE
    SELECT * INTO v_schedule
      FROM public.participant_preview_reminder_schedules s
     WHERE s.id = v_row.reminder_schedule_id
     FOR UPDATE;

    IF v_schedule.id IS NULL OR v_schedule.status <> 'triggered' THEN
      RETURN pg_catalog.jsonb_build_object('resultCode', 'INVALID_STATE');
    END IF;

    SELECT * INTO v_initial
      FROM public.participant_preview_notifications n
     WHERE n.id = v_schedule.initial_notification_id;

    IF v_preview.id IS NULL OR v_project.id IS NULL
       OR v_preview.project_id IS DISTINCT FROM v_row.project_id
    THEN
      v_skip_reason := 'PREVIEW_REVOKED';
    ELSIF EXISTS (
      SELECT 1 FROM public.participant_preview_confirmations c
       WHERE c.participant_preview_id = v_preview.id
    ) THEN
      v_skip_reason := 'PREVIEW_CONFIRMED';
    ELSIF EXISTS (
      SELECT 1 FROM public.participant_preview_correction_requests c
       WHERE c.participant_preview_id = v_preview.id
         AND c.status IN ('open', 'in_progress')
    ) THEN
      v_skip_reason := 'CORRECTION_PENDING';
    ELSIF v_preview.status <> 'active' THEN
      v_skip_reason := CASE WHEN EXISTS (
        SELECT 1 FROM public.participant_previews current_preview
         WHERE current_preview.project_id = v_row.project_id
           AND current_preview.status = 'active'
           AND current_preview.id <> v_preview.id
      ) THEN 'PREVIEW_SUPERSEDED' ELSE 'PREVIEW_REVOKED' END;
    ELSIF v_preview.expires_at <= v_now THEN
      v_skip_reason := 'PREVIEW_EXPIRED';
    ELSIF v_project.deleted_at IS NOT NULL OR v_project.status <> 'approved' THEN
      v_skip_reason := 'PROJECT_NOT_ELIGIBLE';
    ELSIF v_initial.id IS NULL OR v_initial.status <> 'sent'
       OR v_initial.notification_kind <> 'initial'
       OR v_initial.participant_preview_id IS DISTINCT FROM v_preview.id
       OR v_initial.recipient_email_snapshot IS DISTINCT FROM v_row.recipient_email_snapshot
    THEN
      v_skip_reason := 'INITIAL_DELIVERY_NOT_CONFIRMED';
    ELSIF pg_catalog.lower(
      pg_catalog.btrim(COALESCE(v_project.participant_contact_email, ''))
    ) IS DISTINCT FROM v_row.recipient_email_snapshot THEN
      v_skip_reason := 'CONTACT_CHANGED';
    END IF;

    IF v_skip_reason IS NOT NULL THEN
      UPDATE public.participant_preview_reminder_schedules
         SET status = 'skipped', skip_reason = v_skip_reason, skipped_at = v_now,
             updated_at = v_now
       WHERE id = v_schedule.id;
      RETURN pg_catalog.jsonb_build_object(
        'resultCode', 'REMINDER_SKIPPED', 'skipReason', v_skip_reason
      );
    END IF;
  END IF;

  UPDATE public.participant_preview_notifications
     SET status = 'transport_started', transport_started_at = v_now,
         updated_at = v_now, lease_expires_at = v_now + interval '2 minutes'
   WHERE id = p_notification_id;

  RETURN pg_catalog.jsonb_build_object(
    'resultCode', 'TRANSPORT_AUTHORIZED',
    'notificationId', v_row.id::text,
    'recipient', v_row.recipient_email_snapshot,
    'status', 'transport_started'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_participant_preview_notification_transport(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_participant_preview_notification_transport(uuid, uuid)
  TO service_role;

COMMIT;
