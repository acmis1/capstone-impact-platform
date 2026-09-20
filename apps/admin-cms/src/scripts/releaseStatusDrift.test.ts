import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_STATE_DOCUMENTS,
  RELEASE_STATUS_RECORD,
  checkReleaseStatusDrift,
  trackedMigrationInventory,
} from './releaseStatusDrift';

const realRepoRoot = path.resolve(__dirname, '../../../../');
const CURRENT_SHA = '9690ee0faa37fda502a15b4403f1e293f79b519f';
const STALE_SHA = '95fe7ea023f6eba0a0161f636aae05e721c018f2';

let repoRoot: string;

function write(relative: string, content: string) {
  const target = path.join(repoRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function scaffold(migrationCount: number) {
  for (let index = 1; index <= migrationCount; index += 1) {
    write(`infra/supabase/migrations/2026060100${String(index).padStart(4, '0')}_migration_${index}.sql`, '-- synthetic\n');
  }
  write(RELEASE_STATUS_RECORD, `# Status\n\n| Migration inventory (tracked) | **${migrationCount}** files; latest \`2026060100${String(migrationCount).padStart(4, '0')}_migration_${migrationCount}.sql\` |\n| Backend | \`${CURRENT_SHA}\` |\n`);
  for (const relative of CURRENT_STATE_DOCUMENTS) write(relative, '# Current document\n\nNothing stale here.\n');
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-status-drift-'));
  scaffold(5);
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('release status drift check', () => {
  it('passes when the record matches the tracked inventory and no document presents stale state as current', () => {
    expect(trackedMigrationInventory(repoRoot)).toEqual({ count: 5, latest: '20260601000005_migration_5.sql' });
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
  });

  it('fails when the record count or latest migration drifts from the directory', () => {
    write('infra/supabase/migrations/20260601000006_migration_6.sql', '-- new forward migration\n');
    const failures = checkReleaseStatusDrift(repoRoot);
    expect(failures).toContain(`${RELEASE_STATUS_RECORD}: States 5 migrations but infra/supabase/migrations/ contains 6`);
    expect(failures).toContain(`${RELEASE_STATUS_RECORD}: States latest migration 20260601000005_migration_5.sql but the tracked latest is 20260601000006_migration_6.sql`);
  });

  it('fails when the record is missing or lacks the inventory statement', () => {
    fs.rmSync(path.join(repoRoot, RELEASE_STATUS_RECORD));
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([`Missing release/closure status record: ${RELEASE_STATUS_RECORD}`]);
    write(RELEASE_STATUS_RECORD, '# Status without inventory\n');
    expect(checkReleaseStatusDrift(repoRoot)[0]).toMatch(/Missing the tracked inventory statement/);
  });

  it('rejects another migration count presented as current, but allows explicitly dated history', () => {
    write('README.md', 'The repository contains 4 timestamped migrations.\nMigrations 0001-0004 retain their historical bytes.\n');
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
    write('README.md', 'The repository contains 58 timestamped migrations.\n');
    expect(checkReleaseStatusDrift(repoRoot)[0]).toMatch(/^README\.md:1: Presents 58 migrations as current; the tracked inventory has 5/);
    write('README.md', 'The earlier 58-migration observation is dated history.\nThe prior capture recorded 57 migrations.\nOn 15 September 2026 staging had 58 migrations.\n');
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
    write('README.md', 'Current main has 58 append-only migrations; migrations retain their historical bytes.\n');
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
    write('README.md', 'Local reset replays all 58 repository migrations.\n');
    expect(checkReleaseStatusDrift(repoRoot)).toHaveLength(1);
    write('infra/supabase/README.md', '## Selected Migration Inventory (58 Migrations Total)\n');
    expect(checkReleaseStatusDrift(repoRoot).some((failure) => failure.startsWith('infra/supabase/README.md:1: Presents 58 migrations as current'))).toBe(true);
  });

  it('ignores phrases that are not inventory counts', () => {
    write('CONTRIBUTING.md', 'Any change requires a new 14-digit timestamped migration file.\nOn a PostgreSQL 17 target missing Migration 0048, a Gate 4 comparison fails.\n');
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
  });

  it('rejects a release commit presented as current unless it is in the record or explicitly dated', () => {
    write('docs/m6-operational-readiness.md', `The service is deployed at exact merged-main SHA \`${STALE_SHA}\`.\n`);
    expect(checkReleaseStatusDrift(repoRoot)[0]).toMatch(/docs\/m6-operational-readiness\.md:1: Presents commit 95fe7ea023f6 as current/);
    write('docs/m6-operational-readiness.md', `The service is deployed at exact merged-main SHA \`${CURRENT_SHA}\`.\nThe earlier 2026-09-15 observation was \`${STALE_SHA}\`.\nHistorical: \`${STALE_SHA}\`.\n`);
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
  });

  it('rejects approved-only feed wording', () => {
    write('docs/developer-handover-guide.md', 'The approved-only public JSON feed is the boundary.\n');
    expect(checkReleaseStatusDrift(repoRoot)[0]).toMatch(/approved-only/);
    write('docs/developer-handover-guide.md', 'The published-only public JSON feed is the boundary; approved records are publication candidates.\n');
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
  });

  it('passes on the real repository', () => {
    expect(checkReleaseStatusDrift(realRepoRoot)).toEqual([]);
  });
});
