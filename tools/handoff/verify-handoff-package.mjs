#!/usr/bin/env node
// Verifies a PP1 handoff package produced by build-handoff-package.mjs.
//
//   node tools/handoff/verify-handoff-package.mjs --zip <package.zip> [--commit <sha>] [--repo <dir>]
//   node tools/handoff/verify-handoff-package.mjs --dir <extracted package root> [--commit <sha>] [--repo <dir>]
//
// --zip needs the repository's installed dependencies (jszip) and checks the actual archive: entry
// names, outer checksum sidecar, then extracts into a fresh temporary directory. --dir works with
// Node alone on an already-extracted package. Both then verify the manifest against every regular
// file (missing, extra, size or hash mismatch all fail), local Markdown link targets, forbidden
// files, the secret pattern scan and — when --commit is given and a repository is available — that
// every file under source/ equals the tracked blob of that commit and nothing is missing or extra.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHECKSUM_SUFFIX,
  MANIFEST_NAME,
  SOURCE_DIRECTORY,
  START_HERE_NAME,
  gitBlobSha1,
  isForbiddenPath,
  listDirectoryFiles,
  listTrackedBlobs,
  markdownLinkTargets,
  resolveCommit,
  sha256,
  validateEntryName,
} from './package-contract.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '../..');

export function parseArguments(argv) {
  const options = { zip: null, dir: null, commit: null, repoRoot: defaultRepoRoot, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = argv[index].split(/=(.*)/s);
    if (flag === '--keep') { options.keep = true; continue; }
    const keys = { '--zip': 'zip', '--dir': 'dir', '--commit': 'commit', '--repo': 'repoRoot' };
    const key = keys[flag];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    options[key] = value;
  }
  if (!options.zip && !options.dir) throw new Error('Provide --zip <file> or --dir <directory>');
  if (options.zip && options.dir) throw new Error('Provide only one of --zip or --dir');
  return options;
}

async function loadSecretScanner() {
  try {
    const module = await import('../security/secret-scan.mjs');
    return module.scanText;
  } catch {
    return null;
  }
}

/** Inspects the archive itself and extracts it into a fresh temporary directory. */
export async function inspectAndExtractZip(zipPath, failures) {
  const { default: JSZip } = await import('jszip');
  const bytes = fs.readFileSync(zipPath);
  const actualSha = sha256(bytes);
  const sidecar = `${zipPath}${CHECKSUM_SUFFIX}`;
  if (fs.existsSync(sidecar)) {
    const recorded = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    if (recorded !== actualSha) failures.push(`outer checksum mismatch: sidecar ${recorded} but archive is ${actualSha}`);
  } else {
    failures.push(`outer checksum sidecar missing: ${path.basename(sidecar)}`);
  }

  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const seen = new Set();
  const names = Object.keys(zip.files).sort();
  const prefixes = new Set();
  for (const name of names) {
    const entry = zip.files[name];
    for (const problem of validateEntryName(name, seen)) failures.push(`entry ${name}: ${problem}`);
    const mode = (entry.unixPermissions ?? 0) & 0o170000;
    if (mode === 0o120000) failures.push(`entry ${name}: symbolic link`);
    if (!entry.dir) prefixes.add(name.split('/')[0]);
    if (!entry.dir && !name.includes('/')) failures.push(`entry ${name}: not under the package prefix`);
  }
  if (prefixes.size !== 1) failures.push(`expected exactly one top-level package directory, found: ${[...prefixes].join(', ') || 'none'}`);
  const prefix = [...prefixes][0] ?? 'package';

  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp1-handoff-verify-'));
  for (const name of names) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const target = path.join(extractRoot, ...name.split('/'));
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(extractRoot) + path.sep)) { failures.push(`entry ${name}: escapes extraction root`); continue; }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, await entry.async('nodebuffer'));
  }
  return { packageRoot: path.join(extractRoot, prefix), extractRoot, zipSha256: actualSha, entries: names.length };
}

/** Verifies an extracted package directory. */
export async function verifyPackageDirectory(packageRoot, { commit = null, repoRoot = defaultRepoRoot } = {}) {
  const failures = [];
  const warnings = [];
  const manifestPath = path.join(packageRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { failures: [`manifest missing: ${MANIFEST_NAME}`] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actualFiles = listDirectoryFiles(packageRoot).filter((relative) => relative !== MANIFEST_NAME);
  const manifested = new Map(manifest.files.map((entry) => [entry.path, entry]));

  for (const relative of actualFiles) {
    if (isForbiddenPath(relative)) failures.push(`forbidden file present: ${relative}`);
    const entry = manifested.get(relative);
    if (!entry) { failures.push(`unmanifested file: ${relative}`); continue; }
    const bytes = fs.readFileSync(path.join(packageRoot, relative));
    if (bytes.length !== entry.size) failures.push(`size mismatch: ${relative} (${bytes.length} != ${entry.size})`);
    else if (sha256(bytes) !== entry.sha256) failures.push(`hash mismatch: ${relative}`);
  }
  const actualSet = new Set(actualFiles);
  for (const relative of manifested.keys()) {
    if (!actualSet.has(relative)) failures.push(`manifested file missing: ${relative}`);
  }
  if (manifested.has(MANIFEST_NAME)) failures.push(`manifest must not list itself`);
  if (!actualSet.has(START_HERE_NAME)) failures.push(`${START_HERE_NAME} missing`);
  if (manifest.fileCount !== manifest.files.length) failures.push(`manifest fileCount ${manifest.fileCount} != ${manifest.files.length}`);

  // Local Markdown links must resolve inside the package.
  for (const relative of actualFiles.filter((file) => file.toLowerCase().endsWith('.md'))) {
    const markdown = fs.readFileSync(path.join(packageRoot, relative), 'utf8');
    for (const target of markdownLinkTargets(markdown)) {
      const decoded = decodeURI(target);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decoded));
      if (resolved.startsWith('..')) { failures.push(`link escapes package: ${relative} -> ${target}`); continue; }
      const candidate = path.join(packageRoot, ...resolved.split('/'));
      if (!fs.existsSync(candidate)) failures.push(`broken link: ${relative} -> ${target}`);
    }
  }

  // Secret pattern scan (only when the scanner is importable, i.e. run from a repository clone).
  const scanText = await loadSecretScanner();
  if (scanText) {
    for (const relative of actualFiles) {
      const bytes = fs.readFileSync(path.join(packageRoot, relative));
      if (bytes.includes(0)) continue;
      for (const finding of scanText(relative, bytes.toString('utf8'))) failures.push(`secret pattern ${finding.ruleId}: ${relative}:${finding.line}`);
    }
  }

  // Source snapshot equals the commit's tracked blobs.
  const expectedCommit = commit ?? manifest.commit;
  let sourceVerified = false;
  if (commit && manifest.commit !== resolveCommitSafe(repoRoot, commit)) {
    failures.push(`manifest commit ${manifest.commit} != requested ${commit}`);
  }
  try {
    const resolved = resolveCommit(repoRoot, expectedCommit);
    const blobs = listTrackedBlobs(repoRoot, resolved);
    const expected = new Map(blobs.map((blob) => [`${SOURCE_DIRECTORY}/${blob.path}`, blob.sha1]));
    for (const relative of actualFiles.filter((file) => file.startsWith(`${SOURCE_DIRECTORY}/`))) {
      const sha1 = expected.get(relative);
      if (!sha1) { failures.push(`source file not tracked at ${resolved.slice(0, 12)}: ${relative}`); continue; }
      if (gitBlobSha1(fs.readFileSync(path.join(packageRoot, relative))) !== sha1) failures.push(`source file differs from commit: ${relative}`);
    }
    for (const relative of expected.keys()) {
      if (!actualSet.has(relative)) failures.push(`tracked file missing from source snapshot: ${relative}`);
    }
    sourceVerified = true;
  } catch (error) {
    const message = `source snapshot could not be compared with commit ${expectedCommit}: ${error.message.split('\n')[0]}`;
    // Without --commit the comparison is best-effort (a --dir run may have no repository at hand).
    if (commit) failures.push(message); else warnings.push(message);
  }
  if (!scanText) warnings.push('secret pattern scanner unavailable (run from a repository clone to enable it)');

  return { failures, warnings, manifest, fileCount: actualFiles.length, sourceVerified, secretScanned: Boolean(scanText) };
}

function resolveCommitSafe(repoRoot, commit) {
  try { return resolveCommit(repoRoot, commit); } catch { return commit; }
}

export async function verifyHandoffPackage(options) {
  const failures = [];
  let packageRoot = options.dir ? path.resolve(options.dir) : null;
  let extractRoot = null;
  let zipInfo = null;
  if (options.zip) {
    zipInfo = await inspectAndExtractZip(path.resolve(options.zip), failures);
    packageRoot = zipInfo.packageRoot;
    extractRoot = zipInfo.extractRoot;
  }
  const result = await verifyPackageDirectory(packageRoot, { commit: options.commit, repoRoot: path.resolve(options.repoRoot) });
  failures.push(...result.failures);
  if (extractRoot && !options.keep) fs.rmSync(extractRoot, { recursive: true, force: true });
  return {
    ok: failures.length === 0,
    failures,
    warnings: result.warnings ?? [],
    zipSha256: zipInfo?.zipSha256 ?? null,
    entries: zipInfo?.entries ?? null,
    fileCount: result.fileCount ?? null,
    commit: result.manifest?.commit ?? null,
    sourceVerified: result.sourceVerified ?? false,
    secretScanned: result.secretScanned ?? false,
    extractRoot: options.keep ? extractRoot : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyHandoffPackage(parseArguments(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`Handoff package verification failed: ${error.message}`);
      process.exitCode = 1;
    });
}
