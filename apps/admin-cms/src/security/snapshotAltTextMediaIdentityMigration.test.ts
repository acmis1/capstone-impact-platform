import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('snapshot alt text media identity migration contract', () => {
  const root = path.resolve(__dirname, '../../../..');
  const migration = path.join(
    root,
    'infra/supabase/migrations/20260824055000_snapshot_alt_text_media_identity.sql',
  );

  const content = fs.readFileSync(migration, 'utf8').replace(/\r\n/g, '\n');
  const executable = content
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('replaces the single-snapshot RPC with an exact-media RPC', () => {
    expect(content).toContain(
      'DROP FUNCTION IF EXISTS\n  public.update_snapshot_image_alt_text(text, text, timestamptz, uuid);',
    );

    expect(executable).toContain(
      'CREATE FUNCTION public.update_snapshot_image_alt_text(',
    );

    expect(executable).toContain('p_media_asset_id uuid');
  });

  it('proves the requested media belongs to the project and is a snapshot', () => {
    expect(executable).toContain('ma.id = p_media_asset_id');
    expect(executable).toContain('ma.project_id = v_project_id');
    expect(executable).toContain("ma.asset_type = 'snapshot_image'");
  });

  it('keeps the new mutation service-role only', () => {
    expect(content).toContain(
      `GRANT EXECUTE ON FUNCTION
  public.update_snapshot_image_alt_text(
    text,
    uuid,
    text,
    timestamptz,
    uuid
  )
TO service_role;`,
    );

    expect(content).toContain(
      `REVOKE ALL ON FUNCTION
  public.update_snapshot_image_alt_text(
    text,
    uuid,
    text,
    timestamptz,
    uuid
  )
FROM PUBLIC, anon, authenticated;`,
    );
  });

  it('preserves optimistic concurrency and workflow locks', () => {
    expect(executable).toContain('STALE_VERSION');
    expect(executable).toContain('APPROVAL_REOPEN_REQUIRED');
    expect(executable).toContain('PUBLISHED_PROJECT_LOCKED');
    expect(executable).toContain('NO_CHANGES');
    expect(executable).toContain('SUCCESS');
  });

  it('records the exact media asset in the audit evidence', () => {
    expect(executable).toContain("'mediaAssetId', v_media_id::text");
    expect(executable).toContain("'type', 'media_accessibility'");
    expect(executable).toContain('INSERT INTO public.approval_records');
  });
});