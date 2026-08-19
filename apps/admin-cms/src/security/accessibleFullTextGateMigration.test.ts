import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('accessible full-text gate migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260814090000_accessible_full_text_gate.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const compact = content.replace(/\s+/g, ' ');
  /** Executable SQL only — the prose comments legitimately discuss what the migration does not do. */
  const executable = content.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const bodyOf = (fn: string) => {
    const start = executable.indexOf(`CREATE OR REPLACE FUNCTION ${fn}`);
    expect(start).toBeGreaterThan(-1);
    const nextStarts = ['public.update_project_metadata', 'public.submit_import_projects_for_review',
      'public.perform_project_review_action', 'public.get_project_publication_readiness']
      .map((other) => executable.indexOf(`CREATE OR REPLACE FUNCTION ${other}`))
      .filter((index) => index > start);
    return executable.slice(start, nextStarts.length > 0 ? Math.min(...nextStarts) : executable.length);
  };

  it('is exactly Migration 0025 and preserves all inherited migration bytes', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(29);
    expect(files[24]).toBe(filename);
    for (const inherited of files.slice(0, 24)) {
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

  it('reuses the existing project columns instead of adding replacements', () => {
    expect(content).toContain('poster_text_public');
    expect(content).toContain('accessibility_text_public');
    expect(content).not.toMatch(/ALTER TABLE public\.projects/i);
    expect(content).not.toMatch(/poster_full_text|poster_alt|alt_description|accessible_text_v2/i);
  });

  it('carries no OCR, AI, or external-provider surface', () => {
    expect(executable).not.toMatch(/ocr|tesseract|vision|gemini|openai|anthropic|textract|embedding|http/i);
  });

  it('forward-redefines exactly the four authoritative workflow functions', () => {
    for (const fn of [
      'public.update_project_metadata',
      'public.submit_import_projects_for_review',
      'public.perform_project_review_action',
      'public.get_project_publication_readiness',
    ]) {
      expect(content).toContain(`CREATE OR REPLACE FUNCTION ${fn}`);
    }
    expect(content.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(4);
  });

  it('keeps every redefined function SECURITY DEFINER with a fixed empty search_path', () => {
    expect(content.match(/SECURITY DEFINER/g)).toHaveLength(4);
    expect(content.match(/SET search_path = ''/g)).toHaveLength(4);
  });

  it('grants execution only to service_role and revokes browser-reachable roles', () => {
    expect(content).not.toMatch(/GRANT EXECUTE ON FUNCTION [^;]*TO (anon|authenticated|PUBLIC)/i);
    expect(content.match(/GRANT EXECUTE ON FUNCTION [^;]*TO service_role/g)).toHaveLength(4);
    for (const signature of [
      'public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid,text,text)',
      'public.submit_import_projects_for_review(uuid, text[], uuid, text)',
      'public.perform_project_review_action(text, text, text, uuid)',
      'public.get_project_publication_readiness(text, uuid, text)',
    ]) {
      expect(content).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
    }
  });

  it('drops the obsolete update_project_metadata signature so no bypass path survives', () => {
    expect(content).toContain(
      'DROP FUNCTION IF EXISTS public.update_project_metadata(text,text,text,text,text,integer,uuid,uuid[],uuid[],timestamptz,uuid);',
    );
    // The DROP must come after the replacement is created and secured, never before.
    expect(content.indexOf('DROP FUNCTION IF EXISTS public.update_project_metadata')).toBeGreaterThan(
      content.indexOf('GRANT EXECUTE ON FUNCTION public.update_project_metadata'),
    );
  });

  it('requires bounded non-blank accessible content in update_project_metadata', () => {
    expect(content).toContain('p_poster_text text');
    expect(content).toContain('p_accessibility_text text');
    expect(compact).toContain("v_poster_text = '' OR pg_catalog.length(v_poster_text) > 20000");
    expect(compact).toContain("v_accessibility_text = '' OR pg_catalog.length(v_accessibility_text) > 2000");
    expect(compact).toContain('poster_text_public = v_poster_text, accessibility_text_public = v_accessibility_text');
  });

  it('preserves every inherited update_project_metadata guard', () => {
    for (const guard of [
      "'PERMISSION_DENIED'",
      "'VALIDATION_FAILED'",
      "'PROJECT_NOT_FOUND'",
      "'APPROVAL_REOPEN_REQUIRED'",
      "'PUBLISHED_PROJECT_LOCKED'",
      "'STALE_VERSION'",
      "'NO_CHANGES'",
    ]) {
      expect(content).toContain(guard);
    }
    expect(content).toContain("role IN ('admin', 'editor')");
    expect(content).toContain('FOR UPDATE');
    expect(content).toContain("'update_metadata'");
    expect(content).toContain('actor_full_name_snapshot, actor_email_snapshot, event_details');
  });

  it('diffs each accessible content field independently for the audit record', () => {
    expect(compact).toContain(
      "IF coalesce(v_old_poster_text, '') IS DISTINCT FROM v_poster_text THEN v_changed_fields := array_append(v_changed_fields, 'posterText');",
    );
    expect(compact).toContain(
      "IF coalesce(v_old_accessibility_text, '') IS DISTINCT FROM v_accessibility_text THEN v_changed_fields := array_append(v_changed_fields, 'accessibilityText');",
    );
    expect(content).toContain("jsonb_set(v_before_state, '{posterText}'");
    expect(content).toContain("jsonb_set(v_after_state, '{posterText}'");
    expect(content).toContain("jsonb_set(v_before_state, '{accessibilityText}'");
    expect(content).toContain("jsonb_set(v_after_state, '{accessibilityText}'");
  });

  it('blocks review submission on either missing accessible content value', () => {
    expect(content).toContain('p.validation_errors, p.poster_text_public, p.accessibility_text_public');
    expect(compact).toContain(
      "IF pg_catalog.btrim(COALESCE(v_project.poster_text_public, '')) = '' THEN v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_POSTER_TEXT');",
    );
    expect(compact).toContain(
      "IF pg_catalog.btrim(COALESCE(v_project.accessibility_text_public, '')) = '' THEN v_blocking_reasons := pg_catalog.array_append(v_blocking_reasons, 'MISSING_ACCESSIBILITY_TEXT');",
    );
    // The blocking reasons are collected in the pre-mutation pass, which returns before the
    // status/audit mutation loop begins.
    const submit = bodyOf('public.submit_import_projects_for_review');
    expect(submit.indexOf("'MISSING_POSTER_TEXT'")).toBeLessThan(submit.indexOf("'READINESS_BLOCKED'"));
    expect(submit.indexOf("'READINESS_BLOCKED'")).toBeLessThan(submit.indexOf('FOREACH v_pid IN ARRAY v_to_submit LOOP'));
  });

  it('preserves every inherited submit_import_projects_for_review readiness condition', () => {
    for (const reason of [
      'MISSING_TITLE', 'MISSING_SUMMARY', 'MISSING_PROGRAM', 'MISSING_STUDY_PROGRAM',
      'MISSING_DISCIPLINE', 'MISSING_GROUP_NAME', 'MISSING_TEAM_MEMBERS',
      'BLOCKING_VALIDATION_ERRORS', 'BLOCKING_VALIDATION_FLAGS',
      'MISSING_DISCIPLINE_MAPPING', 'MISSING_INDUSTRY_MAPPING',
      'MISSING_OR_INCONSISTENT_POSTER_MEDIA', 'MISSING_OR_INCONSISTENT_POSTER_PDF_MEDIA',
    ]) {
      expect(content).toContain(reason);
    }
    expect(content).toContain("'SUBMIT_PERMISSION_DENIED'");
    expect(content).toContain("NOT ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles))");
    expect(content).toContain("v_batch.status <> 'completed'");
    expect(content).toContain('PROJECT_STATE_CHANGED_CONCURRENTLY');
    expect(content).toContain('alreadySubmittedPublicIds');
  });

  it('blocks approval on blank or oversized accessible content before any mutation', () => {
    expect(content).toContain('ACCESSIBILITY_CONTENT_REQUIRED');
    expect(content).toContain('ACCESSIBILITY_CONTENT_INVALID');
    expect(compact).toContain(
      "IF p_action = 'approve' THEN IF pg_catalog.btrim(COALESCE(v_poster_text, '')) = '' OR pg_catalog.btrim(COALESCE(v_accessibility_text, '')) = '' THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_REQUIRED');",
    );
    expect(compact).toContain(
      "IF pg_catalog.length(pg_catalog.btrim(v_poster_text)) > 20000 OR pg_catalog.length(pg_catalog.btrim(v_accessibility_text)) > 2000 THEN RETURN pg_catalog.jsonb_build_object('resultCode', 'ACCESSIBILITY_CONTENT_INVALID');",
    );
    // Re-read from the locked project row, and returned before the status UPDATE and the audit
    // INSERT are ever reached.
    expect(content).toContain('SELECT p.id, p.status, p.poster_text_public, p.accessibility_text_public');
    const reviewAction = bodyOf('public.perform_project_review_action');
    for (const code of ["'ACCESSIBILITY_CONTENT_REQUIRED'", "'ACCESSIBILITY_CONTENT_INVALID'"]) {
      const gate = reviewAction.indexOf(code);
      expect(gate).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(reviewAction.indexOf('v_now := pg_catalog.now();'));
      expect(gate).toBeLessThan(reviewAction.indexOf('UPDATE public.projects SET status = v_to_status'));
      expect(gate).toBeLessThan(reviewAction.indexOf('INSERT INTO public.approval_records'));
    }
  });

  it('blocks review submission and publication readiness on oversized accessible content', () => {
    const submit = bodyOf('public.submit_import_projects_for_review');
    expect(submit).toContain(
      "ELSIF pg_catalog.length(pg_catalog.btrim(v_project.poster_text_public)) > 20000 THEN",
    );
    expect(submit).toContain("'POSTER_TEXT_TOO_LONG'");
    expect(submit).toContain(
      "ELSIF pg_catalog.length(pg_catalog.btrim(v_project.accessibility_text_public)) > 2000 THEN",
    );
    expect(submit).toContain("'ACCESSIBILITY_TEXT_TOO_LONG'");
    expect(submit.indexOf("'POSTER_TEXT_TOO_LONG'")).toBeLessThan(submit.indexOf('FOREACH v_pid IN ARRAY v_to_submit LOOP'));

    const readiness = bodyOf('public.get_project_publication_readiness');
    expect(readiness).toContain('Poster full text exceeds the 20,000 character safety limit');
    expect(readiness).toContain('Accessibility text exceeds the 2,000 character safety limit');
    // Absence and oversize stay distinguishable, so a diagnostic never misreports which is wrong.
    expect(readiness).toContain('Poster full text is missing');
    expect(readiness).toContain('Accessibility text is missing');
  });

  it('never truncates accessible content to make a row pass a gate', () => {
    expect(executable).not.toMatch(/\bleft\s*\(|\bsubstr(ing)?\s*\(|\btruncate\b/i);
  });

  it('leaves request_changes and archive review behaviour untouched', () => {
    expect(content).toContain("'CONTROLLED_PUBLIC_REMOVAL_REQUIRED'");
    expect(content).toContain("'CORRECTION_RESOLUTION_REQUIRED'");
    expect(content).toContain("'AMBIGUOUS_ACTIVE_PREVIEW'");
    expect(content).toContain("pg_catalog.hashtext('participant_preview:' || v_public_id)");
    expect(content).toContain("SET status = 'revoked', revoked_at = pg_catalog.now(), revoked_by = p_admin_id");
    expect(content).toContain('REVIEW_TRANSITION_INVALID');
    expect(content).toContain('pending_removal_from_public = true');
    // Only approve is gated on accessible content.
    expect(content).not.toMatch(/p_action = 'archive'[^;]*ACCESSIBILITY_CONTENT_REQUIRED/);
    expect(content).not.toMatch(/p_action = 'request_changes'[^;]*ACCESSIBILITY_CONTENT_REQUIRED/);
  });

  it('rejects publication readiness independently of any stored preview evidence', () => {
    expect(compact).toContain(
      "IF pg_catalog.btrim(COALESCE(v_project.poster_text_public, '')) = '' THEN v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Poster full text is missing');",
    );
    expect(compact).toContain(
      "IF pg_catalog.btrim(COALESCE(v_project.accessibility_text_public, '')) = '' THEN v_accessibility_blockers := pg_catalog.array_append(v_accessibility_blockers, 'Accessibility text is missing');",
    );
    // The gate is evaluated against the locked project row before the active-preview lookup, so an
    // older preview can never carry a non-compliant project through to READY.
    const readiness = bodyOf('public.get_project_publication_readiness');
    const gate = readiness.indexOf('v_accessibility_blockers := pg_catalog.array_append');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(readiness.indexOf('INTO v_active_preview_count'));
    expect(gate).toBeLessThan(readiness.indexOf("'ready', true"));
  });

  it('preserves every inherited publication readiness rule', () => {
    for (const code of [
      'READINESS_PERMISSION_DENIED', 'INVALID_PRIVATE_BUCKET', 'INVALID_SELECTION', 'PROJECT_NOT_FOUND',
      'CORRECTION_UNRESOLVED', 'INVALID_PROJECT_STATE', 'NO_ACTIVE_PREVIEW', 'READINESS_UNAVAILABLE',
      'CORRECTED_PREVIEW_AWAITING_CONFIRMATION', 'PREVIEW_NOT_CONFIRMED',
      'PROJECT_SNAPSHOT_STALE', 'MEDIA_SNAPSHOT_STALE', 'READY',
    ]) {
      expect(content).toContain(code);
    }
    expect(content).toContain("pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('participant_preview:' || v_public_id))");
    expect(content).toContain('Stored preview state is malformed');
    expect(content).toContain('Stored preview media state is malformed');
    // posterText/accessibilityText stay inside the canonical snapshot, so an accessible-content
    // edit after confirmation still invalidates that confirmation.
    expect(content).toContain("'posterText', p.poster_text_public");
    expect(content).toContain("'accessibilityText', p.accessibility_text_public");
  });
});
