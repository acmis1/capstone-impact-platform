import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract tests for the coordinator integration corrections applied on top of
 * the multi-image gallery foundation. Each gate must be authoritative across the
 * WHOLE gallery and must fail closed on contradictory media, rather than reading
 * an arbitrary row or filtering an anomalous row away.
 */
describe('multi-image gallery integration contract', () => {
  const root = path.resolve(__dirname, '../../../..');

  const read = (file: string) =>
    fs
      .readFileSync(path.join(root, 'infra/supabase/migrations', file), 'utf8')
      .replace(/\r\n/g, '\n');

  const stripComments = (content: string) =>
    content
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

  const FOUNDATION = '20260824050000_multi_image_gallery.sql';
  const APPROVAL = '20260824060000_multi_image_gallery_approval_gate.sql';
  const REVIEW_SUBMISSION = '20260825025000_multi_image_gallery_review_submission.sql';
  const PREVIEW = '20260824070000_multi_image_gallery_participant_preview.sql';
  const READINESS = '20260824080000_multi_image_gallery_publication_readiness.sql';

  describe('gallery position is a non-null database invariant', () => {
    const executable = stripComments(read(FOUNDATION));

    const constraint = executable
      .slice(executable.indexOf('ADD CONSTRAINT media_assets_gallery_position_check'))
      .split(';')[0];

    it('rejects a snapshot that carries no gallery position', () => {
      // A CHECK constraint only rejects FALSE, not NULL. Without an explicit
      // IS NOT NULL test, `gallery_position BETWEEN 1 AND 10` evaluates to NULL
      // for a snapshot with no position, the whole expression evaluates to NULL,
      // and PostgreSQL ACCEPTS the row. That let a snapshot persist with no
      // authoritative gallery identity.
      expect(constraint).toContain('gallery_position IS NOT NULL');

      const snapshotBranch = constraint.slice(
        constraint.indexOf("asset_type = 'snapshot_image'"),
        constraint.indexOf('OR'),
      );

      expect(snapshotBranch).toContain('gallery_position IS NOT NULL');
      expect(snapshotBranch).toContain('gallery_position BETWEEN 1 AND 10');
    });

    it('keeps every non-snapshot asset position-free', () => {
      const nonSnapshotBranch = constraint.slice(constraint.indexOf('OR'));

      expect(nonSnapshotBranch).toContain("asset_type <> 'snapshot_image'");
      expect(nonSnapshotBranch).toContain('gallery_position IS NULL');
    });

    it('backfills legacy snapshots before enforcing the constraint', () => {
      // Migration 0034 upgrades databases that already hold pre-gallery
      // snapshot_image rows. The backfill must run first, or adding the
      // stricter constraint would fail validation against those rows.
      const backfillAt = executable.indexOf('SET gallery_position = 1');
      const constraintAt = executable.indexOf('ADD CONSTRAINT media_assets_gallery_position_check');

      expect(backfillAt).toBeGreaterThan(-1);
      expect(backfillAt).toBeLessThan(constraintAt);
    });

    it('identifies a snapshot by project and gallery position', () => {
      expect(executable).toContain('media_assets_project_gallery_position_unique');
      expect(executable).toContain('ON public.media_assets (project_id, gallery_position)');
      expect(executable).toContain("WHERE asset_type = 'snapshot_image'");
    });
  });

  describe('approval gate is all-gallery authoritative', () => {
    const executable = stripComments(read(APPROVAL));

    it('declares every variable it references', () => {
      // A leftover single-snapshot block referenced an undeclared v_snapshot,
      // which aborts the migration at install time with
      // `"v_snapshot" is not a known variable`.
      // The migration opens with a transaction `BEGIN;`, so the function's own
      // BEGIN must be located relative to its DECLARE.
      const declareIndex = executable.indexOf('DECLARE');
      const declareBlock = executable.slice(
        declareIndex,
        executable.indexOf('\nBEGIN', declareIndex),
      );

      // Declarations may share a line: `v_a text; v_b text[]; v_c integer;`
      const declared = new Set(
        [...declareBlock.matchAll(/\b(v_[a-z_]+)\s+[a-z]/g)].map((m) => m[1]),
      );
      const referenced = new Set([...executable.matchAll(/\bv_[a-z_]+\b/g)].map((m) => m[0]));

      const undeclared = [...referenced].filter((name) => !declared.has(name));
      expect(undeclared).toEqual([]);
    });

    it('carries no residual single-snapshot selection', () => {
      expect(executable).not.toContain('v_snapshot');
      expect(executable).not.toContain('alt_text_public INTO');
    });

    it('validates the gallery by aggregate rather than by first row', () => {
      expect(executable).toContain('v_valid_media_count <> v_media_count');
      expect(executable).toContain('v_distinct_gallery_positions <> v_media_count');
      expect(executable).toContain('v_media_count > 10');
      expect(executable).toContain('v_missing_snapshot_alt_count > 0');
      expect(executable).toContain('v_invalid_snapshot_alt_count > 0');
    });

    it('keeps a zero-snapshot gallery valid', () => {
      expect(executable).toContain('IF v_media_count > 0 THEN');
    });
  });

  describe('review submission proves gallery structure before mutation', () => {
    const content = read(REVIEW_SUBMISSION);
    const executable = stripComments(content);

    it('reports a structural blocking reason distinct from alt-text reasons', () => {
      expect(executable).toContain("'INVALID_SNAPSHOT_GALLERY_STRUCTURE'");
      expect(executable).toContain("'MISSING_SNAPSHOT_ALT_TEXT'");
      expect(executable).toContain("'SNAPSHOT_ALT_TEXT_TOO_LONG'");
    });

    it('validates staged private media identity for every snapshot', () => {
      expect(executable).toContain("ma.storage_bucket = 'project-drafts-private'");
      expect(executable).toContain("ma.mime_type IN ('image/png', 'image/jpeg', 'image/webp')");
      expect(executable).toContain('ma.file_size_bytes BETWEEN 1 AND 5242880');
      expect(executable).toContain('ma.is_public_approved = false');
      expect(executable).toContain('ma.public_url IS NULL');
      expect(executable).toContain('ma.public_storage_bucket IS NULL');
      expect(executable).toContain('ma.public_storage_path IS NULL');
      expect(executable).toContain('ma.gallery_position BETWEEN 1 AND 10');
    });

    it('bounds the gallery and requires unique positions', () => {
      expect(executable).toContain('v_snapshot_count > 10');
      expect(executable).toContain('v_valid_snapshot_count <> v_snapshot_count');
      expect(executable).toContain('v_distinct_snapshot_positions <> v_snapshot_count');
    });

    it('keeps a zero-snapshot gallery submittable', () => {
      expect(executable).toContain('IF v_snapshot_count > 0');
    });

    it('validates before the status mutation', () => {
      const structuralIndex = executable.indexOf("'INVALID_SNAPSHOT_GALLERY_STRUCTURE'");
      const mutationIndex = executable.indexOf('UPDATE public.projects');
      expect(structuralIndex).toBeGreaterThan(-1);
      expect(mutationIndex).toBeGreaterThan(-1);
      expect(structuralIndex).toBeLessThan(mutationIndex);
    });
  });

  describe('participant preview fails closed on contradictory media', () => {
    const executable = stripComments(read(PREVIEW));

    it('locks every project media row before validating', () => {
      expect(executable).toContain('FROM public.media_assets ma');
      expect(executable).toContain('WHERE ma.project_id = v_project_id');
      expect(executable).toContain('FOR UPDATE;');
    });

    it('fails closed rather than omitting an anomalous row', () => {
      expect(executable).toContain("'PROJECT_MEDIA_INVALID'");
      expect(executable).toContain('v_media_valid_count <> v_media_total_count');
      expect(executable).toContain('v_poster_image_count > 1');
      expect(executable).toContain('v_poster_pdf_count > 1');
      expect(executable).toContain('v_snapshot_total_count > 10');
      expect(executable).toContain('v_snapshot_position_count <> v_snapshot_total_count');
    });

    it('builds the immutable snapshot from the complete validated set', () => {
      // The evidence must not be derived from rows pre-filtered to those that
      // already look private, which is what silently dropped anomalous rows.
      const snapshotQuery = executable.slice(executable.indexOf('INTO v_media_snapshot'));
      const terminator = snapshotQuery.indexOf(';');
      const clause = snapshotQuery.slice(0, terminator);

      expect(clause).toContain('WHERE ma.project_id = v_project_id');
      expect(clause).not.toContain('ma.storage_bucket = v_private_bucket');
      expect(clause).not.toContain('ma.is_public_approved = false');
      expect(clause).not.toContain('ma.public_url IS NULL');
    });

    it('still captures gallery identity and deterministic order', () => {
      expect(executable).toContain("'galleryPosition',");
      expect(executable).toContain("'mediaAssetId',");
      expect(executable).toContain("'altText',");
      expect(executable).toContain('ORDER BY');
    });

    it('preserves the distinct accessibility result code', () => {
      expect(executable).toContain("'MEDIA_ACCESSIBILITY_REQUIRED'");
    });
  });

  describe('publication readiness evaluates the whole current gallery', () => {
    const executable = stripComments(read(READINESS));

    it('carries no unordered single-row snapshot selection', () => {
      expect(executable).not.toContain('v_snapshot_media');
      expect(executable).not.toContain('alt_text_public INTO');
    });

    it('aggregates structure and alt text across every current snapshot', () => {
      expect(executable).toContain('v_snapshot_total_count');
      expect(executable).toContain('v_snapshot_valid_count <> v_snapshot_total_count');
      expect(executable).toContain('v_snapshot_position_count <> v_snapshot_total_count');
      expect(executable).toContain('v_snapshot_missing_alt_count > 0');
      expect(executable).toContain('v_snapshot_long_alt_count > 0');
    });

    it('keeps a zero-snapshot gallery publishable', () => {
      expect(executable).toContain('IF v_snapshot_total_count > 0 THEN');
    });

    it('retains galleryPosition in stored-evidence equality', () => {
      expect(executable).toContain("'galleryPosition'");
      expect(executable).toContain("'MEDIA_SNAPSHOT_STALE'");
    });
  });

  describe('exact migration inventory', () => {
    it('ships exactly the expected number of migrations', () => {
      const files = fs
        .readdirSync(path.join(root, 'infra/supabase/migrations'))
        .filter((name) => name.endsWith('.sql'));

      expect(files).toHaveLength(49);
    });

    it('keeps the six gallery migrations present', () => {
      const files = new Set(
        fs.readdirSync(path.join(root, 'infra/supabase/migrations')),
      );

      for (const migration of [
        '20260824050000_multi_image_gallery.sql',
        '20260824055000_snapshot_alt_text_media_identity.sql',
        APPROVAL,
        PREVIEW,
        READINESS,
        REVIEW_SUBMISSION,
      ]) {
        expect(files.has(migration)).toBe(true);
      }
    });
  });
});
