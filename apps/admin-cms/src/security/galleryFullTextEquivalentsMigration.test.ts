import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../..');
const migrationsDirectory = path.join(root, 'infra/supabase/migrations');
const migrationName = '20260911120000_gallery_full_text_equivalents.sql';
const migrationPath = path.join(migrationsDirectory, migrationName);
const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
const migrationFiles = fs.readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort();

const authoritativeDefinitions = {
  finalize_browser_import_media_stage: '20260824050000_multi_image_gallery.sql',
  submit_import_projects_for_review: '20260825025000_multi_image_gallery_review_submission.sql',
  perform_project_review_action: '20260824060000_multi_image_gallery_approval_gate.sql',
  generate_participant_preview: '20260903120000_participant_preview_controlled_links.sql',
  get_project_publication_readiness: '20260903120000_participant_preview_controlled_links.sql',
  get_project_reconciliation_readiness: '20260903120000_participant_preview_controlled_links.sql',
  reserve_participant_correction: '20260903130000_participant_owned_corrections.sql',
  review_participant_correction: '20260903130000_participant_owned_corrections.sql',
} as const;

function definesFunction(sql: string, functionName: string): boolean {
  return new RegExp(`CREATE(?:\\s+OR\\s+REPLACE)?\\s+FUNCTION\\s+public\\.${functionName}\\s*\\(`, 'i').test(sql);
}

function extractFunction(sql: string, functionName: string): string {
  const match = sql.match(new RegExp(
    `CREATE(?:\\s+OR\\s+REPLACE)?\\s+FUNCTION\\s+public\\.${functionName}\\s*\\([\\s\\S]*?^END;\\s*\\$\\$;`,
    'im',
  ));
  if (!match) throw new Error(`Function ${functionName} was not found.`);
  return match[0];
}

describe('Migration 0057 gallery full-text equivalents', () => {
  it('is the sole additive migration after the immutable 0056 history', () => {
    expect(migrationFiles).toHaveLength(57);
    expect(migrationFiles.at(-1)).toBe(migrationName);

    const schemaSection = source.slice(0, source.indexOf('-- 2. finalize_browser_import_media_stage'));
    expect(schemaSection).toContain('ADD COLUMN IF NOT EXISTS image_content_kind text');
    expect(schemaSection).toContain('ADD COLUMN IF NOT EXISTS full_text_public text');
    expect(schemaSection).not.toMatch(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.media_assets\b/i);
    expect(schemaSection).not.toMatch(/\bDEFAULT\s+'ordinary'/i);
  });

  it('enforces every permitted database state without making legacy snapshots invalid', () => {
    const schemaSection = source.slice(0, source.indexOf('-- 2. finalize_browser_import_media_stage'));
    expect(schemaSection).toContain("asset_type <> 'snapshot_image'");
    expect(schemaSection).toContain('(image_content_kind IS NULL AND full_text_public IS NULL)');
    expect(schemaSection).toContain("(image_content_kind = 'ordinary' AND full_text_public IS NULL)");
    expect(schemaSection).toContain("image_content_kind = 'text_bearing'");
    expect(schemaSection).toContain('image_content_kind IS NOT NULL');
    expect(schemaSection).toContain('full_text_public = pg_catalog.btrim(full_text_public)');
    expect(schemaSection).toContain('pg_catalog.length(full_text_public) <= 5000');
  });

  it('forward-defines every RPC from its actual latest pre-0057 provenance', () => {
    for (const [functionName, expectedFile] of Object.entries(authoritativeDefinitions)) {
      const definingFiles = migrationFiles
        .filter((file) => file !== migrationName)
        .filter((file) => definesFunction(
          fs.readFileSync(path.join(migrationsDirectory, file), 'utf8'),
          functionName,
        ));

      expect(definingFiles.at(-1), functionName).toBe(expectedFile);
      expect(definesFunction(source, functionName), functionName).toBe(true);
    }
  });

  it('preserves definer hardening and service-role-only execution', () => {
    const normalizedSource = source
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/,\s*/g, ', ');
    const signatures = [
      'finalize_browser_import_media_stage(uuid, text, text, uuid, jsonb)',
      'submit_import_projects_for_review(uuid, text[], uuid, text)',
      'perform_project_review_action(text, text, text, uuid)',
      'generate_participant_preview(text, uuid, text, integer, text, boolean)',
      'get_project_publication_readiness(text, uuid, text)',
      'get_project_reconciliation_readiness(text, uuid, text)',
      'reserve_participant_correction(text, text, jsonb, jsonb, jsonb, text, jsonb, text, uuid)',
      'review_participant_correction(text, uuid, uuid, text, text, text)',
    ];

    for (const functionName of Object.keys(authoritativeDefinitions)) {
      const definition = extractFunction(source, functionName);
      expect(definition, functionName).toMatch(/SECURITY DEFINER/);
      expect(definition, functionName).toMatch(/SET search_path = ''/);
    }
    for (const signature of signatures) {
      expect(normalizedSource, signature).toContain(
        `GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`,
      );
    }
    expect(source).not.toMatch(/GRANT\s+EXECUTE[\s\S]{0,220}\sTO\s+(?:anon|authenticated)\b/i);
  });

  it('forward-defines the release sentinel from 0056 without changing its invoker posture', () => {
    const sentinelName = 'get_release_capability_sentinel';
    const definingFiles = migrationFiles
      .filter((file) => file !== migrationName)
      .filter((file) => definesFunction(
        fs.readFileSync(path.join(migrationsDirectory, file), 'utf8'),
        sentinelName,
      ));
    const normalizedSource = source.replace(/\s+/g, ' ');

    expect(definingFiles.at(-1)).toBe('20260910120200_assistive_worker_production_identity.sql');
    expect(normalizedSource).toContain(
      'CREATE OR REPLACE FUNCTION public.get_release_capability_sentinel() RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path =',
    );
    expect(normalizedSource).toContain(
      'REVOKE ALL ON FUNCTION public.get_release_capability_sentinel() FROM PUBLIC, anon, authenticated, service_role',
    );
    expect(normalizedSource).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_release_capability_sentinel() TO service_role',
    );
  });

  it('retains the inherited locks, versions, ledgers, operation guards, audit, and recovery evidence', () => {
    for (const marker of [
      'pg_catalog.pg_advisory_xact_lock',
      'FOR UPDATE',
      'browser_import_media_commits',
      'media_intent_hash',
      'approval_records',
      'participant_correction_project_version',
      'participant_correction_prior_revisions',
      'participant_correction_recovery_rows',
      'public_feed_operations',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('jsonb_agg(to_jsonb(m) ORDER BY id) FROM public.media_assets');
  });

  it('binds declaration changes into retry, preview staleness, correction, and recovery authority', () => {
    expect(source).toContain('v_existing_asset.image_content_kind');
    expect(source).toContain('v_existing_asset.full_text_public');
    expect(source).toContain("'contentKind', ma.image_content_kind");
    expect(source).toContain("'fullText', ma.full_text_public");
    expect(source).toContain('v_comparable_snapshot IS DISTINCT FROM v_active_preview.snapshot');
    expect(source).toContain("NOT (f0 ?& ARRAY['contentKind','fullText'])");
    expect(source).toContain("image_content_kind=f->>'contentKind',full_text_public=f->>'fullText'");
  });

  it('returns position-specific gallery accessibility blockers', () => {
    expect(source).toContain("pg_catalog.format('Snapshot image %s content type is missing', ma.gallery_position)");
    expect(source).toContain("pg_catalog.format('Snapshot image %s full text is missing', ma.gallery_position)");
    expect(source).toContain("pg_catalog.format('Snapshot image %s is declared ordinary but carries a full text', ma.gallery_position)");
  });
});
