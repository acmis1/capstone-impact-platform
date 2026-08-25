import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_FILENAMES } from '../scripts/onboardingCheck';

describe('private media approval gate migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migrations = path.join(root, 'infra/supabase/migrations');
  const filename = '20260817090000_private_media_approval_gate.sql';
  const content = fs.readFileSync(path.join(migrations, filename), 'utf8').replace(/\r\n/g, '\n');
  const executable = content.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const functionStart = executable.indexOf('CREATE OR REPLACE FUNCTION public.perform_project_review_action');
  const functionEnd = executable.indexOf('REVOKE ALL ON FUNCTION public.perform_project_review_action');
  const body = executable.slice(functionStart, functionEnd);

  it('is exactly migration 0028 and leaves every origin/main migration byte-identical', () => {
    const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
    expect(files).toEqual([...EXPECTED_MIGRATION_FILENAMES]);
    expect(files).toHaveLength(EXPECTED_MIGRATION_FILENAMES.length);
    expect(files[27]).toBe(filename);

    for (const inherited of files.slice(0, 27)) {
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

  it('keeps the review RPC hardened and service-role only', () => {
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path = ''");
    expect(content).toContain('REVOKE ALL ON FUNCTION public.perform_project_review_action(text, text, text, uuid) FROM PUBLIC, anon, authenticated;');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.perform_project_review_action(text, text, text, uuid) TO service_role;');
  });

  it('derives exact project-bound private media authority inside the approve transaction', () => {
    expect(body).toContain("IF p_action = 'approve' THEN");
    expect(body).toContain('WHERE ma.project_id = v_project_id');
    expect(body).toContain("ma.asset_type = 'poster_image'");
    expect(body).toContain("ma.asset_type = 'poster_pdf'");
    expect(body).toContain("ma.storage_bucket = 'project-drafts-private'");
    expect(body).toContain('ma.is_public_approved = false AND ma.public_url IS NULL');
    expect(body).toContain('ma.public_storage_bucket IS NULL AND ma.public_storage_path IS NULL');
    expect(body).toContain('v_media_count <> 1 OR v_valid_media_count <> 1');
    expect(body).toContain("'PROJECT_MEDIA_REQUIRED'");
    expect(body).toContain("'PROJECT_MEDIA_INVALID'");
    expect(body.indexOf("'PROJECT_MEDIA_REQUIRED'")).toBeLessThan(body.indexOf('UPDATE public.projects'));
    expect(body).not.toMatch(/p_(poster|media|asset).*present/i);
  });

  it('fails closed on malformed media metadata and contradictory optional snapshots', () => {
    expect(body).toContain('ma.file_size_bytes BETWEEN 1 AND 5242880');
    expect(body).toContain('ma.file_size_bytes BETWEEN 1 AND 20971520');
    expect(body).toContain("ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')");
    expect(body).toContain("ma.mime_type = 'application/pdf'");
    expect(body).toContain("ma.asset_type = 'snapshot_image'");
    expect(body).toContain('v_media_count > 0 AND (v_media_count <> 1 OR v_valid_media_count <> 1)');
    expect(body).toContain('FOR UPDATE');
  });

  it('preserves every inherited review behavior and exactly one audit write', () => {
    for (const inherited of [
      'REVIEW_PERMISSION_DENIED', 'REVIEW_TRANSITION_INVALID', 'CONTROLLED_PUBLIC_REMOVAL_REQUIRED',
      'CORRECTION_RESOLUTION_REQUIRED', 'AMBIGUOUS_ACTIVE_PREVIEW',
      'ACCESSIBILITY_CONTENT_REQUIRED', 'ACCESSIBILITY_CONTENT_INVALID',
      'MEDIA_ACCESSIBILITY_REQUIRED', 'MEDIA_ACCESSIBILITY_INVALID',
      "WHEN 'request_changes'", "WHEN 'archive'", "WHEN 'approve'",
    ]) {
      expect(body).toContain(inherited);
    }
    expect(body.match(/INSERT INTO public\.approval_records/g)).toHaveLength(1);
    expect(body).toContain('RETURNING id INTO v_audit_record_id');
  });

  it('does not promote media, populate public URLs, publish, or call an external system', () => {
    expect(body).not.toContain('UPDATE public.media_assets');
    expect(body).not.toContain('project-public-assets');
    expect(body).not.toContain('poster_url =');
    expect(body).not.toContain('poster_pdf_url =');
    expect(body).not.toContain('published_snapshots');
    expect(body).not.toContain('publication_attempts');
    expect(body).not.toContain('http://');
    expect(body).not.toContain('https://');
  });
});
