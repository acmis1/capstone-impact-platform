import fs from 'node:fs';
import path from 'node:path';

/**
 * Current-state drift check for release identity.
 *
 * `docs/handover/release-closure-status.md` is the single record of the tracked migration
 * inventory and the observed release identities. Entry-point documents may cite dated history, but
 * they must not present a different migration count, a different release commit, or
 * "approved-only" feed semantics as *current*. A line is treated as dated history when it carries an
 * explicit historical marker (see `HISTORICAL_MARKER`); everything else is read as a current claim.
 */
export const RELEASE_STATUS_RECORD = 'docs/handover/release-closure-status.md';

export const CURRENT_STATE_DOCUMENTS = [
  'README.md',
  'START_HERE.md',
  'CONTRIBUTING.md',
  'apps/admin-cms/README.md',
  'docs/README.md',
  'docs/handover/README.md',
  'docs/handover/environment-matrix.md',
  'docs/handover/resource-ownership-matrix.md',
  'docs/handover/runtime-configuration-contract.md',
  'docs/developer-handover-guide.md',
  'docs/admin-operator-guide.md',
  'docs/post-audit-maintenance-guide.md',
  'docs/project-architecture-and-constraints.md',
  'docs/security-and-maintainability-plan.md',
  'docs/implementation-backlog.md',
  'docs/m6-operational-readiness.md',
  'infra/supabase/README.md',
  'infra/supabase/local-development.md',
  'infra/supabase/staging-reconciliation-runbook.md',
];

const MIGRATION_FILE = /^\d{14}_[A-Za-z0-9_]+\.sql$/;
const MIGRATION_COUNT_CLAIM = /\b(\d{2,3})(?:-| )(?:(?:timestamped|repository|forward-only|append-only|SQL|reviewed|candidate|expected|hosted|applied|tracked|PostgreSQL|database|release) ){0,2}migration(?:s| files)?\b/gi;
const MIGRATION_COUNT_HEADING = /\((\d{2,3}) Migrations Total\)/gi;
const FULL_SHA = /\b[0-9a-f]{40}\b/g;
const APPROVED_ONLY_FEED = /approved-only(?: public)?(?: JSON)? feed/i;
/** Markers that make a whole line dated history wherever they appear. */
const STRONG_HISTORICAL_MARKER = /historical|superseded|receipt|capture/i;
/** Markers that make a claim dated history only when they precede the number or commit on the line. */
const LEADING_HISTORICAL_MARKER = new RegExp([
  'earlier', 'prior', 'previous', 'previously', 'dated', 'at that time', 'at the time', 'baseline', 'observation',
  'observed', 'recorded', 'record of', 'log\\b', 'was applied', 'were applied', 'was deployed', 'were deployed',
  'on \\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) 20\\d{2}',
  '\\b20\\d{2}-\\d{2}-\\d{2}\\b',
].join('|'), 'i');

function isDatedHistory(line: string, index: number): boolean {
  return STRONG_HISTORICAL_MARKER.test(line) || LEADING_HISTORICAL_MARKER.test(line.slice(0, index));
}

export function trackedMigrationInventory(repoRoot: string): { count: number; latest: string } {
  const directory = path.join(repoRoot, 'infra/supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => MIGRATION_FILE.test(name)).sort();
  return { count: files.length, latest: files[files.length - 1] ?? '' };
}

export function checkReleaseStatusDrift(repoRoot: string): string[] {
  const failures: string[] = [];
  const recordPath = path.join(repoRoot, RELEASE_STATUS_RECORD);
  if (!fs.existsSync(recordPath)) return [`Missing release/closure status record: ${RELEASE_STATUS_RECORD}`];
  const record = fs.readFileSync(recordPath, 'utf8');
  const inventory = trackedMigrationInventory(repoRoot);

  const countMatch = record.match(/\*\*(\d+)\*\* files; latest `([^`]+)`/);
  if (!countMatch) {
    failures.push(`${RELEASE_STATUS_RECORD}: Missing the tracked inventory statement '**<count>** files; latest \`<file>\`'`);
  } else {
    if (Number(countMatch[1]) !== inventory.count) {
      failures.push(`${RELEASE_STATUS_RECORD}: States ${countMatch[1]} migrations but infra/supabase/migrations/ contains ${inventory.count}`);
    }
    if (countMatch[2] !== inventory.latest) {
      failures.push(`${RELEASE_STATUS_RECORD}: States latest migration ${countMatch[2]} but the tracked latest is ${inventory.latest}`);
    }
  }
  const recordedShas = new Set((record.match(FULL_SHA) ?? []).map((sha) => sha.toLowerCase()));

  for (const relativePath of CURRENT_STATE_DOCUMENTS) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      failures.push(`Missing current-state document: ${relativePath}`);
      continue;
    }
    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const location = `${relativePath}:${index + 1}`;
      for (const pattern of [MIGRATION_COUNT_CLAIM, MIGRATION_COUNT_HEADING]) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          const claimed = Number(match[1]);
          if (claimed !== inventory.count && !isDatedHistory(line, match.index)) {
            failures.push(`${location}: Presents ${claimed} migrations as current; the tracked inventory has ${inventory.count} (mark dated history explicitly or cite ${RELEASE_STATUS_RECORD})`);
          }
        }
      }
      FULL_SHA.lastIndex = 0;
      for (const match of line.matchAll(FULL_SHA)) {
        const sha = match[0].toLowerCase();
        if (!recordedShas.has(sha) && !isDatedHistory(line, match.index)) {
          failures.push(`${location}: Presents commit ${sha.slice(0, 12)} as current but it is not in ${RELEASE_STATUS_RECORD} (mark dated history explicitly)`);
        }
      }
      if (APPROVED_ONLY_FEED.test(line)) {
        failures.push(`${location}: Describes an 'approved-only' feed; the ordinary public feed is published-only and approved records are publication candidates`);
      }
    });
  }
  return failures;
}
