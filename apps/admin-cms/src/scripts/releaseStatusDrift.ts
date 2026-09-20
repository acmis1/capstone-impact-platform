import fs from 'node:fs';
import path from 'node:path';

/**
 * Current-state drift check for release identity.
 *
 * `docs/handover/release-closure-status.md` is the single record of the tracked migration
 * inventory and of the commits that are *currently* running or merged. This check reads three
 * kinds of claim out of the current-state documents and applies bounded, explicit conventions:
 *
 * Claims recognised on a line:
 *   - migration counts: `N migrations`, `N-migration`, `(N Migrations Total)`, and migration-history
 *     rows such as `N rows through <14-digit version>`;
 *   - full 40-hex commit identifiers;
 *   - the phrase "approved-only feed" (the ordinary public feed is published-only).
 *
 * Each claim is judged by its own clause only — the text on the same line from the previous clause
 * boundary (`. `, `; `, `| ` or the start of the line) up to the claim. Words in other clauses,
 * elsewhere on the line, or after the claim do not count:
 *   1. A clause that says `current`, `currently`, `latest`, `active`, `now` or `is deployed` before
 *      the claim is an explicit current claim. It must equal the tracked inventory, or be a commit
 *      declared in the record's `current-identity` block. Historical wording elsewhere never
 *      rescues an explicit current claim.
 *   2. Otherwise a clause is dated history only when, before the claim, it carries one of the
 *      explicit markers in `DATED_HISTORY_MARKER` (for example `historical`, `earlier`, `prior`,
 *      `superseded`, `at that time`, an ISO date, or `on 15 September 2026`).
 *   3. Every other claim that differs from the inventory / current identities is unmarked drift.
 *
 * Current commit identities are only those declared in the record's HTML comment block:
 *   <!-- current-identity
 *   main: <sha>
 *   deployed-backend: <sha>
 *   public-layer: <sha>
 *   -->
 * Other identifiers appearing in the record (receipt SHAs, superseded releases) are not current.
 *
 * What this does not do: it does not understand prose, does not scan dated evidence documents, and
 * cannot detect a stale claim phrased outside the recognised patterns. It is a guard against the
 * specific drift observed on 2026-09-20 (stale counts, stale release commits, approved-only
 * wording), not a proof that every sentence is current.
 */
export const RELEASE_STATUS_RECORD = 'docs/handover/release-closure-status.md';

export const CURRENT_STATE_DOCUMENTS = [
  'README.md',
  'START_HERE.md',
  'CONTRIBUTING.md',
  'apps/admin-cms/README.md',
  'docs/README.md',
  'docs/handover/README.md',
  'docs/handover/release-closure-status.md',
  'docs/handover/environment-matrix.md',
  'docs/handover/resource-ownership-matrix.md',
  'docs/handover/runtime-configuration-contract.md',
  'docs/developer-handover-guide.md',
  'docs/admin-operator-guide.md',
  'docs/admin-cms-hosted-deployment.md',
  'docs/operations/release-rollout-runbook.md',
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
const COUNT_QUALIFIER = '(?:(?:timestamped|repository|forward-only|append-only|SQL|reviewed|candidate|expected|hosted|applied|tracked|PostgreSQL|database|release) ){0,2}';
const CLAIM_PATTERNS: RegExp[] = [
  new RegExp(`\\b(\\d{2,3})(?:-| )${COUNT_QUALIFIER}migration(?:s| files)?\\b`, 'gi'),
  /\((\d{2,3}) Migrations Total\)/gi,
  /\b(\d{2,3}) (?:rows?|expected migrations|applied migrations|migrations) (?:recorded |are recorded |were recorded )?through `?\d{14}/gi,
];
const FULL_SHA = /\b[0-9a-f]{40}\b/g;
const APPROVED_ONLY_FEED = /approved-only(?: public)?(?: JSON)? feed/i;
const CLAUSE_BOUNDARY = /\. |; |\| /g;
/** Words that make the clause an explicit current claim (`Current-52` style names are excluded). */
const CURRENT_MARKER = /\b(?:current(?:ly)?(?!-\d)|latest|now|is deployed)\b/i;
/** Explicit dated-history markers; they must precede the claim inside its own clause. */
const DATED_HISTORY_MARKER = new RegExp([
  'historical', 'earlier', 'prior', 'previous', 'previously', 'dated', 'superseded', 'at that time', 'at the time',
  'then-', 'originally', 'initial', 'first recorded',
  'on \\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) 20\\d{2}',
  '\\b20\\d{2}-\\d{2}-\\d{2}\\b',
].join('|'), 'i');
const CURRENT_IDENTITY_BLOCK = /<!--\s*current-identity\s*\r?\n([\s\S]*?)-->/;

export function trackedMigrationInventory(repoRoot: string): { count: number; latest: string } {
  const directory = path.join(repoRoot, 'infra/supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => MIGRATION_FILE.test(name)).sort();
  return { count: files.length, latest: files[files.length - 1] ?? '' };
}

/** Parses the record's declared current commit identities (role -> sha). */
export function currentIdentities(record: string): Map<string, string> {
  const block = record.match(CURRENT_IDENTITY_BLOCK);
  const identities = new Map<string, string>();
  if (!block) return identities;
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z-]+):\s*([0-9a-f]{40})\s*$/i);
    if (match) identities.set(match[1].toLowerCase(), match[2].toLowerCase());
  }
  return identities;
}

/** The clause that contains `index`: from the last boundary before it to `index`. */
function clauseBefore(line: string, index: number): string {
  const head = line.slice(0, index);
  let start = 0;
  CLAUSE_BOUNDARY.lastIndex = 0;
  for (const boundary of head.matchAll(CLAUSE_BOUNDARY)) start = boundary.index + boundary[0].length;
  return head.slice(start);
}

export type ClaimClass = 'CURRENT' | 'DATED_HISTORY' | 'UNMARKED';

export function classifyClaim(line: string, index: number): ClaimClass {
  const clause = clauseBefore(line, index);
  if (CURRENT_MARKER.test(clause)) return 'CURRENT';
  if (DATED_HISTORY_MARKER.test(clause)) return 'DATED_HISTORY';
  return 'UNMARKED';
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
  const identities = currentIdentities(record);
  for (const role of ['main', 'deployed-backend', 'public-layer']) {
    if (!identities.has(role)) failures.push(`${RELEASE_STATUS_RECORD}: current-identity block does not declare '${role}'`);
  }
  const currentShas = new Set(identities.values());

  for (const relativePath of CURRENT_STATE_DOCUMENTS) {
    const fullPath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      failures.push(`Missing current-state document: ${relativePath}`);
      continue;
    }
    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    let insideIdentityBlock = false;
    lines.forEach((line, index) => {
      const location = `${relativePath}:${index + 1}`;
      if (/<!--\s*current-identity/.test(line)) insideIdentityBlock = true;
      if (insideIdentityBlock) {
        if (line.includes('-->')) insideIdentityBlock = false;
        return;
      }

      for (const pattern of CLAIM_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          const claimed = Number(match[1]);
          if (claimed === inventory.count) continue;
          const classification = classifyClaim(line, match.index);
          if (classification === 'DATED_HISTORY') continue;
          failures.push(`${location}: ${classification === 'CURRENT' ? 'Explicit current claim of' : 'Unmarked claim of'} ${claimed} migrations; the tracked inventory has ${inventory.count} (correct it, or mark the clause as dated history)`);
        }
      }
      FULL_SHA.lastIndex = 0;
      for (const match of line.matchAll(FULL_SHA)) {
        const sha = match[0].toLowerCase();
        if (currentShas.has(sha)) continue;
        const classification = classifyClaim(line, match.index);
        if (classification === 'DATED_HISTORY') continue;
        failures.push(`${location}: ${classification === 'CURRENT' ? 'Explicit current claim of' : 'Unmarked'} commit ${sha.slice(0, 12)} which is not a current identity in ${RELEASE_STATUS_RECORD} (correct it, or mark the clause as dated history)`);
      }
      if (APPROVED_ONLY_FEED.test(line)) {
        failures.push(`${location}: Describes an 'approved-only' feed; the ordinary public feed is published-only and approved records are publication candidates`);
      }
    });
  }
  return [...new Set(failures)];
}
