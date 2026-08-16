import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('participant preview reminder migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260813190000_participant_preview_reminder_schedules.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const compact = content.replace(/\s+/g, ' ');

  it('is exactly Migration 0024 and preserves all inherited migration bytes', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(27);
    expect(files[23]).toBe(filename);
    for (const inherited of files.slice(0, 23)) {
      const local = fs.readFileSync(path.join(migrations, inherited), 'utf8').replace(/\r\n/g, '\n');
      const base = execFileSync(
        'git', ['show', `origin/main:infra/supabase/migrations/${inherited}`],
        { cwd: root, encoding: 'utf8' },
      ).replace(/\r\n/g, '\n');
      expect(crypto.createHash('sha256').update(local).digest('hex')).toBe(
        crypto.createHash('sha256').update(base).digest('hex'),
      );
    }
  });

  it('creates a durable exact-preview schedule lifecycle without credential fields', () => {
    expect(content).toContain('CREATE TABLE public.participant_preview_reminder_schedules');
    expect(content).toContain('participant_preview_id uuid NOT NULL');
    expect(content).toContain('initial_notification_id uuid NOT NULL');
    expect(content).toContain("status IN ('scheduled', 'triggered', 'skipped', 'cancelled')");
    expect(content).toContain('recipient_email_snapshot text NOT NULL');
    expect(content).not.toMatch(/raw_token|preview_url|email_html|email_text|message_body/i);
  });

  it('preserves one initial notification and permits one reminder notification per schedule', () => {
    expect(compact).toContain("WHERE notification_kind = 'initial'");
    expect(compact).toContain("WHERE notification_kind = 'reminder'");
    expect(content).toContain('participant_preview_notifications_reminder_schedule_fkey');
    expect(content).toContain("notification_kind IN ('initial', 'reminder')");
    expect(content).toContain("notification_kind = 'initial' AND reminder_schedule_id IS NULL");
    expect(content).toContain("notification_kind = 'reminder' AND reminder_schedule_id IS NOT NULL");
  });

  it('uses an indexed bounded SKIP LOCKED queue and atomic schedule-to-notification claim', () => {
    expect(content).toContain('participant_preview_reminder_schedules_due_idx');
    expect(content).toContain("WHERE status = 'scheduled'");
    expect(content).toContain('LIMIT v_limit');
    expect(content).toContain('FOR UPDATE SKIP LOCKED');
    expect(content).toContain('IF v_limit < 1 OR v_limit > 50');
    expect(content).toContain("'reminder', v_candidate.id");
    expect(content).toContain("SET status = 'triggered'");
  });

  it('revalidates all authoritative suppression states at claim and transport boundaries', () => {
    for (const reason of [
      'PREVIEW_CONFIRMED', 'CORRECTION_PENDING', 'PREVIEW_REVOKED', 'PREVIEW_EXPIRED',
      'PREVIEW_SUPERSEDED', 'CONTACT_CHANGED', 'INITIAL_DELIVERY_NOT_CONFIRMED',
    ]) {
      expect(content.split(reason).length).toBeGreaterThan(2);
    }
    expect(content).toContain("'REMINDER_SKIPPED', 'skipReason', v_skip_reason");
  });

  it('keeps privileged mutations service-role-only and browser table access false', () => {
    expect(content).toContain('ALTER TABLE public.participant_preview_reminder_schedules ENABLE ROW LEVEL SECURITY');
    expect(content).toContain('FOR ALL TO authenticated USING (false) WITH CHECK (false)');
    for (const signature of [
      'public.schedule_participant_preview_reminder(text, uuid, timestamptz)',
      'public.cancel_participant_preview_reminder(text, uuid, uuid)',
      'public.claim_due_participant_preview_reminders(integer)',
    ]) {
      expect(compact).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(compact).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
    }
    expect(content).not.toMatch(/EXECUTE\s+FORMAT|\bEXECUTE\s+v_/i);
  });
});
