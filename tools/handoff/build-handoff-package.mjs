#!/usr/bin/env node
// Builds the reproducible PP1 handoff package from an exact commit.
//
//   node tools/handoff/build-handoff-package.mjs --out <dir> [--commit HEAD] [--evidence <dir>]
//        [--status candidate|released] [--deployed-backend <sha>] [--public-layer <sha>]
//        [--worker-image <ref>] [--label "<text>"]
//
// Layout inside the ZIP (all entry names use forward slashes):
//   PP1-HANDOFF-<short-sha>/START-HERE.md          generated recipient entry point
//   PP1-HANDOFF-<short-sha>/MANIFEST.sha256.json   SHA-256 + size of every other regular file
//   PP1-HANDOFF-<short-sha>/source/**              complete tracked-source snapshot at the commit
//   PP1-HANDOFF-<short-sha>/evidence/**            optional curated, sanitized receipts
//
// The source snapshot is read from the git object database, never from the working tree, so the
// package cannot contain uncommitted edits while claiming a commit identity. A sidecar
// <zip>.sha256 records the outer checksum and build-receipt.json records what was built.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import { scanText } from '../security/secret-scan.mjs';
import {
  CHECKSUM_SUFFIX,
  EVIDENCE_DIRECTORY,
  MANIFEST_NAME,
  PACKAGE_SCHEMA_VERSION,
  REPOSITORY_URL,
  SOURCE_DIRECTORY,
  START_HERE_NAME,
  git,
  isForbiddenPath,
  listDirectoryFiles,
  listTrackedBlobs,
  readBlobs,
  resolveCommit,
  sha256,
  validateEntryName,
} from './package-contract.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '../..');

export function parseArguments(argv) {
  const options = {
    repoRoot: defaultRepoRoot,
    commit: 'HEAD',
    out: null,
    evidence: null,
    status: 'candidate',
    label: null,
    deployedBackend: null,
    publicLayer: null,
    workerImage: null,
    builtAt: null,
  };
  const keys = {
    '--repo': 'repoRoot', '--commit': 'commit', '--out': 'out', '--evidence': 'evidence', '--status': 'status',
    '--label': 'label', '--deployed-backend': 'deployedBackend', '--public-layer': 'publicLayer',
    '--worker-image': 'workerImage', '--built-at': 'builtAt',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = argv[index].split(/=(.*)/s);
    const key = keys[flag];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    options[key] = value;
  }
  if (!options.out) throw new Error('--out <directory> is required');
  if (!['candidate', 'released'].includes(options.status)) throw new Error('--status must be candidate or released');
  return options;
}

function statusLabel(options) {
  if (options.label) return options.label;
  return options.status === 'released'
    ? 'RELEASED — built from the accepted, merged commit'
    : 'CANDIDATE — LOCAL VERIFICATION; NOT YET MERGED OR DEPLOYED';
}

function renderStartHere({ commit, tree, subject, committedAt, builtAt, options, shortSha, evidenceFiles }) {
  const label = statusLabel(options);
  const identity = [
    ['Source commit (this package)', `\`${commit}\``],
    ['Source tree', `\`${tree}\``],
    ['Commit subject', subject],
    ['Commit date', committedAt],
    ['Previously observed deployed Admin/CMS backend', options.deployedBackend ? `\`${options.deployedBackend}\`` : 'not supplied at build time'],
    ['Installed public-layer identity (Duda TEST)', options.publicLayer ? `\`${options.publicLayer}\`` : 'not supplied at build time'],
    ['Registered/running worker image', options.workerImage ? `\`${options.workerImage}\`` : 'not supplied at build time'],
  ];
  const evidenceSection = evidenceFiles.length
    ? evidenceFiles.map((file) => `- \`${EVIDENCE_DIRECTORY}/${file}\``).join('\n')
    : '_No evidence receipts were included in this build._';
  return `# PP1 Capstone Impact Platform — Handoff Package

> **${label}**

Built ${builtAt} from \`${REPOSITORY_URL}\` at commit \`${commit}\` (package id \`PP1-HANDOFF-${shortSha}\`).

## 1. What is authoritative

**The repository source snapshot in \`${SOURCE_DIRECTORY}/\` is authoritative.** It is the complete tracked
tree of the commit above, read from the git object database. Everything else in this package —
this page, the manifest and the evidence receipts — describes or attests to that snapshot and
never overrides it. If this page and a document under \`${SOURCE_DIRECTORY}/\` disagree, the source
document wins and this package should be rebuilt.

The identities the build was told about are listed below. They are *inputs recorded at build
time*, not fresh verification. The dated, evidence-classed statement of what is deployed lives in
[\`${SOURCE_DIRECTORY}/docs/handover/release-closure-status.md\`](${SOURCE_DIRECTORY}/docs/handover/release-closure-status.md).

| Item | Value |
| --- | --- |
${identity.map(([item, value]) => `| ${item} | ${value} |`).join('\n')}

${options.status === 'candidate'
    ? `**Candidate versus deployed.** This package is built from a *candidate* commit. Nothing in it
has been merged to \`main\`, deployed to the staging Admin/CMS, built into a worker image, or
installed on the Duda site unless the status record inside \`${SOURCE_DIRECTORY}/\` says so with a receipt.
The deployed backend listed above (if any) is an earlier release; the difference between it and
this candidate is described in the status record.`
    : `**Released.** This package was built from the accepted commit. Confirm that the status record
inside \`${SOURCE_DIRECTORY}/\` carries the deployment receipts for this exact commit before treating the
running system as identical to it.`}

## 2. Start reading here

| Question | Read |
| --- | --- |
| What is deployed, what is pending, what the evidence proves | [\`${SOURCE_DIRECTORY}/docs/handover/release-closure-status.md\`](${SOURCE_DIRECTORY}/docs/handover/release-closure-status.md) |
| I am taking over operations or engineering | [\`${SOURCE_DIRECTORY}/docs/handover/README.md\`](${SOURCE_DIRECTORY}/docs/handover/README.md) |
| I am School staff running the system | [\`${SOURCE_DIRECTORY}/docs/admin-operator-guide.md\`](${SOURCE_DIRECTORY}/docs/admin-operator-guide.md) |
| I am the technical maintainer | [\`${SOURCE_DIRECTORY}/docs/developer-handover-guide.md\`](${SOURCE_DIRECTORY}/docs/developer-handover-guide.md) and [\`${SOURCE_DIRECTORY}/START_HERE.md\`](${SOURCE_DIRECTORY}/START_HERE.md) |
| Deploying, maintaining and rolling back | [\`${SOURCE_DIRECTORY}/docs/post-audit-maintenance-guide.md\`](${SOURCE_DIRECTORY}/docs/post-audit-maintenance-guide.md) and [\`${SOURCE_DIRECTORY}/docs/admin-cms-hosted-deployment.md\`](${SOURCE_DIRECTORY}/docs/admin-cms-hosted-deployment.md) |
| Known limitations and audit finding dispositions | [\`${SOURCE_DIRECTORY}/docs/handover/closure-audit-disposition-register.md\`](${SOURCE_DIRECTORY}/docs/handover/closure-audit-disposition-register.md) |
| What only the School can do | [\`${SOURCE_DIRECTORY}/docs/handover/README.md\`](${SOURCE_DIRECTORY}/docs/handover/README.md) §5 and [\`${SOURCE_DIRECTORY}/docs/m6-release-acceptance-checklist.md\`](${SOURCE_DIRECTORY}/docs/m6-release-acceptance-checklist.md) |

Relative links inside \`${SOURCE_DIRECTORY}/\` resolve within this package because the snapshot is complete.

## 3. Known limitations and pending institutional actions

- Institutional acceptance is **not evidenced**: ownership transfer, an institutional executor host,
  backups/PITR and RPO/RTO acceptance, monitoring alert destination, email provider approval,
  staff accounts/training/UAT, live Duda cutover, the efficiency measurement and sign-off remain
  pending (status record §5).
- The staging assistive worker runs on a project-team member's machine, not institutional compute
  (status record §4).
- Free-tier hosting has no uptime SLA and no managed backups.
- This package makes **no** statement about demonstration data: it does not assert that any demo
  project identifiers are present, absent or reusable. Inspect the staging Admin/CMS directly.

## 4. Maintenance and deployment handback (smallest sequence)

1. Independent review of the source commit's diff against its base.
2. Exact-head CI green on the commit (all workflows), then merge to \`main\`, then post-merge CI.
3. Rebuild the worker image from the merged commit, replace the running worker, confirm heartbeat
   compatibility, then redeploy the Admin/CMS and read \`/api/readiness\` fresh.
4. Tag the release, regenerate this package with \`--status released\` from the merged commit, and
   add the receipts to the status record.

Details: [\`${SOURCE_DIRECTORY}/docs/post-audit-maintenance-guide.md\`](${SOURCE_DIRECTORY}/docs/post-audit-maintenance-guide.md).

## 5. Verifying this package

- \`${MANIFEST_NAME}\` lists the SHA-256 and byte size of **every regular file in this package except
  the manifest itself** (it cannot contain its own hash). The outer ZIP checksum is in the
  sidecar \`<zip>${CHECKSUM_SUFFIX}\` and in \`build-receipt.json\` next to the ZIP.
- From any repository clone with dependencies installed:
  \`node tools/handoff/verify-handoff-package.mjs --zip <this zip> --commit ${commit}\`
  checks entry-name portability, extracts to a fresh temporary directory, verifies every hash and
  size, rejects missing/extra/tampered files, checks local Markdown link targets, proves the
  extracted \`${SOURCE_DIRECTORY}/\` tree equals the tracked blobs of the commit and runs the secret pattern scan.
- Without dependencies, on an already-extracted directory:
  \`node ${SOURCE_DIRECTORY}/tools/handoff/verify-handoff-package.mjs --dir <extracted package root>\`.

## 6. Evidence receipts included

${evidenceSection}

Receipts are team-produced artefacts sanitised for redistribution; their provenance is stated in
the status record. They are evidence *with that provenance*, not independently repeated tests.
`;
}

export async function buildHandoffPackage(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const commit = resolveCommit(repoRoot, options.commit);
  const shortSha = commit.slice(0, 12);
  const tree = git(repoRoot, ['rev-parse', `${commit}^{tree}`]).trim();
  const subject = git(repoRoot, ['log', '-1', '--format=%s', commit]).trim();
  const committedAt = git(repoRoot, ['log', '-1', '--format=%cI', commit]).trim();
  const builtAt = options.builtAt ?? new Date().toISOString();
  const prefix = `PP1-HANDOFF-${shortSha}`;

  const blobs = listTrackedBlobs(repoRoot, commit);
  const contents = readBlobs(repoRoot, blobs);
  const files = new Map(); // package-relative path (without prefix) -> Buffer
  for (const blob of blobs) {
    if (isForbiddenPath(blob.path)) throw new Error(`Tracked file is forbidden in a package: ${blob.path}`);
    files.set(`${SOURCE_DIRECTORY}/${blob.path}`, contents.get(blob.path));
  }

  const evidenceFiles = [];
  if (options.evidence) {
    const evidenceRoot = path.resolve(options.evidence);
    for (const relative of listDirectoryFiles(evidenceRoot)) {
      if (isForbiddenPath(relative)) throw new Error(`Evidence file is forbidden in a package: ${relative}`);
      const bytes = fs.readFileSync(path.join(evidenceRoot, relative));
      if (!bytes.includes(0)) {
        const findings = scanText(`${EVIDENCE_DIRECTORY}/${relative}`, bytes.toString('utf8'));
        if (findings.length) throw new Error(`Evidence file matches a secret pattern: ${relative} (${findings.map((f) => f.ruleId).join(', ')})`);
      }
      files.set(`${EVIDENCE_DIRECTORY}/${relative}`, bytes);
      evidenceFiles.push(relative);
    }
  }

  const startHere = renderStartHere({ commit, tree, subject, committedAt, builtAt, options, shortSha, evidenceFiles });
  files.set(START_HERE_NAME, Buffer.from(startHere, 'utf8'));

  const manifestEntries = [...files.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([relative, bytes]) => ({ path: relative, size: bytes.length, sha256: sha256(bytes) }));
  const manifest = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    package: prefix,
    repository: REPOSITORY_URL,
    commit,
    tree,
    status: options.status,
    label: statusLabel(options),
    builtAt,
    identity: {
      deployedBackend: options.deployedBackend,
      publicLayer: options.publicLayer,
      workerImage: options.workerImage,
    },
    excludes: `${MANIFEST_NAME} lists every regular file in the package except itself; it cannot contain its own hash. The outer ZIP checksum is recorded in the sidecar ${CHECKSUM_SUFFIX} file and build-receipt.json.`,
    fileCount: manifestEntries.length,
    files: manifestEntries,
  };
  files.set(MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));

  const zip = new JSZip();
  const seen = new Set();
  const fixedDate = new Date(committedAt);
  for (const relative of [...files.keys()].sort()) {
    const name = `${prefix}/${relative}`;
    const problems = validateEntryName(name, seen);
    if (problems.length) throw new Error(`Invalid ZIP entry name ${name}: ${problems.join(', ')}`);
    zip.file(name, files.get(relative), { date: fixedDate, unixPermissions: 0o644, createFolders: false });
  }
  const zipBytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
    streamFiles: false,
  });

  fs.mkdirSync(path.resolve(options.out), { recursive: true });
  const zipPath = path.join(path.resolve(options.out), `${prefix}.zip`);
  fs.writeFileSync(zipPath, zipBytes);
  const zipSha256 = sha256(zipBytes);
  fs.writeFileSync(`${zipPath}${CHECKSUM_SUFFIX}`, `${zipSha256}  ${path.basename(zipPath)}\n`);
  const receipt = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    zip: path.basename(zipPath),
    zipSha256,
    zipBytes: zipBytes.length,
    commit,
    tree,
    status: options.status,
    label: statusLabel(options),
    builtAt,
    entries: files.size,
    sourceFiles: blobs.length,
    evidenceFiles: evidenceFiles.length,
    manifestedFiles: manifestEntries.length,
    identity: manifest.identity,
  };
  fs.writeFileSync(path.join(path.dirname(zipPath), `${prefix}.build-receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  return { zipPath, zipSha256, receipt, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildHandoffPackage(parseArguments(process.argv.slice(2)))
    .then(({ zipPath, zipSha256, receipt }) => {
      console.log(`Built ${zipPath}`);
      console.log(`sha256 ${zipSha256}`);
      console.log(`commit ${receipt.commit} (${receipt.status}); ${receipt.sourceFiles} source files, ${receipt.evidenceFiles} evidence files, ${receipt.manifestedFiles} manifested files`);
    })
    .catch((error) => {
      console.error(`Handoff package build failed: ${error.message}`);
      process.exitCode = 1;
    });
}
