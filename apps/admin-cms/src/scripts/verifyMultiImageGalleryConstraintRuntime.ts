import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Local runtime verification for the media_assets gallery-position invariant
 * (Migration 0034).
 *
 * Proves, against the real migrated database rather than a mock, that a
 * snapshot_image can never persist without an authoritative gallery position.
 *
 * A PostgreSQL CHECK constraint rejects only FALSE; it accepts both TRUE and
 * NULL. The original constraint tested `gallery_position BETWEEN 1 AND 10`,
 * which evaluates to NULL when the column is NULL, so the whole expression
 * evaluated to NULL and the row was ACCEPTED. A snapshot could therefore be
 * stored with no gallery identity, and the contradiction only surfaced later at
 * review, preview, publication readiness or feed compilation. These scenarios
 * pin that hole shut at the schema boundary.
 *
 * Synthetic data only. Performs no publication, no email send, no public-feed
 * or Duda write, and no hosted Supabase access. Every row it creates is owned by
 * a per-run prefix and removed in the finally block.
 */

const LOCAL_DB_CONTAINER = 'supabase_db_capstone-impact-platform';
const PRIVATE_BUCKET = 'project-drafts-private';
const CHECK_CONSTRAINT = 'media_assets_gallery_position_check';
const GALLERY_POSITION_UNIQUE_INDEX = 'media_assets_project_gallery_position_unique';

type InsertOutcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; constraint: string; detail: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runLocalSql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', LOCAL_DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}

function executeLocalSql(sql: string): string {
  try {
    return runLocalSql(sql);
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: Buffer | string }).stderr ?? '')
      : '';
    throw new Error(`Gallery constraint runtime query failed: ${detail}`);
  }
}

/**
 * Attempts one media_assets insert and reports whether the database accepted it,
 * naming the constraint that rejected it. The constraint name matters: it is the
 * difference between the CHECK invariant and the gallery-position uniqueness
 * rule, and a scenario that passed for the wrong reason would be worthless.
 */
function attemptMediaInsert(params: {
  projectPublicId: string;
  assetType: string;
  galleryPosition: number | null;
  tag: string;
}): InsertOutcome {
  const { projectPublicId, assetType, galleryPosition, tag } = params;
  const position = galleryPosition === null ? 'NULL' : String(galleryPosition);

  const sql = `
    INSERT INTO public.media_assets (
      project_id, asset_type, gallery_position, file_name,
      storage_bucket, storage_path, mime_type, file_size_bytes, is_public_approved
    )
    SELECT
      p.id, ${sqlText(assetType)}, ${position}, ${sqlText(`${tag}.png`)},
      ${sqlText(PRIVATE_BUCKET)}, ${sqlText(`drafts/${projectPublicId}/${tag}`)},
      'image/png', 1024, false
    FROM public.projects AS p
    WHERE p.public_id = ${sqlText(projectPublicId)};
  `;

  try {
    runLocalSql(sql);
    return { kind: 'accepted' };
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: Buffer | string }).stderr ?? '')
      : String(error);

    const constraint = detail.includes(CHECK_CONSTRAINT)
      ? CHECK_CONSTRAINT
      : detail.includes(GALLERY_POSITION_UNIQUE_INDEX)
        ? GALLERY_POSITION_UNIQUE_INDEX
        : 'unknown';

    return { kind: 'rejected', constraint, detail: detail.trim().split('\n')[0] ?? '' };
  }
}

function main(): void {
  const runId = randomUUID().slice(0, 8);
  const publicId = `2026-gallery-constraint-${runId}`;
  let passed = 0;

  const scenario = (name: string, check: () => void) => {
    check();
    passed += 1;
    console.log(`PASS: ${name}`);
  };

  const expectRejected = (name: string, outcome: InsertOutcome, constraint: string) => {
    assert(
      outcome.kind === 'rejected',
      `${name}: the database ACCEPTED a row it must reject. This is the invalid state the gallery invariant exists to prevent.`,
    );
    assert(
      outcome.constraint === constraint,
      `${name}: rejected by ${outcome.constraint}, expected ${constraint}. Detail: ${outcome.detail}`,
    );
  };

  const expectAccepted = (name: string, outcome: InsertOutcome) => {
    assert(
      outcome.kind === 'accepted',
      `${name}: the database REJECTED a legitimate row. Detail: ${outcome.kind === 'rejected' ? outcome.detail : ''}`,
    );
  };

  console.log('=== Multi-Image Gallery Position Invariant Local Runtime Verification ===');
  console.log(`Run prefix: ${publicId}\n`);

  try {
    executeLocalSql(`
      INSERT INTO public.projects (
        public_id, title, summary, status, year,
        program_name, discipline, group_name, team_members
      ) VALUES (
        ${sqlText(publicId)}, 'Synthetic Gallery Constraint Project',
        'Disposable fixture for the gallery-position invariant.', 'draft', 2026,
        'Synthetic Software Engineering', 'Software Engineering',
        'Synthetic Gallery Group', ARRAY['Synthetic Member']::text[]
      );
    `);

    const insert = (assetType: string, galleryPosition: number | null, tag: string) =>
      attemptMediaInsert({ projectPublicId: publicId, assetType, galleryPosition, tag });

    // ---------------------------------------------------------------------
    // The defect: a snapshot with no gallery position.
    // ---------------------------------------------------------------------
    scenario('a snapshot with no gallery position is rejected by the database', () => {
      expectRejected(
        'snapshot_image + NULL gallery_position',
        insert('snapshot_image', null, 'null-position'),
        CHECK_CONSTRAINT,
      );
    });

    // ---------------------------------------------------------------------
    // The valid gallery bounds.
    // ---------------------------------------------------------------------
    scenario('a snapshot at the lower gallery bound is accepted', () => {
      expectAccepted('snapshot_image + position 1', insert('snapshot_image', 1, 'position-1'));
    });

    scenario('a snapshot at the upper gallery bound is accepted', () => {
      expectAccepted('snapshot_image + position 10', insert('snapshot_image', 10, 'position-10'));
    });

    scenario('a snapshot below the gallery bound is rejected', () => {
      expectRejected('snapshot_image + position 0', insert('snapshot_image', 0, 'position-0'), CHECK_CONSTRAINT);
    });

    scenario('a snapshot above the gallery bound is rejected', () => {
      expectRejected('snapshot_image + position 11', insert('snapshot_image', 11, 'position-11'), CHECK_CONSTRAINT);
    });

    // ---------------------------------------------------------------------
    // Fixed single-role media keep no gallery position.
    // ---------------------------------------------------------------------
    scenario('a poster image with no gallery position is accepted', () => {
      expectAccepted('poster_image + NULL gallery_position', insert('poster_image', null, 'poster-image'));
    });

    scenario('a poster PDF with no gallery position is accepted', () => {
      expectAccepted('poster_pdf + NULL gallery_position', insert('poster_pdf', null, 'poster-pdf'));
    });

    scenario('a non-snapshot asset carrying a gallery position is rejected', () => {
      expectRejected('poster_image + position 1', insert('poster_image', 1, 'poster-positioned'), CHECK_CONSTRAINT);
    });

    // ---------------------------------------------------------------------
    // Gallery position is an identity, not a label.
    // ---------------------------------------------------------------------
    scenario('two snapshots cannot share a gallery position within one project', () => {
      expectRejected(
        'duplicate snapshot_image position 1',
        insert('snapshot_image', 1, 'duplicate-position-1'),
        GALLERY_POSITION_UNIQUE_INDEX,
      );
    });

    // ---------------------------------------------------------------------
    // Only the two legitimate snapshots survived.
    // ---------------------------------------------------------------------
    scenario('exactly the accepted rows persisted, each with a gallery identity', () => {
      const stored = executeLocalSql(`
        SELECT pg_catalog.string_agg(
                 ma.asset_type || ':' || COALESCE(ma.gallery_position::text, 'null'),
                 ',' ORDER BY ma.asset_type, ma.gallery_position
               )
        FROM public.media_assets AS ma
        JOIN public.projects AS p ON p.id = ma.project_id
        WHERE p.public_id = ${sqlText(publicId)};
      `).trim();

      assert(
        stored === 'poster_image:null,poster_pdf:null,snapshot_image:1,snapshot_image:10',
        `Stored media did not match the accepted set. Got: ${stored}`,
      );

      const orphanSnapshots = executeLocalSql(`
        SELECT pg_catalog.count(*)
        FROM public.media_assets AS ma
        WHERE ma.asset_type = 'snapshot_image' AND ma.gallery_position IS NULL;
      `).trim();

      assert(
        orphanSnapshots === '0',
        `Found ${orphanSnapshots} snapshot row(s) with no gallery position anywhere in the database.`,
      );
    });

    // ---------------------------------------------------------------------
    // The constraint itself, as installed.
    // ---------------------------------------------------------------------
    scenario('the installed constraint requires a non-null snapshot position', () => {
      const definition = executeLocalSql(`
        SELECT pg_catalog.pg_get_constraintdef(c.oid)
        FROM pg_catalog.pg_constraint AS c
        WHERE c.conname = ${sqlText(CHECK_CONSTRAINT)};
      `).trim();

      assert(definition.length > 0, `${CHECK_CONSTRAINT} is not installed.`);
      assert(
        definition.includes('gallery_position IS NOT NULL'),
        `${CHECK_CONSTRAINT} does not require a non-null snapshot position: ${definition}`,
      );
    });

    console.log(`\nALL ${passed} SCENARIOS PASSED for the multi-image gallery position invariant.`);
  } finally {
    try {
      executeLocalSql(`DELETE FROM public.projects WHERE public_id = ${sqlText(publicId)};`);
      console.log('Disposable gallery constraint fixtures removed.');
    } catch (cleanupError) {
      console.error(`Cleanup failed for ${publicId}: ${String(cleanupError)}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
