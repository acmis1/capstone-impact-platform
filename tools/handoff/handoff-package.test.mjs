import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildHandoffPackage, parseArguments as parseBuildArguments } from './build-handoff-package.mjs';
import { MANIFEST_NAME, START_HERE_NAME, SOURCE_DIRECTORY, isForbiddenPath, markdownLinkTargets, validateEntryName } from './package-contract.mjs';
import { inspectAndExtractZip, validateManifestStructure, verifyHandoffPackage, verifyPackageDirectory } from './verify-handoff-package.mjs';
import { UnsupportedZipError, readRawZipInventory } from './zip-inventory.mjs';

/** Byte-level helpers that build genuinely malformed archives from a valid one. */
function findEndOfCentralDirectory(bytes) {
  let offset = bytes.length - 22;
  while (offset >= 0 && bytes.readUInt32LE(offset) !== 0x06054b50) offset -= 1;
  if (offset < 0) throw new Error('EOCD missing');
  return offset;
}

/** Renames one entry in place (equal byte length) in both its central and local headers. */
function renameEntryInPlace(bytes, oldName, newName) {
  if (Buffer.byteLength(oldName) !== Buffer.byteLength(newName)) throw new Error('rename must keep the byte length');
  const out = Buffer.from(bytes);
  const needle = Buffer.from(oldName);
  let replaced = 0;
  let index = out.indexOf(needle);
  while (index >= 0) {
    // Only patch occurrences that are header names: preceded by a name-length field equal to the name length.
    const centralHeader = index >= 46 && out.readUInt32LE(index - 46) === 0x02014b50 && out.readUInt16LE(index - 18) === needle.length;
    const localHeader = index >= 30 && out.readUInt32LE(index - 30) === 0x04034b50 && out.readUInt16LE(index - 4) === needle.length;
    if (centralHeader || localHeader) { Buffer.from(newName).copy(out, index); replaced += 1; }
    index = out.indexOf(needle, index + 1);
  }
  if (replaced !== 2) throw new Error(`expected to patch central and local headers, patched ${replaced}`);
  return out;
}

/** Appends a duplicate of the first central-directory record and fixes the EOCD counts and size. */
function duplicateFirstCentralEntry(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  const size = bytes.readUInt32LE(eocd + 12);
  const offset = bytes.readUInt32LE(eocd + 16);
  const length = 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  const duplicate = bytes.subarray(offset, offset + length);
  const end = Buffer.from(bytes.subarray(eocd));
  end.writeUInt16LE(end.readUInt16LE(8) + 1, 8);
  end.writeUInt16LE(end.readUInt16LE(10) + 1, 10);
  end.writeUInt32LE(size + length, 12);
  return Buffer.concat([bytes.subarray(0, eocd), duplicate, end]);
}

async function resaveWithEntryName(bytes, oldSuffix, newName, contents) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const name = Object.keys(zip.files).find((candidate) => candidate.endsWith(oldSuffix) && !candidate.includes('/source/'));
  const data = contents ?? await zip.file(name).async('nodebuffer');
  if (!contents) zip.remove(name);
  zip.file(newName(name), data, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
}

async function verifyBytes(label, bytes, commit) {
  const target = path.join(tempRoot, `${label}.zip`);
  fs.writeFileSync(target, bytes);
  fs.writeFileSync(`${target}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(target)}\n`);
  return verifyHandoffPackage({ zip: target, commit, repoRoot: path.resolve('.'), keep: false });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pp1-handoff-test-'));
const outDirectory = path.join(tempRoot, 'out');
let built;

test.before(async () => {
  built = await buildHandoffPackage(parseBuildArguments([
    '--out', outDirectory, '--commit', 'HEAD', '--status', 'candidate',
    '--deployed-backend', '9690ee0faa37fda502a15b4403f1e293f79b519f',
    '--built-at', '2026-09-20T00:00:00.000Z',
  ]));
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('builds a package whose actual ZIP verifies end to end against the commit', async () => {
  const result = await verifyHandoffPackage({ zip: built.zipPath, commit: 'HEAD', repoRoot: path.resolve('.'), keep: false });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.sourceVerified, true);
  assert.equal(result.secretScanned, true);
  assert.equal(result.zipSha256, built.zipSha256);
  assert.equal(fs.readFileSync(`${built.zipPath}.sha256`, 'utf8').split(/\s+/)[0], built.zipSha256);
});

test('uses portable forward-slash entry names under a single prefix and no directory entries', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(built.zipPath));
  const names = Object.keys(zip.files);
  assert.ok(names.length > 1000);
  assert.ok(names.every((name) => !name.includes('\\') && !name.startsWith('/') && !name.includes('..')));
  assert.equal(new Set(names.map((name) => name.split('/')[0])).size, 1);
  assert.ok(names.every((name) => !zip.files[name].dir));
  assert.ok(names.includes(`${built.manifest.package}/${START_HERE_NAME}`));
  assert.ok(names.includes(`${built.manifest.package}/${MANIFEST_NAME}`));
  assert.ok(names.includes(`${built.manifest.package}/${SOURCE_DIRECTORY}/package.json`));
});

test('manifest covers every regular file except itself and documents that exclusion', () => {
  const listed = new Set(built.manifest.files.map((entry) => entry.path));
  assert.equal(listed.has(MANIFEST_NAME), false);
  assert.equal(listed.has(START_HERE_NAME), true);
  assert.equal(built.manifest.fileCount, built.manifest.files.length);
  assert.match(built.manifest.excludes, /except itself/);
  assert.equal(built.manifest.commit.length, 40);
  assert.equal(built.manifest.status, 'candidate');
  assert.match(built.manifest.label, /NOT YET MERGED OR DEPLOYED/);
});

test('START-HERE states the authoritative source, the candidate boundary and no demo-state claims', async () => {
  const failures = [];
  const { packageRoot, extractRoot } = await inspectAndExtractZip(built.zipPath, failures);
  try {
    assert.deepEqual(failures, []);
    const startHere = fs.readFileSync(path.join(packageRoot, START_HERE_NAME), 'utf8');
    assert.match(startHere, /repository source snapshot in `source\/` is authoritative/);
    assert.match(startHere, /CANDIDATE — LOCAL VERIFICATION; NOT YET MERGED OR DEPLOYED/);
    assert.match(startHere, /https:\/\/github\.com\/acmis1\/capstone-impact-platform/);
    assert.match(startHere, new RegExp(built.manifest.commit));
    assert.match(startHere, /9690ee0faa37fda502a15b4403f1e293f79b519f/);
    assert.doesNotMatch(startHere, /three Draft projects/i);
    assert.doesNotMatch(startHere, /HANDOFF-DEMO-UNUSED/);
    // Candidate wording: not merged/deployed, and the rollout procedure is linked, not restated.
    assert.match(startHere, /has not been merged or deployed/);
    assert.match(startHere, /source\/docs\/operations\/release-rollout-runbook\.md/);
    assert.doesNotMatch(startHere, /confirm heartbeat\s+compatibility/);
    for (const target of markdownLinkTargets(startHere)) {
      assert.ok(fs.existsSync(path.join(packageRoot, ...target.split('/'))), `link target exists: ${target}`);
    }
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
});

test('rejects tampered, missing and extra files in an extracted package', async () => {
  const failures = [];
  const { packageRoot, extractRoot } = await inspectAndExtractZip(built.zipPath, failures);
  try {
    const target = path.join(packageRoot, SOURCE_DIRECTORY, 'README.md');
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n<!-- tampered -->\n')]));
    let result = await verifyPackageDirectory(packageRoot, { commit: built.manifest.commit, repoRoot: path.resolve('.') });
    assert.ok(result.failures.some((failure) => failure.startsWith(`size mismatch: ${SOURCE_DIRECTORY}/README.md`)), result.failures.join('\n'));
    assert.ok(result.failures.some((failure) => failure.startsWith(`source file differs from commit: ${SOURCE_DIRECTORY}/README.md`)));

    fs.writeFileSync(target, Buffer.from(original).fill(0x41, 0, 1));
    result = await verifyPackageDirectory(packageRoot, { commit: built.manifest.commit, repoRoot: path.resolve('.') });
    assert.ok(result.failures.some((failure) => failure === `hash mismatch: ${SOURCE_DIRECTORY}/README.md`), result.failures.join('\n'));
    fs.writeFileSync(target, original);

    fs.rmSync(path.join(packageRoot, SOURCE_DIRECTORY, 'package.json'));
    result = await verifyPackageDirectory(packageRoot, { commit: built.manifest.commit, repoRoot: path.resolve('.') });
    assert.ok(result.failures.includes(`manifested file missing: ${SOURCE_DIRECTORY}/package.json`));
    assert.ok(result.failures.includes(`tracked file missing from source snapshot: ${SOURCE_DIRECTORY}/package.json`));

    fs.writeFileSync(path.join(packageRoot, 'EXTRA.txt'), 'not in the manifest');
    result = await verifyPackageDirectory(packageRoot, { commit: built.manifest.commit, repoRoot: path.resolve('.') });
    assert.ok(result.failures.includes('unmanifested file: EXTRA.txt'));

    fs.writeFileSync(path.join(packageRoot, '.env'), 'SUPABASE_SECRET_KEY=placeholder');
    result = await verifyPackageDirectory(packageRoot, { commit: built.manifest.commit, repoRoot: path.resolve('.') });
    assert.ok(result.failures.includes('forbidden file present: .env'));
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
});

test('rejects a ZIP whose bytes were altered after the checksum was recorded', async () => {
  const altered = path.join(tempRoot, 'altered.zip');
  const bytes = fs.readFileSync(built.zipPath);
  // Flip one byte inside the compressed data; CRC verification and the outer checksum both catch it.
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(altered, bytes);
  fs.copyFileSync(`${built.zipPath}.sha256`, `${altered}.sha256`);
  const result = await verifyHandoffPackage({ zip: altered, commit: built.manifest.commit, repoRoot: path.resolve('.'), keep: false })
    .catch((error) => ({ ok: false, failures: [error.message] }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
});

test('refuses evidence that matches a secret pattern or a forbidden name', async () => {
  const evidence = path.join(tempRoot, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'receipt.json'), `{"token":"${['ghp_', 'b'.repeat(36)].join('')}"}`);
  await assert.rejects(
    buildHandoffPackage(parseBuildArguments(['--out', path.join(tempRoot, 'out2'), '--evidence', evidence])),
    /secret pattern/,
  );
  fs.rmSync(path.join(evidence, 'receipt.json'));
  fs.writeFileSync(path.join(evidence, '.env.local'), 'X=1');
  await assert.rejects(
    buildHandoffPackage(parseBuildArguments(['--out', path.join(tempRoot, 'out2'), '--evidence', evidence])),
    /forbidden/,
  );
});

test('includes sanitized evidence under evidence/ and lists it in START-HERE', async () => {
  const evidence = path.join(tempRoot, 'evidence-ok');
  fs.mkdirSync(path.join(evidence, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(evidence, 'nested', 'receipt.json'), '{"ok":true}\n');
  assert.throws(
    () => parseBuildArguments(['--out', path.join(tempRoot, 'out3'), '--evidence', evidence, '--status', 'released']),
    /released requires --deployed-backend and --worker-image/,
  );
  assert.throws(() => parseBuildArguments(['--out', path.join(tempRoot, 'out3'), '--deployed-backend', 'abc']), /full lowercase 40-hex commit/);
  const runtime = '9690ee0faa37fda502a15b4403f1e293f79b519f';
  const result = await buildHandoffPackage(parseBuildArguments([
    '--out', path.join(tempRoot, 'out3'), '--evidence', evidence, '--status', 'released',
    '--deployed-backend', runtime, '--worker-image', `capstone-assistive-worker:${runtime} (image id sha256:${'6'.repeat(64)})`,
  ]));
  assert.ok(result.manifest.files.some((entry) => entry.path === 'evidence/nested/receipt.json'));
  assert.match(result.manifest.label, /RELEASED/);
  const verified = await verifyHandoffPackage({ zip: result.zipPath, commit: 'HEAD', repoRoot: path.resolve('.'), keep: false });
  assert.deepEqual(verified.failures, []);
});

test('a released package states the composite identity and never asks the recipient to merge or deploy it', async () => {
  const runtime = '9690ee0faa37fda502a15b4403f1e293f79b519f';
  const result = await buildHandoffPackage(parseBuildArguments([
    '--out', path.join(tempRoot, 'out4'), '--status', 'released', '--deployed-backend', runtime,
    '--worker-image', `capstone-assistive-worker:${runtime}`, '--public-layer', runtime,
  ]));
  const failures = [];
  const { packageRoot, extractRoot } = await inspectAndExtractZip(result.zipPath, failures);
  try {
    assert.deepEqual(failures, []);
    const startHere = fs.readFileSync(path.join(packageRoot, START_HERE_NAME), 'utf8');
    assert.match(startHere, /RELEASED — built from the accepted, merged commit/);
    assert.match(startHere, new RegExp(`deployed runtime commit is \`${runtime}\``));
    assert.match(startHere, new RegExp(`source commit of this package is\\s+\`${result.manifest.commit}\``));
    assert.match(startHere, /Do not redeploy the source\s+commit merely to make the identifiers equal/);
    assert.match(startHere, /source\/docs\/operations\/release-rollout-runbook\.md/);
    assert.doesNotMatch(startHere, /NOT YET MERGED/);
    assert.doesNotMatch(startHere, /has not been merged or deployed/);
    assert.doesNotMatch(startHere, /then merge to `main`/);
    assert.doesNotMatch(startHere, /Rebuild the worker image from the merged commit/);
    for (const target of markdownLinkTargets(startHere)) {
      assert.ok(fs.existsSync(path.join(packageRoot, ...target.split('/'))), `link target exists: ${target}`);
    }
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
});

test('raw inventory reader exposes original names and rejects unsupported structures', () => {
  const bytes = fs.readFileSync(built.zipPath);
  const inventory = readRawZipInventory(bytes);
  assert.equal(inventory.totalEntries, built.manifest.files.length + 1);
  assert.ok(inventory.entries.every((entry) => !entry.isDirectory && !entry.isSymlink && (entry.method === 0 || entry.method === 8)));
  const zip64 = Buffer.from(bytes);
  zip64.writeUInt16LE(0xffff, findEndOfCentralDirectory(zip64) + 10);
  assert.throws(() => readRawZipInventory(zip64), UnsupportedZipError);
  assert.throws(() => readRawZipInventory(Buffer.concat([bytes, Buffer.from('trailing garbage')])), UnsupportedZipError);
  const mismatched = Buffer.from(bytes);
  const localName = `${built.manifest.package}/${START_HERE_NAME}`;
  const localIndex = mismatched.indexOf(Buffer.from(localName)); // first occurrence is the local header (data precedes the central directory)
  assert.equal(mismatched.readUInt32LE(localIndex - 30), 0x04034b50);
  mismatched.write('X', localIndex);
  assert.throws(() => readRawZipInventory(mismatched), /local header name differs/);
});

test('rejects a raw traversal alias before extraction even though the bytes are otherwise valid', async () => {
  const bytes = await resaveWithEntryName(fs.readFileSync(built.zipPath), `/${START_HERE_NAME}`, (name) => name.replace(`/${START_HERE_NAME}`, `/extra/../${START_HERE_NAME}`));
  assert.ok(readRawZipInventory(bytes).entries.some((entry) => entry.name.includes('/extra/../')), 'fixture keeps the raw traversal name');
  const result = await verifyBytes('raw-traversal-alias', bytes, built.manifest.commit);
  assert.equal(result.ok, false);
  assert.equal(result.extracted, false);
  assert.ok(result.failures.some((failure) => failure.includes('parent traversal')), result.failures.join('\n'));
});

test('rejects a raw duplicate central-directory entry before extraction', async () => {
  const bytes = duplicateFirstCentralEntry(fs.readFileSync(built.zipPath));
  const result = await verifyBytes('raw-duplicate-entry', bytes, built.manifest.commit);
  assert.equal(result.ok, false);
  assert.equal(result.extracted, false);
  assert.ok(result.failures.some((failure) => failure.endsWith('duplicate entry')), result.failures.join('\n'));
});

test('rejects raw backslash and absolute entry names patched into the headers', async () => {
  const original = fs.readFileSync(built.zipPath);
  const name = `${built.manifest.package}/${START_HERE_NAME}`;
  const backslash = renameEntryInPlace(original, name, name.replace('/', '\\'));
  let result = await verifyBytes('raw-backslash', backslash, built.manifest.commit);
  assert.equal(result.extracted, false);
  assert.ok(result.failures.some((failure) => failure.includes('backslash separator')), result.failures.join('\n'));
  const absolute = renameEntryInPlace(original, name, `/${name.replace('/', '')}`);
  result = await verifyBytes('raw-absolute', absolute, built.manifest.commit);
  assert.equal(result.extracted, false);
  assert.ok(result.failures.some((failure) => failure.includes('absolute path')), result.failures.join('\n'));
});

test('rejects entries whose normalized extraction targets collide', async () => {
  const bytes = await resaveWithEntryName(fs.readFileSync(built.zipPath), `/${START_HERE_NAME}`, (name) => name.replace(`/${START_HERE_NAME}`, `/alias/../${START_HERE_NAME}`), Buffer.from('shadow'));
  const result = await verifyBytes('raw-collision', bytes, built.manifest.commit);
  assert.equal(result.extracted, false);
  assert.ok(result.failures.some((failure) => failure.includes('collides with') || failure.includes('parent traversal')), result.failures.join('\n'));
});

test('rejects a directory entry as outside the generated format', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(built.zipPath));
  zip.folder(`${built.manifest.package}/evidence-dir`);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
  const result = await verifyBytes('raw-directory', bytes, built.manifest.commit);
  assert.equal(result.extracted, false);
  assert.ok(result.failures.some((failure) => failure.includes('directory entries are not part')), result.failures.join('\n'));
});

test('leaves no temporary extraction directory behind for rejected or valid archives', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('pp1-handoff-verify-')).length;
  await verifyBytes('raw-duplicate-entry-cleanup', duplicateFirstCentralEntry(fs.readFileSync(built.zipPath)), built.manifest.commit);
  await verifyHandoffPackage({ zip: built.zipPath, commit: built.manifest.commit, repoRoot: path.resolve('.'), keep: false });
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('pp1-handoff-verify-')).length;
  assert.equal(after, before);
});

test('manifest structure validation rejects duplicate or malformed entries', () => {
  const valid = structuredClone(built.manifest);
  assert.deepEqual(validateManifestStructure(valid), []);
  const duplicated = structuredClone(built.manifest);
  duplicated.files.push({ ...duplicated.files[0] });
  duplicated.fileCount += 1;
  assert.ok(validateManifestStructure(duplicated).some((problem) => problem.includes('duplicate entry')));
  const malformed = structuredClone(built.manifest);
  malformed.files[0] = { path: '../escape', size: -1, sha256: 'nope' };
  const problems = validateManifestStructure(malformed);
  assert.ok(problems.some((problem) => problem.includes('parent traversal')));
  assert.ok(problems.some((problem) => problem.includes('size')));
  assert.ok(problems.some((problem) => problem.includes('sha256')));
  const self = structuredClone(built.manifest);
  self.files.push({ path: MANIFEST_NAME, size: 1, sha256: 'a'.repeat(64) });
  self.fileCount += 1;
  assert.ok(validateManifestStructure(self).includes('manifest must not list itself'));
});

test('entry-name and forbidden-path rules reject unsafe names', () => {
  const seen = new Set();
  assert.deepEqual(validateEntryName('pkg/source/README.md', seen), []);
  assert.deepEqual(validateEntryName('pkg/source/README.md', seen), ['duplicate entry']);
  assert.ok(validateEntryName('pkg\\source\\README.md').includes('backslash separator'));
  assert.ok(validateEntryName('/etc/passwd').includes('absolute path'));
  assert.ok(validateEntryName('C:/Windows/system32').includes('absolute path'));
  assert.ok(validateEntryName('pkg/../escape').includes('parent traversal'));
  assert.equal(isForbiddenPath('apps/admin-cms/.env.local'), true);
  assert.equal(isForbiddenPath('apps/admin-cms/.env.example'), false);
  assert.equal(isForbiddenPath('apps/admin-cms/.local-users.json'), true);
  assert.equal(isForbiddenPath('node_modules/x/index.js'), true);
  assert.equal(isForbiddenPath('.git/config'), true);
  assert.equal(isForbiddenPath('docs/README.md'), false);
});
