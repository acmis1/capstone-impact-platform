// Shared contract for the reproducible handoff package: layout, hashing, ZIP entry rules and the
// source-snapshot reader. Both the builder and the verifier import from here so the two cannot drift.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_NAME = 'MANIFEST.sha256.json';
export const START_HERE_NAME = 'START-HERE.md';
export const CHECKSUM_SUFFIX = '.sha256';
export const SOURCE_DIRECTORY = 'source';
export const EVIDENCE_DIRECTORY = 'evidence';
export const PACKAGE_SCHEMA_VERSION = 1;
export const REPOSITORY_URL = 'https://github.com/acmis1/capstone-impact-platform';

/** Files that must never travel in a package, wherever they come from. */
const FORBIDDEN_BASENAMES = new Set(['.env', '.env.local', '.local-users.json']);
const FORBIDDEN_PATTERNS = [/(^|\/)\.env(?!\.example$)(\.|$)/, /(^|\/)node_modules\//, /(^|\/)\.git(\/|$)/, /\.(pem|key|p12|pfx)$/i];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Git's own blob identity for a byte buffer, used to prove an extracted file equals a tracked blob. */
export function gitBlobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function isForbiddenPath(relativePath) {
  const normalised = relativePath.replaceAll('\\', '/');
  if (FORBIDDEN_BASENAMES.has(path.posix.basename(normalised))) return true;
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalised));
}

/** Rejects absolute names, traversal, backslashes, duplicates and empty segments in ZIP entry names. */
export function validateEntryName(name, seen = new Set()) {
  const problems = [];
  if (name.includes('\\')) problems.push('backslash separator');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) problems.push('absolute path');
  const segments = name.split('/');
  if (segments.some((segment) => segment === '..')) problems.push('parent traversal');
  if (segments.some((segment, index) => segment === '' && index !== segments.length - 1)) problems.push('empty path segment');
  if (/[\u0000-\u001f]/.test(name)) problems.push('control character');
  const key = name.replace(/\/$/, '');
  if (seen.has(key)) problems.push('duplicate entry');
  seen.add(key);
  return problems;
}

export function git(repoRoot, args, options = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
}

/** Resolves a commit-ish to a full SHA and fails if it is unknown. */
export function resolveCommit(repoRoot, commitish) {
  const sha = git(repoRoot, ['rev-parse', '--verify', `${commitish}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Cannot resolve commit: ${commitish}`);
  return sha;
}

/** Lists every tracked regular file (blob) at a commit with its blob SHA-1 and mode. */
export function listTrackedBlobs(repoRoot, commit) {
  const output = git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const blobs = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const [meta, filePath] = record.split('\t');
    const [mode, type, sha1] = meta.split(' ');
    if (type !== 'blob') continue;
    if (mode === '120000') throw new Error(`Refusing to package a symbolic link tracked at ${filePath}`);
    blobs.push({ path: filePath, sha1, mode });
  }
  return blobs.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Reads the exact bytes of every listed blob from the object database (not the working tree), so
 * an uncommitted edit can never leak into a package that claims a commit identity.
 */
export function readBlobs(repoRoot, blobs) {
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input: blobs.map((blob) => `${blob.sha1}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git cat-file failed: ${result.stderr?.toString()}`);
  const buffer = result.stdout;
  const contents = new Map();
  let offset = 0;
  for (const blob of blobs) {
    const newline = buffer.indexOf(0x0a, offset);
    const header = buffer.subarray(offset, newline).toString('utf8');
    const [sha1, type, sizeText] = header.split(' ');
    if (type !== 'blob' || sha1 !== blob.sha1) throw new Error(`Unexpected cat-file record for ${blob.path}: ${header}`);
    const size = Number(sizeText);
    const start = newline + 1;
    contents.set(blob.path, buffer.subarray(start, start + size));
    offset = start + size + 1;
  }
  return contents;
}

/** Recursively lists regular files under a directory as POSIX-relative paths; refuses symlinks. */
export function listDirectoryFiles(directory) {
  const files = [];
  const walk = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const entryPath = path.join(current, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${entryPath}`);
      if (entry.isDirectory()) walk(entryPath, entryRelative);
      else if (entry.isFile()) files.push(entryRelative);
      else throw new Error(`Unsupported file type: ${entryPath}`);
    }
  };
  walk(directory, '');
  return files;
}

/** Repository-relative Markdown link targets that the package must be able to resolve. */
export function markdownLinkTargets(markdown) {
  const targets = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('<')) continue;
    targets.push(raw.split('#')[0]);
  }
  return targets.filter(Boolean);
}
