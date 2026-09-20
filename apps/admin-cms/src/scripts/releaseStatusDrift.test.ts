import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_STATE_DOCUMENTS,
  RELEASE_STATUS_RECORD,
  checkReleaseStatusDrift,
  classifyClaim,
  currentIdentities,
  trackedMigrationInventory,
} from './releaseStatusDrift';

const realRepoRoot = path.resolve(__dirname, '../../../../');
const CURRENT_SHA = '9690ee0faa37fda502a15b4403f1e293f79b519f';
const MAIN_SHA = '5c88a6c1ff9a435cb1d4299d617543465175afa1';
const STALE_SHA = '95fe7ea023f6eba0a0161f636aae05e721c018f2';
const RECEIPT_ONLY_SHA = '79fe1b333d16fafe9aa15e5572e230d74640f365';

let repoRoot: string;

function write(relative: string, content: string) {
  const target = path.join(repoRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function migrationName(index: number) {
  return `2026060100${String(index).padStart(4, '0')}_migration_${index}.sql`;
}

function scaffold(migrationCount: number) {
  for (let index = 1; index <= migrationCount; index += 1) write(`infra/supabase/migrations/${migrationName(index)}`, '-- synthetic\n');
  write(RELEASE_STATUS_RECORD, [
    '# Status',
    '',
    '<!-- current-identity',
    `main: ${MAIN_SHA}`,
    `deployed-backend: ${CURRENT_SHA}`,
    `public-layer: ${MAIN_SHA}`,
    '-->',
    '',
    `| Migration inventory (tracked) | **${migrationCount}** files; latest \`${migrationName(migrationCount)}\` |`,
    `| Superseded release | The earlier release \`${RECEIPT_ONLY_SHA}\` appears in a dated 2026-09-18 receipt but is not a current identity |`,
    '',
  ].join('\n'));
  for (const relative of CURRENT_STATE_DOCUMENTS) {
    if (relative !== RELEASE_STATUS_RECORD) write(relative, '# Current document\n\nNothing stale here.\n');
  }
}

function failuresFor(relative: string, content: string) {
  write(relative, content);
  return checkReleaseStatusDrift(repoRoot);
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-status-drift-'));
  scaffold(62);
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('release status drift check', () => {
  it('passes when the record matches the tracked inventory and no document presents stale state as current', () => {
    expect(trackedMigrationInventory(repoRoot)).toEqual({ count: 62, latest: migrationName(62) });
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([]);
  });

  it('fails when the record count or latest migration drifts from the directory', () => {
    write(`infra/supabase/migrations/${migrationName(63)}`, '-- new forward migration\n');
    const failures = checkReleaseStatusDrift(repoRoot);
    expect(failures).toContain(`${RELEASE_STATUS_RECORD}: States 62 migrations but infra/supabase/migrations/ contains 63`);
    expect(failures).toContain(`${RELEASE_STATUS_RECORD}: States latest migration ${migrationName(62)} but the tracked latest is ${migrationName(63)}`);
  });

  it('fails when the record is missing, lacks the inventory statement, or lacks the current-identity roles', () => {
    fs.rmSync(path.join(repoRoot, RELEASE_STATUS_RECORD));
    expect(checkReleaseStatusDrift(repoRoot)).toEqual([`Missing release/closure status record: ${RELEASE_STATUS_RECORD}`]);
    write(RELEASE_STATUS_RECORD, '# Status without inventory\n');
    const failures = checkReleaseStatusDrift(repoRoot);
    expect(failures[0]).toMatch(/Missing the tracked inventory statement/);
    expect(failures).toContain(`${RELEASE_STATUS_RECORD}: current-identity block does not declare 'main'`);
  });

  it('rejects the reviewer counterexamples: an explicit current claim is not rescued by historical wording elsewhere', () => {
    expect(failuresFor('README.md', 'Current main has 58 append-only migrations; migrations retain their historical bytes.\n'))
      .toEqual(['README.md:1: Explicit current claim of 58 migrations; the tracked inventory has 62 (correct it, or mark the clause as dated history)']);
    expect(failuresFor('README.md', 'The current verified observation records 58 rows through 20260914100000_layout_recipe_library.\n'))
      .toEqual(['README.md:1: Explicit current claim of 58 migrations; the tracked inventory has 62 (correct it, or mark the clause as dated history)']);
    expect(failuresFor('README.md', 'The current repository contains 58 migrations.\n')).toHaveLength(1);
    expect(failuresFor('README.md', 'Historical note. The current hosted evidence is 58 rows through `20260914100000_layout_recipe_library`.\n')).toHaveLength(1);
  });

  it('rejects unmarked stale counts and accepts counts that match the inventory', () => {
    expect(failuresFor('README.md', 'Local reset replays all 58 repository migrations.\n'))
      .toEqual(['README.md:1: Unmarked claim of 58 migrations; the tracked inventory has 62 (correct it, or mark the clause as dated history)']);
    expect(failuresFor('README.md', 'Local reset replays all 62 repository migrations.\nThe current inventory is 62 migrations.\n')).toEqual([]);
    expect(failuresFor('infra/supabase/README.md', '## Selected Migration Inventory (58 Migrations Total)\n')).toHaveLength(1);
  });

  it('accepts claims whose own clause is explicitly dated history', () => {
    expect(failuresFor('README.md', [
      'The earlier 58-migration observation is dated history.',
      'The prior capture recorded 57 migrations.',
      'On 15 September 2026 staging had 58 migrations.',
      'A dated 2026-09-15 observation recorded 58 rows through `20260914100000_layout_recipe_library`.',
      'Historical 46-row, 48/48 and 52-row observations remain superseded.',
      '| Read-only smoke | At that earlier observation readiness reported 58 expected migrations through `20260914100000_layout_recipe_library` |',
    ].join('\n') + '\n')).toEqual([]);
  });

  it('judges each clause separately on a line', () => {
    // The historical clause is fine; the second clause is an unmarked stale claim.
    expect(failuresFor('README.md', 'The earlier observation had 57 migrations; staging is verified at 58 migrations.\n'))
      .toEqual(['README.md:1: Unmarked claim of 58 migrations; the tracked inventory has 62 (correct it, or mark the clause as dated history)']);
    expect(classifyClaim('Historical note. Current main has 58 migrations.', 26)).toBe('CURRENT');
    expect(classifyClaim('The Current-52 recovery evidence (2026-09-08) covered 52 migrations.', 52)).toBe('DATED_HISTORY');
    expect(classifyClaim('Some text about 58 migrations.', 16)).toBe('UNMARKED');
  });

  it('ignores phrases that are not inventory counts', () => {
    expect(failuresFor('CONTRIBUTING.md', 'Any change requires a new 14-digit timestamped migration file.\nOn a PostgreSQL 17 target missing Migration 0048, a Gate 4 comparison fails.\n')).toEqual([]);
  });

  it('treats only the declared current-identity commits as current', () => {
    expect(currentIdentities(fs.readFileSync(path.join(repoRoot, RELEASE_STATUS_RECORD), 'utf8'))).toEqual(new Map([
      ['main', MAIN_SHA], ['deployed-backend', CURRENT_SHA], ['public-layer', MAIN_SHA],
    ]));
    expect(failuresFor('docs/m6-operational-readiness.md', `The service is deployed at exact merged-main SHA \`${STALE_SHA}\`.\n`))
      .toEqual([`docs/m6-operational-readiness.md:1: Explicit current claim of commit ${STALE_SHA.slice(0, 12)} which is not a current identity in ${RELEASE_STATUS_RECORD} (correct it, or mark the clause as dated history)`]);
    // A commit that appears in the record only as a receipt is still not a current identity.
    expect(failuresFor('docs/m6-operational-readiness.md', `The service runs \`${RECEIPT_ONLY_SHA}\`.\n`)).toHaveLength(1);
    expect(failuresFor('docs/m6-operational-readiness.md', [
      `The service is deployed at exact merged-main SHA \`${CURRENT_SHA}\`.`,
      `The earlier 2026-09-15 observation was \`${STALE_SHA}\`.`,
      `Superseded release: \`${RECEIPT_ONLY_SHA}\`.`,
    ].join('\n') + '\n')).toEqual([]);
  });

  it('rejects approved-only feed wording', () => {
    expect(failuresFor('docs/developer-handover-guide.md', 'The approved-only public JSON feed is the boundary.\n')[0]).toMatch(/approved-only/);
    expect(failuresFor('docs/developer-handover-guide.md', 'The published-only public JSON feed is the boundary; approved records are publication candidates.\n')).toEqual([]);
  });

  it('passes on the real repository', () => {
    expect(checkReleaseStatusDrift(realRepoRoot)).toEqual([]);
  });
});
