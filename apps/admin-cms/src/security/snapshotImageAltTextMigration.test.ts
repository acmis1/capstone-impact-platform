import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('snapshot image alt text migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260814140000_snapshot_image_alt_text.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  /** Executable SQL only — the prose comments legitimately discuss what the migration does not do. */
  const executable = content.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const REDEFINED = [
    'public.finalize_browser_import_media_stage',
    'public.update_snapshot_image_alt_text',
    'public.submit_import_projects_for_review',
    'public.perform_project_review_action',
    'public.generate_participant_preview',
    'public.get_project_publication_readiness',
  ];
  const bodyOf = (fn: string) => {
    const start = executable.indexOf(`CREATE OR REPLACE FUNCTION ${fn}`);
    expect(start).toBeGreaterThan(-1);
    const nextStarts = REDEFINED
      .map((other) => executable.indexOf(`CREATE OR REPLACE FUNCTION ${other}`))
      .filter((index) => index > start);
    return executable.slice(start, nextStarts.length > 0 ? Math.min(...nextStarts) : executable.length);
  };

  it('is exactly Migration 0026 and preserves all inherited migration bytes', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(30);
    expect(files[25]).toBe(filename);
    for (const inherited of files.slice(0, 25)) {
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

  it('adds a nullable bounded media-level column rather than a project column', () => {
    expect(content).toContain('ALTER TABLE public.media_assets');
    expect(content).toContain('ADD COLUMN IF NOT EXISTS alt_text_public TEXT');
    // The poster's text alternative stays project-level; nothing is added to public.projects.
    expect(executable).not.toContain('ALTER TABLE public.projects');
  });

  it('permits NULL but never a blank, untrimmed, or oversized stored value', () => {
    expect(content).toContain('ADD CONSTRAINT check_media_asset_alt_text_public CHECK (');
    expect(content).toContain('alt_text_public IS NULL');
    expect(content).toContain('alt_text_public = pg_catalog.btrim(alt_text_public)');
    expect(content).toContain('alt_text_public <> \'\'');
    expect(content).toContain('pg_catalog.length(alt_text_public) <= 2000');
  });

  it('enforces exact canonical trimmed storage semantics on non-null values', () => {
    const isConstraintSatisfied = (val: string | null): boolean => {
      if (val === null) return true;
      return val === val.trim() && val !== '' && val.length <= 2000;
    };

    expect(isConstraintSatisfied(null)).toBe(true);
    expect(isConstraintSatisfied('Description')).toBe(true);
    expect(isConstraintSatisfied('')).toBe(false);
    expect(isConstraintSatisfied('   ')).toBe(false);
    expect(isConstraintSatisfied('  Description')).toBe(false);
    expect(isConstraintSatisfied('Description  ')).toBe(false);
    expect(isConstraintSatisfied('a'.repeat(2000))).toBe(true);
    expect(isConstraintSatisfied('a'.repeat(2001))).toBe(false);
  });

  it('never backfills existing rows with fabricated accessibility text', () => {
    // Only the schema section runs at migration time; the single legitimate UPDATE of
    // alt_text_public lives inside the staff mutation RPC and writes a staff-authored value.
    const schemaSection = executable.slice(0, executable.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(schemaSection).not.toMatch(/UPDATE\s+public\.media_assets/i);
    expect(executable).not.toMatch(/alt_text_public\s*=\s*[^;]*\bfile_name\b/i);
    expect(executable).not.toMatch(/alt_text_public\s*=\s*[^;]*\btitle\b/i);
    expect(executable).not.toMatch(/alt_text_public\s*=\s*[^;]*accessibility_text_public/i);
  });

  it('runs every redefined function as a hardened SECURITY DEFINER', () => {
    for (const fn of REDEFINED) {
      const body = bodyOf(fn);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain("SET search_path = ''");
    }
  });

  it('keeps every redefined function service-role only', () => {
    const grants = [
      'public.finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb)',
      'public.update_snapshot_image_alt_text(text, text, timestamptz, uuid)',
      'public.submit_import_projects_for_review(uuid, text[], uuid, text)',
      'public.perform_project_review_action(text, text, text, uuid)',
      'public.generate_participant_preview(text, uuid, text, integer, text, boolean)',
      'public.generate_participant_preview(text, uuid, text, integer, text)',
      'public.get_project_publication_readiness(text, uuid, text)',
    ];
    for (const signature of grants) {
      expect(content).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
      const revoked = content.includes(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`)
        || (
          content.includes(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`)
          && content.includes(`REVOKE EXECUTE ON FUNCTION ${signature} FROM anon;`)
          && content.includes(`REVOKE EXECUTE ON FUNCTION ${signature} FROM authenticated;`)
        );
      expect(revoked).toBe(true);
    }
  });

  it('re-asserts privileges for the legacy 5-argument preview wrapper without redefining it', () => {
    // The wrapper delegates to the 6-argument implementation, so replacing that implementation is
    // what gives it the new gate. Redefining it here would be redundant SQL surface.
    const wrapperDefinitions = executable.match(
      /CREATE OR REPLACE FUNCTION public\.generate_participant_preview\(\s*\n\s*p_public_id text,\s*\n\s*p_admin_id uuid,\s*\n\s*p_token_hash text,\s*\n\s*p_expires_in_seconds integer,\s*\n\s*p_private_bucket text\s*\n\s*\)/g,
    );
    expect(wrapperDefinitions).toBeNull();
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.generate_participant_preview(text, uuid, text, integer, text) TO service_role;');
  });

  it('does not restate the notification generator, which composes the gated preview generator', () => {
    expect(executable).not.toContain('CREATE OR REPLACE FUNCTION public.generate_participant_preview_with_notification');
  });

  it('persists the server-derived alt only for a snapshot image during media staging', () => {
    const body = bodyOf('public.finalize_browser_import_media_stage');
    expect(body).toContain("v_alt_text := NULLIF(pg_catalog.btrim(COALESCE(v_asset->>'snapshotAltText', '')), '');");
    expect(body).toContain("IF v_asset_type <> 'snapshot_image' THEN");
    expect(body).toContain('RAISE EXCEPTION \'INVALID_ASSET_ALT_TEXT\'');
    expect(body).toContain('alt_text_public');
    // Nullable on both sides, so convergence must not be checked with <>.
    expect(body).toContain('v_existing_asset.alt_text_public IS DISTINCT FROM v_alt_text');
  });

  it('gates review submission conditionally on the snapshot image existing', () => {
    const body = bodyOf('public.submit_import_projects_for_review');
    expect(body).toContain("AND ma.asset_type = 'snapshot_image'");
    expect(body).toContain('MISSING_SNAPSHOT_ALT_TEXT');
    expect(body).toContain('SNAPSHOT_ALT_TEXT_TOO_LONG');
    // Inherited blocking reasons must survive untouched.
    for (const inherited of [
      'MISSING_POSTER_TEXT', 'POSTER_TEXT_TOO_LONG', 'MISSING_ACCESSIBILITY_TEXT',
      'ACCESSIBILITY_TEXT_TOO_LONG', 'MISSING_OR_INCONSISTENT_POSTER_MEDIA',
      'MISSING_OR_INCONSISTENT_POSTER_PDF_MEDIA', 'BLOCKING_VALIDATION_FLAGS',
      'MISSING_DISCIPLINE_MAPPING', 'MISSING_INDUSTRY_MAPPING',
    ]) {
      expect(body).toContain(inherited);
    }
    // The gate is evaluated in the pre-mutation pass, so one bad project aborts the whole selection.
    expect(body.indexOf('MISSING_SNAPSHOT_ALT_TEXT')).toBeLessThan(body.indexOf("SET status = 'submitted'"));
  });

  it('gates only approval, leaving request_changes and archive available', () => {
    const body = bodyOf('public.perform_project_review_action');
    expect(body).toContain('MEDIA_ACCESSIBILITY_REQUIRED');
    expect(body).toContain('MEDIA_ACCESSIBILITY_INVALID');
    expect(body.indexOf('MEDIA_ACCESSIBILITY_REQUIRED')).toBeGreaterThan(body.indexOf("IF p_action = 'approve' THEN"));
    // Inherited protections preserved.
    for (const inherited of [
      'CONTROLLED_PUBLIC_REMOVAL_REQUIRED', 'CORRECTION_RESOLUTION_REQUIRED',
      'AMBIGUOUS_ACTIVE_PREVIEW', 'ACCESSIBILITY_CONTENT_REQUIRED', 'ACCESSIBILITY_CONTENT_INVALID',
    ]) {
      expect(body).toContain(inherited);
    }
  });

  it('fails preview generation closed before any preview row is written', () => {
    const body = bodyOf('public.generate_participant_preview');
    expect(body).toContain('MEDIA_ACCESSIBILITY_REQUIRED');
    expect(body.indexOf('MEDIA_ACCESSIBILITY_REQUIRED'))
      .toBeLessThan(body.indexOf('INSERT INTO public.participant_previews'));
    // Inherited preview rules preserved.
    for (const inherited of [
      'ACTIVE_PREVIEW_EXISTS', 'CORRECTION_RESOLUTION_REQUIRED', 'NO_CORRECTION_IN_PROGRESS',
      'AMBIGUOUS_CORRECTION_REQUEST', 'INVALID_TOKEN_HASH', 'PREVIEW_PERMISSION_DENIED',
    ]) {
      expect(body).toContain(inherited);
    }
  });

  it('captures altText in the immutable participant media snapshot', () => {
    const body = bodyOf('public.generate_participant_preview');
    expect(body).toContain("'altText', ma.alt_text_public");
    // The raw token is still never persisted.
    expect(body).not.toContain('p_raw_token');
  });

  it('treats snapshot alt as its own publication precondition and as snapshot evidence', () => {
    const body = bodyOf('public.get_project_publication_readiness');
    // Independent gate: a preview issued while the alt was already missing would otherwise agree
    // with its own stored snapshot and pass.
    expect(body).toContain('Snapshot image alt text is missing');
    expect(body).toContain('Snapshot image alt text exceeds the 2,000 character safety limit');
    // Part of the compared media snapshot, so a post-confirmation edit becomes staleness.
    expect(body).toContain("'altText', ma.alt_text_public");
    expect(body).toContain('MEDIA_SNAPSHOT_STALE');
    // Stored elements must carry altText, with a usable string required for a snapshot image.
    expect(body).toContain("NOT (elem ? 'altText')");
    expect(body).toContain("elem->>'assetType' = 'snapshot_image'");
    // Inherited invariants preserved.
    for (const inherited of [
      'READINESS_PERMISSION_DENIED', 'CORRECTION_UNRESOLVED', 'NO_ACTIVE_PREVIEW',
      'PREVIEW_NOT_CONFIRMED', 'CORRECTED_PREVIEW_AWAITING_CONFIRMATION',
      'PROJECT_SNAPSHOT_STALE', 'READINESS_UNAVAILABLE', 'READY',
    ]) {
      expect(body).toContain(inherited);
    }
  });

  it('gives the staff mutation a coherent, mutation-free failure contract', () => {
    const body = bodyOf('public.update_snapshot_image_alt_text');
    for (const code of [
      'PROJECT_NOT_FOUND', 'VALIDATION_FAILED', 'PERMISSION_DENIED', 'SNAPSHOT_MEDIA_NOT_FOUND',
      'ALT_TEXT_TOO_LONG', 'STALE_VERSION', 'APPROVAL_REOPEN_REQUIRED', 'PUBLISHED_PROJECT_LOCKED',
      'NO_CHANGES', 'SUCCESS',
    ]) {
      expect(body).toContain(code);
    }
    // Admin/Editor authority is rechecked in the database; a reviewer-only identity is denied.
    expect(body).toContain("NOT ('admin' = ANY(v_roles) OR 'editor' = ANY(v_roles))");
    // Project is locked, and the target row must be this project's snapshot image.
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("AND ma.asset_type = 'snapshot_image'");
    // Every failure path precedes the first mutation, so failures write zero audit rows.
    expect(body.indexOf('NO_CHANGES')).toBeLessThan(body.indexOf('UPDATE public.media_assets'));
    expect(body.indexOf('STALE_VERSION')).toBeLessThan(body.indexOf('UPDATE public.media_assets'));
  });

  it('touches the project version and writes exactly one typed audit record on success', () => {
    const body = bodyOf('public.update_snapshot_image_alt_text');
    expect(body).toContain('UPDATE public.projects');
    expect(body).toContain('SET updated_at = pg_catalog.now()');
    expect(body).toContain("'type', 'media_accessibility'");
    expect(body).toContain("'mediaAssetId', v_media_id::text");
    expect(body).toContain("'before', pg_catalog.jsonb_build_object('snapshotAltText', v_old_alt_text)");
    expect(body).toContain("'after', pg_catalog.jsonb_build_object('snapshotAltText', v_alt_text)");
    expect(body).toContain('actor_full_name_snapshot');
    expect(body).toContain('actor_email_snapshot');
    // Exactly one audit insert, under an action the existing constraint and readers already accept.
    expect(body.match(/INSERT INTO public\.approval_records/g)).toHaveLength(1);
    expect(body).toContain("'update_metadata'");
  });

  it('performs no OCR, AI, or external calls', () => {
    // Executable SQL minus the stored column documentation, which legitimately states in prose that
    // the value is never derived from OCR or AI.
    const lowered = executable
      .replace(/COMMENT ON COLUMN[\s\S]*?;/g, '')
      .toLowerCase();
    expect(lowered).not.toContain('ocr');
    expect(lowered).not.toContain('openai');
    expect(lowered).not.toContain('gemini');
    expect(lowered).not.toContain('http://');
    expect(lowered).not.toContain('https://');
    // No outbound-capable extension is reachable from this migration.
    expect(lowered).not.toContain('create extension');
    expect(lowered).not.toContain('pg_net');
    expect(lowered).not.toContain('http_post');
  });
});
