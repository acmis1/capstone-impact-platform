import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildHandoffPackage, parseArguments as parseBuildArguments } from './build-handoff-package.mjs';
import { MANIFEST_NAME, START_HERE_NAME, SOURCE_DIRECTORY, isForbiddenPath, markdownLinkTargets, validateEntryName } from './package-contract.mjs';
import { inspectAndExtractZip, verifyHandoffPackage, verifyPackageDirectory } from './verify-handoff-package.mjs';

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
  const result = await buildHandoffPackage(parseBuildArguments(['--out', path.join(tempRoot, 'out3'), '--evidence', evidence, '--status', 'released']));
  assert.ok(result.manifest.files.some((entry) => entry.path === 'evidence/nested/receipt.json'));
  assert.match(result.manifest.label, /RELEASED/);
  const verified = await verifyHandoffPackage({ zip: result.zipPath, commit: 'HEAD', repoRoot: path.resolve('.'), keep: false });
  assert.deepEqual(verified.failures, []);
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
