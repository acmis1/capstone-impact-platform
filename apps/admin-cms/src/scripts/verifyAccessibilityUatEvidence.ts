import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const EVIDENCE_ROOT = 'docs/accessibility-uat-evidence';
const TEXT_EXTENSIONS = new Set(['.md', '.json', '.html', '.log', '.txt']);
export interface Finding { category: string; filename: string; line?: number }
export interface Screenshot { filename: string; width: number; height: number; bytes: number; sha256: string }

export function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  // PowerShell logs can also be UTF-16LE without a BOM.
  if (bytes.subarray(0, 200).some((byte, index) => index % 2 === 1 && byte === 0)) return bytes.toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

const PATTERNS: Array<[string, RegExp]> = [
  ['participant-preview-token-path', /(?:https?:\/\/[^/\s"'<>]+|(?<![a-z0-9_./-]))\/participant-preview\/(?!(?:correction-resolution|reminders|request-correction)\b)[a-z0-9_-]{8,}/i],
  ['signed-url', /(?:[?&]|&amp;)(?:token|signature|sig|x-amz-signature|x-amz-credential|x-goog-signature|access_token|refresh_token)=[^\s"'<>\[&]+/i],
  ['signed-storage-path', /\/storage\/v1\/object\/sign\//i],
  ['jwt-credential', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
  ['authorization-data', /\b(?:bearer\s+[a-z0-9_.=-]{8,}|authorization["']?\s*[:=]\s*["']?(?!\[|null\b)[a-z0-9][^\s"']+)/i],
  ['cookie-session-data', /\b(?:set-cookie|cookie|session|session_id|access_token|refresh_token)["']?\s*[:=]\s*["']?(?!\[|null\b|false\b|true\b)[a-z0-9][^\s"']+/i],
  ['credential-assignment', /\b(?:password|service_role_key|secret_key|api_key)["']?\s*[:=]\s*["']?(?!\[|null\b)[a-z0-9][^\s"']+/i],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['forbidden-identifier', /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i],
];

export function scanText(filename: string, bytes: Buffer, knownSecrets: string[] = []): Finding[] {
  const findings: Finding[] = [];
  decodeText(bytes).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\\\//g, '/').replace(/\\u002f/gi, '/')
      .replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    for (const [category, pattern] of PATTERNS) {
      if (pattern.test(line)) findings.push({ category, filename, line: index + 1 });
    }
    if (knownSecrets.some(secret => secret.length >= 8 && (line.includes(secret) || raw.includes(JSON.stringify(secret).slice(1, -1))))) {
      findings.push({ category: 'known-local-credential', filename, line: index + 1 });
    }
  });
  return findings;
}

export function screenshotManifest(files: Map<string, Buffer>) {
  const screenshots: Screenshot[] = [];
  for (const [filename, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!filename.endsWith('.png')) continue;
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('invalid-png');
    }
    screenshots.push({ filename, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const hashes = new Map<string, string[]>();
  for (const item of screenshots) hashes.set(item.sha256, [...(hashes.get(item.sha256) ?? []), item.filename]);
  return { version: 1, screenshots, duplicates: [...hashes].filter(([, names]) => names.length > 1).map(([sha256, filenames]) => ({ sha256, filenames })) };
}

export function inspectEvidence(files: Map<string, Buffer>, knownSecrets: string[] = []) {
  const findings: Finding[] = [];
  let textFilesScanned = 0;
  for (const [filename, bytes] of files) {
    if (TEXT_EXTENSIONS.has(path.extname(filename))) {
      findings.push(...scanText(filename, bytes, knownSecrets));
      textFilesScanned++;
    }
    if (/\/lighthouse[^/]*\.json$/.test(filename)) {
      try {
        const report = JSON.parse(decodeText(bytes));
        if (typeof report.categories?.accessibility?.score !== 'number') findings.push({ category: 'lighthouse-accessibility-missing', filename });
      } catch { findings.push({ category: 'lighthouse-json-invalid', filename }); }
    }
    if (filename.endsWith('.png')) {
      try { screenshotManifest(new Map([[filename, bytes]])); }
      catch { findings.push({ category: 'invalid-png', filename }); }
    }
    if (!filename.endsWith('.md')) continue;
    const markdown = decodeText(bytes);
    // Evidence links must be local paths, relative to their Markdown document.
    for (const match of markdown.matchAll(/\]\(([^)]+)\)|`([^`\n]+\.(?:png|json|html|log|txt))`/g)) {
      const ref = (match[1] ?? match[2]).replace(/^<|>$/g, '').split('#')[0];
      if (!ref || /^[a-z]+:|^#/.test(ref)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), ref));
      if (!files.has(target) && !files.has(ref) && (target.startsWith(EVIDENCE_ROOT + '/') || ref.startsWith(EVIDENCE_ROOT + '/'))) {
        findings.push({ category: 'missing-evidence-reference', filename, line: markdown.slice(0, match.index).split('\n').length });
      }
    }
  }
  return { textFilesScanned, findings };
}

function readFiles(repoRoot: string, committed: boolean): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  if (committed) {
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', EVIDENCE_ROOT, 'ACCESSIBILITY_UAT_CHECKLIST.md'], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const name of names) result.set(name, execFileSync('git', ['show', `HEAD:${name}`], { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 }));
  } else {
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
        const name = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error('evidence-symlink');
        if (entry.isDirectory()) walk(name);
        else result.set(name, fs.readFileSync(path.join(repoRoot, name)));
      }
    };
    walk(EVIDENCE_ROOT);
    result.set('ACCESSIBILITY_UAT_CHECKLIST.md', fs.readFileSync(path.join(repoRoot, 'ACCESSIBILITY_UAT_CHECKLIST.md')));
  }
  return result;
}

export function runEvidenceVerification(args = process.argv.slice(2), repoRoot = path.resolve(__dirname, '../../../../')): number {
  try {
    if (args.some(arg => !['--manifest', '--committed'].includes(arg))) throw new Error('unsupported-option');
    const files = readFiles(repoRoot, args.includes('--committed'));
    if (args.includes('--manifest')) {
      console.log(JSON.stringify(screenshotManifest(files), null, 2));
      return 0;
    }
    // Optional ignored synthetic credential store; never print its contents.
    const credentialPath = path.join(repoRoot, 'apps/admin-cms/.local-users.json');
    const knownSecrets = fs.existsSync(credentialPath)
      ? Object.values(JSON.parse(fs.readFileSync(credentialPath, 'utf8')).users ?? {}).filter((value): value is string => typeof value === 'string') : [];
    const result = inspectEvidence(files, knownSecrets);
    const manifest = screenshotManifest(files);
    const manifestFile = `${EVIDENCE_ROOT}/2026-09-03/screenshots-manifest.json`;
    try {
      const stored = JSON.parse(decodeText(files.get(manifestFile) ?? Buffer.alloc(0)));
      if (JSON.stringify(stored) !== JSON.stringify(manifest)) result.findings.push({ category: 'screenshot-manifest-stale', filename: manifestFile });
    } catch { result.findings.push({ category: 'screenshot-manifest-invalid', filename: manifestFile }); }
    console.log(JSON.stringify({ mode: args.includes('--committed') ? 'HEAD' : 'working-tree', filesScanned: files.size, ...result, screenshotCount: manifest.screenshots.length, uniqueHashCount: new Set(manifest.screenshots.map(item => item.sha256)).size, duplicateGroups: manifest.duplicates, result: result.findings.length ? 'FAIL' : 'PASS' }, null, 2));
    return result.findings.length ? 1 : 0;
  } catch {
    // Parsing/filesystem exceptions can contain source text: report a fixed message.
    console.error('Evidence verification failed: unreadable or invalid input. No source values displayed.');
    return 1;
  }
}

if (require.main === module) process.exitCode = runEvidenceVerification();
