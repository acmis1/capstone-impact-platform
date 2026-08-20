import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

const PRIVILEGED_FUNCTIONS = [
  'public.reserve_participant_preview_notification(uuid, uuid, text)',
  'public.generate_participant_preview_with_notification( text, uuid, text, integer, text, boolean )',
  'public.begin_participant_preview_notification_transport(uuid, uuid)',
  'public.finalize_participant_preview_notification( uuid, uuid, text, text, text )',
  'public.reconcile_participant_preview_notification(uuid)',
] as const;

/**
 * Field names whose presence would mean the one-time preview credential, the full secure URL or a
 * rendered message body had become recoverable from the database. Their absence is the whole
 * security property of this feature, so it is asserted directly against the migration text.
 */
const FORBIDDEN_LEDGER_CONCEPTS = [
  'preview_token',
  'raw_token',
  'preview_url',
  'invitation_url',
  'access_url',
  'recoverable_preview_secret',
  'email_html',
  'email_text',
  'message_body',
  'smtp_password',
  'provider_secret',
] as const;

describe('participant preview email notification migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260813180000_participant_preview_email_notifications.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8');
  const squashed = content.replace(/\s+/g, ' ');

  it('is the exact twenty-third migration in the authoritative inventory', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(31);
    expect(files[22]).toBe(filename);
  });

  it('leaves migrations 0001-0022 byte-for-byte unchanged', () => {
    // A forward-only migration may redefine a function body, but must never drop or destructively
    // alter what earlier migrations established.
    expect(content).not.toContain('DROP TABLE');
    expect(content).not.toContain('DROP FUNCTION');
    expect(content).not.toContain('DROP INDEX');
    expect(content).not.toMatch(/ALTER TABLE public\.participant_previews/);
    expect(content).not.toMatch(/(CREATE OR REPLACE|DROP|ALTER)\s+FUNCTION[^;]*bootstrap_initial_admin/);
    expect(content).not.toMatch(/(CREATE OR REPLACE|DROP|ALTER)\s+FUNCTION[^;]*\bgenerate_participant_preview\s*\(/);
    expect(content).not.toMatch(/(CREATE OR REPLACE|DROP|ALTER)\s+FUNCTION[^;]*revoke_participant_preview/);
    expect(content).not.toMatch(/(CREATE OR REPLACE|DROP|ALTER)\s+FUNCTION[^;]*confirm_participant_preview/);
  });

  it('adds one nullable, normalized, bounded authoritative contact column', () => {
    expect(squashed).toContain('ALTER TABLE public.projects ADD COLUMN participant_contact_email text');
    expect(squashed).toContain('CONSTRAINT check_projects_participant_contact_email CHECK');
    expect(squashed).toContain('participant_contact_email = lower(btrim(participant_contact_email))');
    expect(squashed).toContain('length(participant_contact_email) BETWEEN 3 AND 254');
    expect(content).not.toMatch(/participant_contact_email text NOT NULL/);
  });

  it('persists the contact email through the canonical import path', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.stage_browser_import_metadata');
    expect(content).toContain("v_pkg->>'participantContactEmail'");
    expect(squashed).toContain('group_name, participant_contact_email, team_members,');
  });

  it('creates the RLS-protected delivery ledger with the exact five lifecycle states', () => {
    expect(content).toContain('CREATE TABLE public.participant_preview_notifications');
    expect(content).toContain(
      'ALTER TABLE public.participant_preview_notifications ENABLE ROW LEVEL SECURITY',
    );
    for (const state of ['reserved', 'transport_started', 'sent', 'failed', 'delivery_unknown']) {
      expect(content).toContain(`'${state}'`);
    }
    expect(content).toContain('CONSTRAINT check_participant_preview_notification_state CHECK');
  });

  it('binds every delivery to the exact preview, not to the project alone', () => {
    expect(squashed).toContain(
      'participant_preview_id uuid NOT NULL REFERENCES public.participant_previews(id) ON DELETE CASCADE',
    );
    expect(squashed).toContain(
      'CREATE UNIQUE INDEX participant_preview_notifications_identity_uidx ON public.participant_preview_notifications( participant_preview_id, recipient_email_snapshot, notification_kind )',
    );
    expect(squashed).toContain(
      'CREATE UNIQUE INDEX participant_preview_notifications_preview_kind_uidx ON public.participant_preview_notifications(participant_preview_id, notification_kind)',
    );
  });

  it('stores only a hash of the execution ownership credential, under a two-minute lease', () => {
    expect(content).toContain('execution_token_hash text NOT NULL');
    expect(content).toContain(
      "extensions.digest(pg_catalog.convert_to(v_execution_token::text, 'UTF8'), 'sha256')",
    );
    expect(content).toContain("lease_expires_at = pg_catalog.now() + interval '2 minutes'");
    expect(content).not.toMatch(/\bexecution_token\s+uuid\s+NOT NULL/);
  });

  it('never gives the ledger a column that could hold a credential, link or message body', () => {
    for (const concept of FORBIDDEN_LEDGER_CONCEPTS) {
      expect(content).not.toContain(concept);
    }
  });

  it('normalizes and validates the authoritative recipient at the database boundary', () => {
    expect(content).toContain("RETURN pg_catalog.jsonb_build_object('resultCode', 'PARTICIPANT_EMAIL_MISSING')");
    expect(content).toContain("RETURN pg_catalog.jsonb_build_object('resultCode', 'PARTICIPANT_EMAIL_INVALID')");
    expect(content).toContain(
      "'^[^@[:space:]]+@[^@[:space:].]+([.][^@[:space:].]+)+$'",
    );
    expect(content).toContain("v_recipient ~ '[[:cntrl:]]'");
  });

  it('validates the recipient before generating a preview so no credential is burned', () => {
    const recipientCheck = content.indexOf("'resultCode', 'PARTICIPANT_EMAIL_MISSING'");
    const generation = content.indexOf('v_generated := public.generate_participant_preview(');
    expect(recipientCheck).toBeGreaterThan(-1);
    expect(generation).toBeGreaterThan(-1);
    expect(recipientCheck).toBeLessThan(generation);
  });

  it('rolls the new preview back if its delivery lifecycle cannot be reserved', () => {
    expect(squashed).toContain(
      "IF v_reserved->>'resultCode' IS DISTINCT FROM 'RESERVED' THEN RAISE EXCEPTION 'PARTICIPANT_PREVIEW_NOTIFICATION_RESERVATION_FAILED'",
    );
  });

  it('refuses to notify a revoked, expired, superseded or already-confirmed preview', () => {
    expect(content).toContain("RETURN pg_catalog.jsonb_build_object('resultCode', 'PREVIEW_NOT_ELIGIBLE')");
    expect(content).toContain("RETURN pg_catalog.jsonb_build_object('resultCode', 'ALREADY_CONFIRMED')");
    expect(content).toContain('public.participant_preview_confirmations c');
  });

  it('never re-grants execution rights for an existing lifecycle, at any lease state', () => {
    // Every existing-lifecycle branch is an observer result. None of them returns an executionToken.
    for (const observed of ['ALREADY_SENT', 'ALREADY_FAILED', 'DELIVERY_UNKNOWN', 'IN_PROGRESS', 'EXPIRED_UNSENT']) {
      expect(content).toContain(`'${observed}'`);
    }
    const existingBranch = content.slice(
      content.indexOf('IF FOUND THEN'),
      content.indexOf('v_execution_token := gen_random_uuid();'),
    );
    expect(existingBranch).not.toContain('executionToken');
  });

  it('settles an abandoned execution truthfully and never as retryable-unsent', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.reconcile_participant_preview_notification');
    expect(squashed).toContain(
      "v_status := CASE WHEN v_row.status = 'reserved' THEN 'failed' ELSE 'delivery_unknown' END",
    );
    expect(content).toContain("'TRANSPORT_NOT_STARTED'");
    // Reconciliation may only act once a lease has genuinely lapsed.
    expect(squashed).toContain(
      "IF v_row.lease_expires_at > pg_catalog.now() THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'IN_PROGRESS'",
    );
  });

  it('makes terminal states immutable so a stale owner can only observe them', () => {
    expect(squashed).toContain(
      "IF v_row.status IN ('sent', 'failed', 'delivery_unknown') THEN RETURN pg_catalog.jsonb_build_object( 'resultCode', 'ALREADY_FINALIZED'",
    );
  });

  it('requires a durably recorded transport boundary before sent or delivery_unknown', () => {
    expect(squashed).toContain(
      "IF (v_outcome IN ('sent', 'delivery_unknown') AND v_row.status <> 'transport_started') OR (v_outcome = 'failed' AND v_row.status NOT IN ('reserved', 'transport_started')) THEN",
    );
  });

  it('keeps the ledger unreachable from every Data API role', () => {
    expect(squashed).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.participant_preview_notifications FROM PUBLIC, anon, authenticated, service_role',
    );
    expect(squashed).toContain(
      'GRANT SELECT ON TABLE public.participant_preview_notifications TO service_role',
    );
    expect(squashed).toContain(
      'CREATE POLICY admin_all_participant_preview_notifications ON public.participant_preview_notifications FOR ALL TO authenticated USING (false) WITH CHECK (false)',
    );
  });

  it.each(PRIVILEGED_FUNCTIONS)('restricts %s to the trusted service role only', (signature) => {
    expect(squashed).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
    expect(squashed).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
  });

  it('hardens every privileged function against search_path and injection tricks', () => {
    const definitions = content.match(/CREATE OR REPLACE FUNCTION public\.\w+[\s\S]*?\$\$;/g) ?? [];
    expect(definitions.length).toBeGreaterThanOrEqual(6);
    for (const definition of definitions) {
      expect(definition).toContain('SECURITY DEFINER');
      expect(definition).toContain("SET search_path = ''");
      expect(definition).not.toContain('EXECUTE format(');
      expect(definition).not.toMatch(/EXECUTE\s+'/);
    }
  });
});
